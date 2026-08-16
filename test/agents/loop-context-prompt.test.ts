import { describe, expect, it } from 'vitest';
import { joinTaskPrompt } from '../../src/agents/loop';

const task = { id: '1', description: 'Add a button', workspaceRoot: '/repo' };

describe('joinTaskPrompt (chat-context injection point for sub-agents)', () => {
	it('preserves the historical "Task: <description>\\n<rest>" shape when no preamble', () => {
		expect(joinTaskPrompt(task, 'Focus area: ui')).toBe(
			'Task: Add a button\nFocus area: ui',
		);
	});

	it('interpolates the preamble as "Attached context:" when present', () => {
		const withPreamble = {
			...task,
			contextPreamble: '- src/Button.ts\n- src/Button.test.ts',
		};
		expect(joinTaskPrompt(withPreamble, 'Focus area: ui')).toBe(
			[
				'Task: Add a button',
				'',
				'Attached context:',
				'- src/Button.ts',
				'- src/Button.test.ts',
				'',
				'Focus area: ui',
			].join('\n'),
		);
	});

	it('treats a whitespace-only preamble as absent (no-op)', () => {
		const withWhitespace = { ...task, contextPreamble: '   \n\t  ' };
		expect(joinTaskPrompt(withWhitespace, 'rest')).toBe(
			joinTaskPrompt(task, 'rest'),
		);
	});

	it('uses the unmodified task description as the head even when preamble is set', () => {
		const withPreamble = { ...task, contextPreamble: '- some file' };
		expect(joinTaskPrompt(withPreamble, '').startsWith('Task: Add a button\n')).toBe(true);
	});
});
