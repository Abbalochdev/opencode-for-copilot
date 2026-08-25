import { randomUUID } from 'crypto';
import type { CancellationToken } from 'vscode';
import { safeStringify } from '../json';
import { logger } from '../logger';
import type {
    ApiProtocol,
    GLMRequest,
    GLMStreamChunk,
    GLMToolCall,
    GLMUsage,
    StreamCallbacks,
} from '../types';
import { convertToAnthropicRequest, parseAnthropicStream } from './anthropic';
import { createHttpError, formatRequestError, GLMRequestError, normalizeRequestError } from './error';
import { analyzeContextOverflow } from './error/overflow-retry';
import { trackRateLimitHeaders, waitIfRateLimited } from './rate-limit';

// Retry configuration for transient HTTP errors (429, 502, 503, 504).
const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

/** HTTP status codes eligible for retry with backoff. */
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

/** Whether an HTTP error is transient and worth a backoff retry. */
function isRetryableHttpError(error: GLMRequestError): boolean {
	const status = error.status ?? 0;
	if (RETRYABLE_STATUSES.has(status)) {
		return true;
	}
	// Other 5xx are retryable only when the gateway explicitly reports the
	// transient `RouterUnavailable` failure (opencode gateway).
	return (
		status >= 500
		&& /routerunavailable/i.test(stripWhitespace(error.serverMessage ?? error.message))
	);
}

function stripWhitespace(text: string): string {
	return text.replace(/\s+/gu, '').toLowerCase();
}

// ---- Sticky gateway headers ----
// OpenCode gateway uses these for session affinity and request tracing.
// Only sent to opencode.ai hosts to avoid leaking metadata to custom endpoints.
const OPENCODE_SESSION_ID = randomUUID();
let opencodeRequestCounter = 0;

function getOpenCodeGatewayHeaders(): Record<string, string> {
	return {
		'x-opencode-session': OPENCODE_SESSION_ID,
		'x-opencode-request': `${OPENCODE_SESSION_ID}-${++opencodeRequestCounter}`,
		'x-opencode-client': 'opencode-for-copilot',
	};
}

function isOpencodeGateway(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname === 'opencode.ai';
	} catch {
		return false;
	}
}

/**
 * Lightweight SSE-streaming GLM API client.
 * No external dependencies — uses Node's built-in fetch.
 *
 * Supports both OpenAI-compatible (`/chat/completions`) and
 * Anthropic-compatible (`/v1/messages`) protocols.
 */
export class GLMClient {
	constructor(
		private readonly baseUrl: string,
		private readonly apiKey: string,
		private readonly protocol: ApiProtocol = 'openai',
	) {}

	/**
	 * Stream a chat completion from the GLM API.
	 * Parses SSE chunks and dispatches callbacks for content, thinking, and tool calls.
	 *
	 * Retry strategy:
	 *   1. Exponential backoff for transient HTTP errors (429, 502, 503, 504 —
	 *      plus other 5xx reporting `RouterUnavailable`), respecting Retry-After
	 *      headers. Up to MAX_RETRY_ATTEMPTS.
	 *   2. Reactive retry for HTTP 500 with >8 tools: halves the tool list
	 *      (mirrors Claude Code's `hasAttemptedReactiveCompact` pattern).
	 *   3. Context-overflow retry: HTTP 400 with authoritative token counts is
	 *      retried once with a reduced max_tokens.
	 */
	async streamChatCompletion(
		request: GLMRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const dispatch = (req: GLMRequest) =>
			this.protocol === 'anthropic'
				? this.streamAnthropicCompletion(req, callbacks, cancellationToken)
				: this.streamOpenAIChatCompletion(req, callbacks, cancellationToken);

		// Phase 1: retry with backoff for transient rate-limit / availability errors.
		let lastError: unknown;
		for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
			try {
				await dispatch(request);
				return; // success
			} catch (error) {
				if (isAbortError(error) && cancellationToken?.isCancellationRequested) {
					return;
				}
				lastError = error;
				if (error instanceof GLMRequestError && isRetryableHttpError(error)) {
					const delay = computeRetryDelay(error, attempt);
					logger.warn(
						`Retryable HTTP ${error.status} (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS}), retrying in ${delay}ms`,
					);
					await sleep(delay);
					if (cancellationToken?.isCancellationRequested) {
						return;
					}
					continue;
				}
				// Not a retryable status — break out to phase 2 (tool halving).
				break;
			}
		}

		// Phase 2: reactive tool-halving retry.
		// Triggers on HTTP 500 (any tool count >8), or 429 server-overload with
		// a large tool list (provider can't handle the payload, not a quota issue).
		const error = lastError;
		const toolCount = request.tools?.length ?? 0;
		const shouldHalveTools =
			error instanceof GLMRequestError
			&& (error.status === 500 || (error.status === 429 && toolCount > 16))
			&& toolCount > 8;

