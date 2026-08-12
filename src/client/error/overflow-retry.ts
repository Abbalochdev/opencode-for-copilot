/**
 * Context-overflow retry support.
 *
 * Some GLM-compatible gateways reject requests whose total context (input +
 * requested output) exceeds the model's context window with an HTTP 400 whose
 * message carries authoritative token counts, e.g.:
 *
 *   "This model's maximum context length is 131072 tokens. However, you
 *    requested 131900 tokens (130772 in the messages; 1128 in the completion)."
 *
 * When the counts are present we retry once with a reduced `max_tokens` so the
 * request fits. No counts in the message → no retry (we never guess).
 */

/** Minimum output budget we are willing to retry with. */
const CONTEXT_RETRY_MIN_SAFETY_TOKENS = 1_024;

/** Output budget fraction of the context window (mirrors Claude Code's compact retry). */
const CONTEXT_RETRY_SAFETY_RATIO = 0.1;

/** Matches "maximum context length/window is 131072 tokens". */
const CONTEXT_WINDOW_PATTERN = /maximum context (?:length|window) is\s*([\d,]+)\s*tokens?/i;

/** Matches "you requested / tried to send / this request has N tokens". */
const REQUESTED_TOKENS_PATTERN = /(?:you (?:requested|tried to send|have)|this request has|request has)\s*([\d,]+)\s*tokens?/i;

export interface ContextOverflowInfo {
	contextWindow: number;
	requestedTokens: number;
	maxTokens: number;
}

/**
 * Extract a reduced `max_tokens` from an overflow error message.
 * Returns `undefined` when the message lacks authoritative token counts or the
 * reduced budget would not actually be smaller than `currentMaxTokens`.
 */
export function analyzeContextOverflow(
	errorMessage: string,
	currentMaxTokens: number,
): ContextOverflowInfo | undefined {
	const contextMatch = errorMessage.match(CONTEXT_WINDOW_PATTERN);
	const requestedMatch = errorMessage.match(REQUESTED_TOKENS_PATTERN);
	if (!contextMatch || !requestedMatch) {
		return undefined;
	}

	const contextWindow = Number.parseInt(contextMatch[1].replaceAll(',', ''), 10);
	const requestedTokens = Number.parseInt(requestedMatch[1].replaceAll(',', ''), 10);
	if (!Number.isFinite(contextWindow) || !Number.isFinite(requestedTokens)) {
		return undefined;
	}

	const maxTokens = Math.max(
		CONTEXT_RETRY_MIN_SAFETY_TOKENS,
		Math.floor(contextWindow * CONTEXT_RETRY_SAFETY_RATIO),
	);

	return maxTokens >= 1 && maxTokens < currentMaxTokens
		? { contextWindow, requestedTokens, maxTokens }
		: undefined;
}
