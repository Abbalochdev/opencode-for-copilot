import { describe, expect, it } from 'vitest';
import { PipelineCostTracker } from '../../src/agents/cost';

/**
 * Builds a pseudo chat-message shaped like `LanguageModelChatRequestMessage`:
 * `{ content: [{ value }] }`. `estimateTokenCount` falls to the "stringify
 * unknown part" branch and counts the part's JSON length — enough to verify
 * the tracker accumulates non-zero tokens without the vscode mock (which
 * doesn't export `LanguageModelTextPart` in the base fixture).
 */
function msg(text: string): unknown {
	return { role: 1, content: [{ value: text }] };
}

describe('PipelineCostTracker', () => {
	it('starts at zero', () => {
		const tracker = new PipelineCostTracker();
		const cost = tracker.build();
		expect(cost.inputTokens).toBe(0);
		expect(cost.outputTokens).toBe(0);
		expect(cost.requests).toBe(0);
	});

	it('counts input tokens and request count from messages', () => {
		const tracker = new PipelineCostTracker();
		tracker.countInput([msg('hello world')] as never);
		tracker.countInput([msg('foo'), msg('bar baz')] as never);
		const cost = tracker.build();
		expect(cost.requests).toBe(2);
		expect(cost.inputTokens).toBeGreaterThan(0);
	});

	it('counts output tokens from text length (≈4 chars/token)', () => {
		const tracker = new PipelineCostTracker();
		tracker.countOutput(5); // ceil(5/4) = 2
		tracker.countOutput(0); // max(1, 0) = 1
		const cost = tracker.build();
		expect(cost.outputTokens).toBe(3);
	});

	it('accumulates across multiple stages', () => {
		const tracker = new PipelineCostTracker();
		tracker.countInput([msg('research prompt')] as never);
		tracker.countOutput('research findings'.length);
		tracker.countInput([msg('review prompt')] as never);
		tracker.countOutput('no issues'.length);
		tracker.countInput([msg('implement prompt')] as never);
		tracker.countOutput('done — tests passed'.length);

		const cost = tracker.build();
		expect(cost.requests).toBe(3);
		expect(cost.inputTokens).toBeGreaterThan(0);
		expect(cost.outputTokens).toBeGreaterThan(0);
	});
});