		if (shouldHalveTools) {
			const halvedTools = request.tools!.slice(0, Math.ceil(toolCount / 2));
			logger.warn(
				`Reactive retry: HTTP ${error.status} with ${toolCount} tools, retrying with ${halvedTools.length} tools`,
			);
			const retriedRequest = { ...request, tools: halvedTools };
			try {
				await dispatch(retriedRequest);
				return; // success with fewer tools
			} catch {
				logger.warn('Reactive tool-halving retry also failed, continuing to failover');
			}
			// Fall through to failover — don't swallow the error here.
		}

		// Phase 2.5: context-overflow retry — HTTP 400 whose message carries
		// authoritative token counts; retry once with a reduced output budget.
		if (error instanceof GLMRequestError && error.status === 400) {
			const overflow = analyzeContextOverflow(
				error.serverMessage ?? error.message,
				request.max_tokens ?? 0,
			);
			if (overflow) {
				logger.warn(
					`[overflow-retry] context ${overflow.contextWindow} tokens, requested `
					+ `${overflow.requestedTokens}; retrying with max_tokens ${overflow.maxTokens} `
					+ `(was ${request.max_tokens ?? 0})`,
				);
				try {
					await dispatch({ ...request, max_tokens: overflow.maxTokens });
					return; // success with reduced output budget
				} catch {
					logger.warn('[overflow-retry] retry also failed, continuing to failover');
				}
				// Fall through to failover — don't swallow the error here.
			}
		}

		// Phase 3: report the failure.
		const normalizedError = normalizeRequestError(
			shouldHalveTools ? error! : error,
			{ baseUrl: this.baseUrl, request },
		);
		logger.error('GLM request failed:', formatRequestError(normalizedError));

