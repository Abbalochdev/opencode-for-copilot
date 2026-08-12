import { describe, expect, it } from 'vitest';
import { analyzeContextOverflow } from '../../src/client/error/overflow-retry';

describe('analyzeContextOverflow', () => {
	it('reduces max_tokens when the message carries authoritative token counts', () => {
		expect(
			analyzeContextOverflow(
				"This model's maximum context length is 131072 tokens. However, you requested 131900 tokens (130772 in the messages; 1128 in the completion).",
				16384,
			),
		).toEqual({
			contextWindow: 131072,
			requestedTokens: 131900,
			maxTokens: 13107,
		});
	});

	it('returns undefined when the message lacks token counts', () => {
		expect(
			analyzeContextOverflow('[1302][超出上下文长度限制，请减少上下文后重试]', 4096),
		).toBeUndefined();
	});

	it('returns undefined when the output budget is already below the reduced value', () => {
		expect(
			analyzeContextOverflow(
				"This model's maximum context length is 131072 tokens. However, you requested 131900 tokens.",
				5000,
			),
		).toBeUndefined();
	});

	it('handles the "tried to send" phrasing and windows', () => {
		const patch = analyzeContextOverflow(
			'Too many tokens: maximum context window is 262144 tokens, but you tried to send 280000 tokens.',
			32768,
		);
		expect(patch?.contextWindow).toBe(262144);
		expect(patch?.requestedTokens).toBe(280000);
		expect(patch?.maxTokens).toBe(26214);
	});
});
