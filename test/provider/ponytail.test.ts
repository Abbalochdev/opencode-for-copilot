import { describe, expect, it } from 'vitest';
import { getPonytailInstruction, injectPonytailSystemMessage } from '../../src/provider/ponytail';
import type { GLMMessage } from '../../src/types';

describe('ponytail system message injection', () => {
	it('returns undefined instruction when mode is off', () => {
		expect(getPonytailInstruction('off')).toBeUndefined();
	});

	it('includes ladder keywords in full mode', () => {
		const instruction = getPonytailInstruction('full');
		expect(instruction).toContain('YAGNI');
		expect(instruction).toContain('standard library');
		expect(instruction).toContain('one line');
	});

	it('prepends a system message when none exists', () => {
		const messages: GLMMessage[] = [{ role: 'user', content: 'hello' }];
		const result = injectPonytailSystemMessage(messages, 'full');
		expect(result[0]?.role).toBe('system');
		expect(result[0]?.content).toContain('lazy senior developer');
		expect(result[1]).toEqual({ role: 'user', content: 'hello' });
	});

	it('appends to the first existing system message (recency bias)', () => {
		const messages: GLMMessage[] = [
			{ role: 'system', content: 'existing' },
			{ role: 'user', content: 'hello' },
		];
		const result = injectPonytailSystemMessage(messages, 'lite');
		expect(result).toHaveLength(2);
		expect(result[0]?.role).toBe('system');
		// Ponytail instruction should come AFTER existing content (recency)
		expect(result[0]?.content).toContain('existing');
		expect(result[0]?.content).toContain('PONYTAIL');
		// Verify Ponytail is at the end, not the beginning
		expect(result[0]?.content?.endsWith('context.')).toBe(true);
	});

	it('leaves messages unchanged when mode is off', () => {
		const messages: GLMMessage[] = [{ role: 'user', content: 'hello' }];
		const result = injectPonytailSystemMessage(messages, 'off');
		expect(result).toEqual(messages);
	});
});
