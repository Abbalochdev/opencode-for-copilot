import { describe, expect, it } from 'vitest';
import { formatRulesInstruction, injectRulesSystemMessage } from '../../src/provider/rules';
import type { GLMMessage } from '../../src/types';

function system(content: string): GLMMessage {
	return { role: 'system', content };
}

function user(content: string): GLMMessage {
	return { role: 'user', content };
}

describe('formatRulesInstruction', () => {
	it('returns undefined for an empty array', () => {
		expect(formatRulesInstruction([])).toBeUndefined();
	});

	it('returns undefined when every entry is whitespace', () => {
		expect(formatRulesInstruction(['   ', '\t\n', ''])).toBeUndefined();
	});

	it('drops whitespace-only entries and bullets the rest', () => {
		expect(formatRulesInstruction(['Always TypeScript', '', '  ', 'Be concise'])).toBe(
			'### USER RULES\n\n- Always TypeScript\n- Be concise',
		);
	});

	it('trims each rule so leading/trailing spaces do not leak into the block', () => {
		expect(formatRulesInstruction(['  keep responses short  '])).toBe(
			'### USER RULES\n\n- keep responses short',
		);
	});
});

describe('injectRulesSystemMessage', () => {
	it('is a no-op and returns the input array when there are no rules', () => {
		const messages: GLMMessage[] = [system('existing'), user('hi')];
		expect(injectRulesSystemMessage(messages, [])).toBe(messages);
	});

	it('is a no-op when all rules are whitespace', () => {
		const messages: GLMMessage[] = [system('existing'), user('hi')];
		// distinct array reference, equal content — should match since no-op
		const result = injectRulesSystemMessage([...messages], ['   ']);
		expect(result).toEqual(messages);
	});

	it('prepends the rules block to an existing system message (cache-stable)', () => {
		const result = injectRulesSystemMessage([system('copilot content'), user('hi')], [
			'Always TypeScript',
		]);
		expect(result).toHaveLength(2);
		expect(result[0].content).toBe('### USER RULES\n\n- Always TypeScript\n\ncopilot content');
		expect(result[1]).toEqual(user('hi'));
		// non-mutating: original array untouched
	});

	it('creates a system message when none exists', () => {
		const result = injectRulesSystemMessage([user('hi')], ['Be concise']);
		expect(result).toHaveLength(2);
		expect(result[0]).toEqual({ role: 'system', content: '### USER RULES\n\n- Be concise' });
		expect(result[1]).toEqual(user('hi'));
	});

	it('does not mutate the input array', () => {
		const original: GLMMessage[] = [system('copilot content')];
		injectRulesSystemMessage(original, ['Rule A']);
		expect(original[0].content).toBe('copilot content');
	});

	it('places multiple rules as separate bullets in one block', () => {
		const result = injectRulesSystemMessage([system('base')], ['Rule A', 'Rule B']);
		expect(result[0].content).toBe('### USER RULES\n\n- Rule A\n- Rule B\n\nbase');
	});
});
