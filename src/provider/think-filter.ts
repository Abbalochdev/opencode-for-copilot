/**
 * Streaming think-tag filter.
 *
 * Some models (MiniMax M2, DeepSeek) leak reasoning tags like ` Müd`, `<ground>`,
 * or `<deliberation>` into the content stream instead of routing them through
 * `reasoning_content`. This filter strips those tags from content deltas so
 * users never see raw reasoning markup in chat output.
 *
 * The filter is stateful because tags can span multiple SSE deltas — an opening
 * ` Müd` may arrive in one chunk and the closing `</think>` in the next.
 */

/** Models known to leak think tags into content. */
const LEAKY_MODEL_PATTERNS = [/^minimax-m2/i];

export type StripThinkTagsMode = 'auto' | 'always' | 'never';

/** Tag pairs to strip: [opening, closing]. */
const THINK_TAG_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['<think>', '</think>'],
	['<ground>', '</ground>'],
	['<deliberation>', '</deliberation>'],
	['<reasoning>', '</reasoning>'],
];

export function shouldStripThinkTags(
	mode: StripThinkTagsMode,
	modelId: string | undefined,
): boolean {
	if (mode === 'always') return true;
	if (mode === 'never') return false;
	// auto: only strip for known leaky models
	if (!modelId) return false;
	return LEAKY_MODEL_PATTERNS.some((pattern) => pattern.test(modelId));
}

/**
 * Stateful filter that strips think tags from streaming content.
 * Handles tags that span multiple deltas.
 */
export class ThinkTagFilter {
	private insideTag = false;
	private activeTag: string | null = null;
	private buffer = '';

	/**
	 * Process a content delta and return the portion that should be emitted
	 * to the user (with think tags removed).
	 */
	process(delta: string): string {
		if (delta.length === 0) return '';

		this.buffer += delta;
		let output = '';

		while (this.buffer.length > 0) {
			if (this.insideTag && this.activeTag) {
				const closeTag = THINK_TAG_PAIRS.find(([, close]) => close === this.activeTag)?.[1];
				if (!closeTag) {
					// Shouldn't happen, but bail safely
					this.insideTag = false;
					this.activeTag = null;
					continue;
				}
				const closeIdx = this.buffer.indexOf(closeTag);
				if (closeIdx === -1) {
					// Closing tag not yet received — consume the buffer, emit nothing
					this.buffer = '';
					break;
				}
				// Skip past the closing tag
				this.buffer = this.buffer.slice(closeIdx + closeTag.length);
				this.insideTag = false;
				this.activeTag = null;
				continue;
			}

			// Not inside a tag — look for opening tags
			let earliestOpen = -1;
			let matchedPair: readonly [string, string] | null = null;
			for (const pair of THINK_TAG_PAIRS) {
				const idx = this.buffer.indexOf(pair[0]);
				if (idx !== -1 && (earliestOpen === -1 || idx < earliestOpen)) {
					earliestOpen = idx;
					matchedPair = pair;
				}
			}

			if (earliestOpen === -1 || !matchedPair) {
				// No opening tag found — emit everything except a potential partial match at the end
				const safeLength = this.findSafeEmitLength();
				output += this.buffer.slice(0, safeLength);
				this.buffer = this.buffer.slice(safeLength);
				break;
			}

			// Emit content before the tag
			output += this.buffer.slice(0, earliestOpen);
			this.buffer = this.buffer.slice(earliestOpen + matchedPair[0].length);
			this.insideTag = true;
			this.activeTag = matchedPair[1];
		}

		return output;
	}

	/**
	 * Find how many characters from the start of the buffer can be safely
	 * emitted without splitting a partial opening tag at the boundary.
	 *
	 * Checks if any suffix of the buffer is a prefix of an opening tag.
	 * If so, holds back that suffix; otherwise emits everything.
	 */
	private findSafeEmitLength(): number {
		const maxTagLength = Math.max(...THINK_TAG_PAIRS.map((p) => p[0].length));

		// Only the last (maxTagLength - 1) chars can possibly be a partial tag.
		const checkStart = Math.max(0, this.buffer.length - maxTagLength + 1);

		for (let i = checkStart; i < this.buffer.length; i++) {
			const suffix = this.buffer.slice(i);
			for (const [open] of THINK_TAG_PAIRS) {
				if (open.startsWith(suffix)) {
					return i; // Hold back the suffix — it might be a partial tag
				}
			}
		}

		return this.buffer.length; // No partial tag — safe to emit all
	}

	/** Flush any remaining buffered content (call at stream end). */
	flush(): string {
		const remaining = this.insideTag ? '' : this.buffer;
		this.buffer = '';
		this.insideTag = false;
		this.activeTag = null;
		return remaining;
	}
}