		callbacks.onError(normalizedError);
	}

	/**
	 * Stream using OpenAI-compatible `/chat/completions` endpoint.
	 */
	private async streamOpenAIChatCompletion(
		request: GLMRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const controller = new AbortController();
		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});
		if (cancellationToken?.isCancellationRequested) {
			cancelListener?.dispose();
			controller.abort();
			return;
		}

		// Captured per-request so the `finally` can release the stream lock even
		// on the early `return` paths (cancellation / `[DONE]` sentinel).
		let releaseReader: (() => Promise<void>) | undefined;

		try {
			await waitIfRateLimited(this.baseUrl);
			const response = await fetch(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${this.apiKey}`,
					...(isOpencodeGateway(this.baseUrl) ? getOpenCodeGatewayHeaders() : {}),
				},
				body: safeStringify(request),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw await createHttpError(response, {
					baseUrl: this.baseUrl,
					request,
				});
			}

			trackRateLimitHeaders(this.baseUrl, response.headers);

			if (!response.body) {
				throw new Error('No response body received');
			}

			const reader = response.body.getReader();
			releaseReader = async (): Promise<void> => {
				try {
					await reader.cancel();
				} catch {
					// already closed/cancelled
				}
			};
			const decoder = new TextDecoder();
			let buffer = '';
			let latestUsage: GLMUsage | undefined;

			// Accumulate tool call deltas by index, then emit on finish_reason=stop/tool_calls
			const pendingToolCalls = new Map<number, GLMToolCall>();

			// Process a single SSE line. Returns true once the terminal `data: [DONE]`
			// sentinel has been fully handled so the caller can stop reading.
			const processLine = (line: string): boolean => {
				const trimmed = line.trim();

				if (!trimmed || trimmed.startsWith(':')) {
					return false;
				}

				if (trimmed === 'data: [DONE]') {
					// Flush any remaining tool calls
					for (const tc of pendingToolCalls.values()) {
						callbacks.onToolCall(tc);
					}
					pendingToolCalls.clear();
					reportFinalUsage(callbacks, latestUsage);
					callbacks.onDone();
					return true;
				}

				if (!trimmed.startsWith('data: ')) {
					return false;
				}

				const jsonStr = trimmed.slice(6);
				try {
					const chunk: GLMStreamChunk = JSON.parse(jsonStr);
					const choice = chunk.choices?.[0];

					if (chunk.usage) {
						latestUsage = chunk.usage;
					}

					if (!choice) {
						return false;
					}

					const reasoning = choice.delta.reasoning_content;
					if (reasoning) {
						callbacks.onThinking(reasoning);
					}

					if (choice.delta.content) {
						callbacks.onContent(choice.delta.content);
					}

					if (choice.delta.tool_calls) {
						for (const tc of choice.delta.tool_calls) {
							// Create the pending entry as soon as we see the index. Some
							// OpenAI-compatible gateways emit the first delta without an `id`
							// (e.g. sending `function.name` first); requiring `id` up front
							// would silently drop the entire tool call for those servers.
							let pending = pendingToolCalls.get(tc.index);
							if (!pending) {
								pending = {
									id: tc.id ?? '',
									type: 'function',
									function: { name: '', arguments: '' },
								};
								pendingToolCalls.set(tc.index, pending);
							}
							if (tc.id && !pending.id) {
								pending.id = tc.id;
							}
							if (tc.function?.name) {
								pending.function.name += tc.function.name;
							}
							if (tc.function?.arguments) {
								pending.function.arguments += tc.function.arguments;
							}
						}
					}

					if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
						for (const tc of pendingToolCalls.values()) {
							callbacks.onToolCall(tc);
						}
						pendingToolCalls.clear();
					}
				} catch (e) {
					logger.error('Failed to parse SSE chunk:', jsonStr.slice(0, 200), e);
				}
				return false;
			};

			while (true) {
				if (cancellationToken?.isCancellationRequested) {
					controller.abort();
					return;
				}

				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });

				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					if (processLine(line)) {
						return;
					}
				}
			}

			// Flush the TextDecoder (it may hold a partial multi-byte sequence) and
			// process any trailing line that lacked a terminating newline. Without this
			// a final `data:` frame (e.g. usage or the last tool-call delta) can be
			// dropped when the server omits the trailing `\n`, which is common behind
			// proxies/CDNs.
			buffer += decoder.decode();
			if (buffer.length > 0) {
				for (const line of buffer.split('\n')) {
					if (processLine(line)) {
						return;
					}
				}
				buffer = '';
			}

			// The stream ended without a `[DONE]` sentinel (e.g. upstream closed
			// early, `finish_reason: "length"`, or a non-spec gateway). Emit any tool
			// calls still accumulated so agent flows don't silently stall.
			for (const tc of pendingToolCalls.values()) {
				callbacks.onToolCall(tc);
			}
			pendingToolCalls.clear();
			reportFinalUsage(callbacks, latestUsage);
			callbacks.onDone();
		} finally {
			// Release the response stream lock on every exit path (`[DONE]`
			// early-return, cancellation, normal completion and errors). On the
			// normal/done paths cancel() is a harmless no-op; on early returns it
			// promptly tears down the connection instead of waiting for GC.
			await releaseReader?.();
			cancelListener?.dispose();
			// Abort the controller on every exit path so the signal is torn down
			// and doesn't hold references to listeners/connections.
			controller.abort();
		}
	}

	/**
	 * Stream using Anthropic-compatible `/v1/messages` endpoint.
	 */
	private async streamAnthropicCompletion(
		request: GLMRequest,
		callbacks: StreamCallbacks,
		cancellationToken?: CancellationToken,
	): Promise<void> {
		const controller = new AbortController();
		const cancelListener = cancellationToken?.onCancellationRequested(() => {
			controller.abort();
		});
		if (cancellationToken?.isCancellationRequested) {
			cancelListener?.dispose();
			controller.abort();
			return;
		}

		try {
			const anthropicRequest = convertToAnthropicRequest(request);

			await waitIfRateLimited(this.baseUrl);
			const response = await fetch(`${this.baseUrl}/v1/messages`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': this.apiKey,
					'anthropic-version': '2023-06-01',
					...(isOpencodeGateway(this.baseUrl) ? getOpenCodeGatewayHeaders() : {}),
				},
				body: safeStringify(anthropicRequest),
				signal: controller.signal,
			});

			if (!response.ok) {
				throw await createHttpError(response, {
					baseUrl: this.baseUrl,
					request,
				});
			}

			trackRateLimitHeaders(this.baseUrl, response.headers);

			if (!response.body) {
				throw new Error('No response body received');
			}

			// Take ownership of the reader lifecycle so the stream lock is released if
			// parsing throws (e.g. a callback rejects) or the request is aborted;
			// otherwise the underlying connection lingers until GC.
			const reader = response.body.getReader();
			try {
				await parseAnthropicStream(reader, callbacks);
			} finally {
				await reader.cancel().catch((err) => {
					// Log non-AbortError failures — a corrupt reader state may
					// otherwise be silently discarded, masking stream teardown issues.
					if (!isAbortError(err)) {
						logger.warn('Error cancelling Anthropic stream reader:', err);
					}
				});
			}
		} finally {
			cancelListener?.dispose();
			controller.abort();
		}
	}
}

function reportFinalUsage(callbacks: StreamCallbacks, usage: GLMUsage | undefined): void {
	if (!usage || !callbacks.onUsage) {
		return;
	}
	callbacks.onUsage(usage);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === 'AbortError';
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute retry delay with exponential backoff + jitter.
 * Respects Retry-After header (in seconds) from 429 responses.
 * lazy: cap at MAX_RETRY_DELAY_MS to prevent runaway backoff.
 */
function computeRetryDelay(error: GLMRequestError, attempt: number): number {
	// Respect Retry-After header if present (common for 429).
	if (error.retryAfterMs) {
		return Math.min(error.retryAfterMs, MAX_RETRY_DELAY_MS);
	}
	const exponential = BASE_RETRY_DELAY_MS * 2 ** attempt;
	const jitter = Math.random() * BASE_RETRY_DELAY_MS;
	return Math.min(exponential + jitter, MAX_RETRY_DELAY_MS);
}
