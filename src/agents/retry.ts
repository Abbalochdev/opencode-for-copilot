import type * as vscode from 'vscode';

/**
 * Retry helper for agent `sendRequest` calls.
 *
 * The swarm's sub-agents hit provider rate limits (429), transient server
 * errors (5xx), and network blips. Without retry, a single 429 silently kills
 * a research area or the implementer. This wraps every `sendRequest` so
 * retriable failures back off and recover instead of propagating.
 *
 * Self-contained: classifies by error message because the raw `sendRequest`
 * throws plain `Error` objects whose `cause` chain doesn't always carry a
 * structured network code the agent layer can reach. Matches the substrings
 * GLM gateways and common HTTP clients actually emit.
 */

/** Maximum retry attempts (initial + retries). */
const MAX_RETRY_ATTEMPTS = 3;

/** Base backoff in ms — doubles per attempt: 1000, 2000, 4000. */
const BASE_BACKOFF_MS = 1_000;

/** Cap a single backoff so a slow retry doesn't stall the pipeline. */
const MAX_BACKOFF_MS = 8_000;

/** Error-message substrings that indicate a retriable failure. */
const RETRIABLE_PATTERNS: readonly RegExp[] = [
	/\b429\b/,                              // HTTP 429 Too Many Requests
	/rate[ -]?limit/i,                      // "rate limit" / "rate-limit"
	/too many requests/i,                   // common 429 body text
	/\b50[237]\b/,                          // HTTP 502/503/504 server errors
	/(bad gateway|service unavailable|gateway timeout)/i,
	/(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)/i,  // Node network codes
	/UND_ERR_SOCKET|UND_ERR_CONNECT/i,      // undici fetch errors
	/(network|fetch|socket).*(?:failed|error|reset)/i,            // generic network phrasing
];

/** Returns true when an error looks retriable (rate limit, 5xx, network). */
export function isRetriableError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return RETRIABLE_PATTERNS.some((re) => re.test(message));
}

/**
 * Retries an async operation on retriable failures with exponential backoff.
 * Accepts a `Thenable` (VS Code's `sendRequest` returns `Thenable`, not
 * `Promise`) — wraps it in `await` so both Promise and Thenable work.
 * Non-retriable errors propagate immediately. Respects cancellation.
 */
export async function withRetry<T>(
	fn: () => Thenable<T> | Promise<T>,
	token?: vscode.CancellationToken,
	attempts: number = MAX_RETRY_ATTEMPTS,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (token?.isCancellationRequested) {
			throw new Error('Cancelled');
		}
		try {
			return await fn();
		} catch (error) {
			lastError = error;
			if (attempt === attempts - 1 || !isRetriableError(error)) {
				throw error;
			}
			// Exponential backoff: BASE * 2^attempt, capped.
			const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, backoff);
				// Allow cancellation to short-circuit the wait. Guard: not every
				// cancellation-token-shaped object exposes onCancellationRequested
				// (e.g. lightweight test stubs).
				if (typeof token?.onCancellationRequested === 'function') {
					token.onCancellationRequested(() => {
						clearTimeout(timer);
						resolve();
					});
				}
			});
		}
	}
	throw lastError;
}