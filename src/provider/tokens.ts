import vscode from 'vscode';
import { REPLAY_MARKER_MIME } from './replay';

const IMAGE_PART_ESTIMATED_CHARS = 1020;

// Chars-per-token ratios for different scripts.
// Latin: ~4 chars/token. CJK: ~1.5 chars/token (2-3 CJK chars per token).
const CHARS_PER_TOKEN_LATIN = 4.0;
const CHARS_PER_TOKEN_CJK = 1.5;

/**
 * Check if a Unicode code point is CJK (Chinese/Japanese/Korean).
 * Covers CJK Unified Ideographs, Extensions A/B, and common ranges.
 */
function isCjkCodePoint(cp: number): boolean {
	return (
		(cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
		(cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
		(cp >= 0x20000 && cp <= 0x2a6df) || // CJK Extension B
		(cp >= 0x2a700 && cp <= 0x2b73f) || // CJK Extension C
		(cp >= 0x2b740 && cp <= 0x2b81f) || // CJK Extension D
		(cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
		(cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols and Punctuation
		(cp >= 0xff00 && cp <= 0xffef) // Fullwidth Forms
	);
}

/**
 * Estimate token count with per-script chars-per-token ratios.
 * CJK text uses ~1.5 chars/token, Latin text uses ~4 chars/token.
 */
function estimateTokenCountFromText(text: string): number {
	if (text.length === 0) {
		return 1;
	}

	let cjkChars = 0;
	let otherChars = 0;
	for (const cp of text) {
		if (isCjkCodePoint(cp.codePointAt(0) ?? 0)) {
			cjkChars += cp.length;
		} else {
			otherChars += cp.length;
		}
	}

	// Weighted average: tokens = cjkChars/CJK_RATIO + otherChars/LATIN_RATIO
	if (cjkChars === 0) {
		return Math.max(1, Math.ceil(otherChars / CHARS_PER_TOKEN_LATIN));
	}
	if (otherChars === 0) {
		return Math.max(1, Math.ceil(cjkChars / CHARS_PER_TOKEN_CJK));
	}

	const cjkTokens = cjkChars / CHARS_PER_TOKEN_CJK;
	const latinTokens = otherChars / CHARS_PER_TOKEN_LATIN;
	return Math.max(1, Math.ceil(cjkTokens + latinTokens));
}

/**
 * Recursively estimate the character count for a single content part.
 * Returns character count, which the caller divides by charsPerToken to get token estimate.
 */
function estimatePartChars(part: unknown): number {
	// 1. LanguageModelTextPart — the most common case
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value.length;
	}

	// 2. LanguageModelToolCallPart — count callId + name + JSON-serialized input
	if (part instanceof vscode.LanguageModelToolCallPart) {
		let chars = part.callId.length + part.name.length;
		try {
			chars += JSON.stringify(part.input).length;
		} catch {
			// If input can't be stringified (e.g. contains circular refs), fall back to a rough estimate
			chars += 2;
		}
		return chars;
	}

	// 3. LanguageModelToolResultPart — recursively count nested content parts
	if (part instanceof vscode.LanguageModelToolResultPart) {
		let chars = part.callId.length;
		if (Array.isArray(part.content)) {
			for (const item of part.content) {
				chars += estimatePartChars(item);
			}
		}
		return chars;
	}

	// 4. LanguageModelDataPart — use a capped heuristic because our model never
	//    receives binary data directly. Images are resolved to text descriptions
	//    by the vision pipeline; raw byteLength would massively overestimate.
	if (part instanceof vscode.LanguageModelDataPart) {
		const mime = part.mimeType;
		if (mime === REPLAY_MARKER_MIME) {
			// Marker metadata is not sent as assistant content. Its vision text belongs
			// logically to a previous user image message, but provideTokenCount only
			// receives one message at a time and cannot safely bind history here.
			return 0;
		}

		// Images are resolved by the vision pipeline before reaching GLM.
		// At token-count time we cannot know whether this image will be generated,
		// replayed from a later assistant marker, or omitted as a historical miss.
		// Use a stable fallback estimate instead of raw image bytes.
		if (mime.startsWith('image/')) {
			return IMAGE_PART_ESTIMATED_CHARS;
		}
		// PDFs and other documents: use byteLength as a rough proxy but cap it
		// to prevent a single large attachment from dominating the budget.
		return Math.min(part.data?.byteLength ?? 0, 10000);
	}

	// 5. LanguageModelThinkingPart (proposed API) — handle string | string[]
	if (isLanguageModelThinkingPart(part)) {
		if (typeof part.value === 'string') {
			return part.value.length;
		}
		if (Array.isArray(part.value)) {
			let chars = 0;
			for (const s of part.value) {
				chars += s.length;
			}
			return chars;
		}
		return 0;
	}

	// 6. LanguageModelPromptTsxPart — stringify the value if present
	// Duck-type check since PromptTsxPart may not always be available
	if (
		part &&
		typeof part === 'object' &&
		'value' in part &&
		part.constructor?.name === 'LanguageModelPromptTsxPart'
	) {
		try {
			return JSON.stringify((part as { value: unknown }).value).length;
		} catch {
			return 0;
		}
	}

	// Fallback: try to stringify unknown part types
	if (part && typeof part === 'object') {
		try {
			return JSON.stringify(part).length;
		} catch {
			return 0;
		}
	}

	return 0;
}

/**
 * Check for LanguageModelThinkingPart (proposed API, may not be available at runtime).
 */
function isLanguageModelThinkingPart(part: unknown): part is vscode.LanguageModelThinkingPart {
	return (
		typeof (vscode as Record<string, unknown>).LanguageModelThinkingPart === 'function' &&
		part instanceof vscode.LanguageModelThinkingPart
	);
}

export function estimateTokenCount(
	text: string | vscode.LanguageModelChatRequestMessage,
	charsPerToken: number,
): number {
	if (typeof text === 'string') {
		return estimateTokenCountFromText(text);
	}

	if (!text?.content || !Array.isArray(text.content)) {
		return 1;
	}

	let totalChars = 0;
	for (const part of text.content) {
		totalChars += estimatePartChars(part);
	}
	return Math.max(1, Math.ceil(totalChars / charsPerToken));
}
