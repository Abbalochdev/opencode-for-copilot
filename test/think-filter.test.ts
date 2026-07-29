import { describe, expect, it } from 'vitest';
import { shouldStripThinkTags, ThinkTagFilter } from '../src/provider/think-filter';

describe('shouldStripThinkTags', () => {
	it('returns true for always mode', () => {
		expect(shouldStripThinkTags('always', 'any-model')).toBe(true);
	});

	it('returns false for never mode', () => {
		expect(shouldStripThinkTags('never', 'minimax-m2.5')).toBe(false);
	});

	it('returns true for auto mode with MiniMax M2 models', () => {
		expect(shouldStripThinkTags('auto', 'minimax-m2.5')).toBe(true);
		expect(shouldStripThinkTags('auto', 'minimax-m2.7')).toBe(true);
	});

	it('returns false for auto mode with non-leaky models', () => {
		expect(shouldStripThinkTags('auto', 'glm-5.2')).toBe(false);
		expect(shouldStripThinkTags('auto', 'deepseek-v4-flash')).toBe(false);
	});

	it('returns false for auto mode with undefined model', () => {
		expect(shouldStripThinkTags('auto', undefined)).toBe(false);
	});
});

describe('ThinkTagFilter', () => {
	it('passes through content without tags', () => {
		const filter = new ThinkTagFilter();
		expect(filter.process('Hello world')).toBe('Hello world');
	});

	it('strips a complete think tag in one delta', () => {
		const filter = new ThinkTagFilter();
		const input = 'Before <think>thinking here</think> After';
		expect(filter.process(input)).toBe('Before  After');
	});

	it('strips think tags split across deltas', () => {
		const filter = new ThinkTagFilter();
		expect(filter.process('Before <rea')).toBe('Before ');
		expect(filter.process('soning>hidden</reasoning> After')).toBe(' After');
	});

	it('strips multiple think tags', () => {
		const filter = new ThinkTagFilter();
		const input = 'A <think>x</think> B <think>y</think> C';
		expect(filter.process(input)).toBe('A  B  C');
	});

	it('handles ground tags', () => {
		const filter = new ThinkTagFilter();
		expect(filter.process('Text <ground>secret</ground> end')).toBe('Text  end');
	});

	it('flushes remaining buffer when not inside a tag', () => {
		const filter = new ThinkTagFilter();
		// process() emits content immediately when no partial tag is detected
		expect(filter.process('Hello partial')).toBe('Hello partial');
		// flush() returns nothing because the buffer was already drained
		expect(filter.flush()).toBe('');
	});

	it('flushes empty when inside a tag', () => {
		const filter = new ThinkTagFilter();
		filter.process('Before <ground>hidden');
		expect(filter.flush()).toBe('');
	});

	it('handles empty input', () => {
		const filter = new ThinkTagFilter();
		expect(filter.process('')).toBe('');
	});

	it('preserves content after a partial tag prefix', () => {
		const filter = new ThinkTagFilter();
		// '<gro' is a prefix of '<ground>', so it's buffered
		expect(filter.process('Hello <gro')).toBe('Hello ');
		// Next delta completes the tag
		expect(filter.process('und>hidden</ground> done')).toBe(' done');
	});
});