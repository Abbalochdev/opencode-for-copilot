import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModelChatTool } from 'vscode';

/**
 * Extends the shared vscode mock with the `lm` surface the sub-agent loop
 * needs: `selectChatModels` for model lookup and `invokeTool` for tool calls.
 * Scripted models record the messages they receive so tests can assert that
 * tool results were fed back into history.
 */
vi.mock('vscode', async (importOriginal) => {
	const original = (await importOriginal()) as typeof import('../support/vscode.mock');
	const {
		LanguageModelChatMessageRole,
		LanguageModelTextPart,
		LanguageModelToolCallPart,
		LanguageModelToolResultPart,
	} = original;

	class LanguageModelChatMessage {
		constructor(
			readonly role: number,
			readonly content: readonly unknown[],
		) {}

		static User(content: string | readonly unknown[]): LanguageModelChatMessage {
			return new LanguageModelChatMessage(
				LanguageModelChatMessageRole.User,
				typeof content === 'string' ? [new LanguageModelTextPart(content)] : content,
			);
		}

		static Assistant(content: readonly unknown[]): LanguageModelChatMessage {
			return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content);
		}
	}

	const registeredChatModels: Array<{
		vendor: string;
		family: string;
		id?: string;
		sendRequest(
			_messages: unknown[],
			_options?: { tools?: unknown[] },
			_token?: unknown,
		): { stream: AsyncIterable<unknown>; text: AsyncIterable<string> };
	}> = [];
	let invokeToolImpl:
		| ((name: string, input: unknown) => { content: { value?: string }[] })
		| undefined;

	const lm = {
		async selectChatModels(filter?: { vendor?: string; family?: string; id?: string }) {
			return registeredChatModels.filter(
				(m) =>
					(!filter?.vendor || m.vendor === filter.vendor) &&
					(!filter?.family || m.family === filter.family) &&
					(!filter?.id || m.id === filter.id),
			);
		},
		async invokeTool(name: string, options: { input: unknown }) {
			if (!invokeToolImpl) {
				throw new Error('lm.invokeTool: no implementation registered');
			}
			return invokeToolImpl(name, options.input);
		},
	};

	return {
		...original,
		LanguageModelChatMessage,
		lm,
		__registerChatModel(model: (typeof registeredChatModels)[number]): void {
			registeredChatModels.push(model);
		},
		__setInvokeTool(
			impl: (name: string, input: unknown) => { content: { value?: string }[] },
		): void {
			invokeToolImpl = impl;
		},
		__resetLm(): void {
			registeredChatModels.length = 0;
			invokeToolImpl = undefined;
		},
	};
});

import {
	LanguageModelTextPart,
	LanguageModelToolCallPart,
	__registerChatModel,
	__resetLm,
	__setInvokeTool,
} from 'vscode';
import { runSubAgent, truncateToolResult } from '../../src/agents/loop';

/** Scripts a fake model that plays back one stream of parts per turn and records the messages it received. */
function scriptedModel(streams: unknown[][]) {
	let turn = 0;
	const received: unknown[][] = [];
	return {
		vendor: 'glm',
		family: 'loop',
		id: 'loop-model',
		async sendRequest(messages: unknown[]) {
			received.push(messages);
			const parts = streams[Math.min(turn++, streams.length - 1)] ?? [];
			return {
				stream: (async function* () {
					yield* parts;
				})(),
				text: (async function* () {})(),
			};
		},
		messages: () => received,
	};
}

function options(
	model: ReturnType<typeof scriptedModel>,
	overrides: Partial<Parameters<typeof runSubAgent>[0]> = {},
) {
	return {
		model,
		systemPrompt: 'sys',
		prompt: 'prompt',
		tools: [] as unknown as LanguageModelChatTool[],
		token: undefined,
		maxTurns: 4,
		...overrides,
	};
}

describe('runSubAgent', () => {
	beforeEach(() => {
		__resetLm();
	});

	it('concludes immediately when the model returns no tool calls', async () => {
		const model = scriptedModel([[new LanguageModelTextPart('done')]]);
		__registerChatModel(model);

		const result = await runSubAgent(options(model));

		expect(result).toEqual({ text: 'done', turns: 1 });
	});

	it('nudges the model when it concludes with only tool-call markup as text', async () => {
		const model = scriptedModel([
			[new LanguageModelTextPart('<｜tool_calls｜><｜invoke name="Browse"｜><｜parameter name="path"｜>/repo</｜parameter｜></｜invoke｜></｜tool_calls｜>')],
			[new LanguageModelTextPart('no issues')],
		]);
		__registerChatModel(model);

		const result = await runSubAgent(options(model));

		// The markup-only "conclusion" was rejected; the model was nudged and
		// its real verdict is what the pipeline sees.
		expect(result.text).toBe('no issues');
		expect(result.turns).toBe(2);
		expect(JSON.stringify(model.messages()[1])).toContain('tool-call markup');
	});

	it('strips markup but keeps real text when a reply mixes both', async () => {
		const model = scriptedModel([
			[new LanguageModelTextPart('Plan is sound.<｜tool_calls｜><｜invoke name="Browse"｜>…</｜invoke｜></｜tool_calls｜>')],
		]);
		__registerChatModel(model);

		const result = await runSubAgent(options(model));

		expect(result.text).toBe('Plan is sound.');
		expect(result.turns).toBe(1);
	});

	it('runs a tool loop and feeds results back into history', async () => {
		const model = scriptedModel([
			[new LanguageModelToolCallPart('c1', 'grep_search', { query: 'foo' })],
			[new LanguageModelTextPart('Found 2 matches.')],
		]);
		__registerChatModel(model);
		const calls: Array<{ name: string; input: unknown }> = [];
		__setInvokeTool((name, input) => {
			calls.push({ name, input });
			return { content: [new LanguageModelTextPart('line1: foo\nline2: foo')] };
		});

		const result = await runSubAgent(
			options(model, {
				tools: [{ name: 'grep_search' }] as unknown as LanguageModelChatTool[],
			}),
		);

		expect(result.text).toBe('Found 2 matches.');
		expect(result.turns).toBe(2);
		expect(calls).toEqual([{ name: 'grep_search', input: { query: 'foo' } }]);
		// The tool result was fed back into the second turn's history.
		expect(JSON.stringify(model.messages()[1])).toContain('line1: foo');
	});

	it('survives a tool invocation failure with a corrective note', async () => {
		const model = scriptedModel([
			[new LanguageModelToolCallPart('c1', 'read_file', { path: 'a.ts' })],
			[new LanguageModelTextPart('concluded anyway')],
		]);
		__registerChatModel(model);
		__setInvokeTool(() => {
			throw new Error('tool boom');
		});

		const result = await runSubAgent(options(model));

		expect(result.text).toBe('concluded anyway');
		expect(result.turns).toBe(2);
		// The corrective message names the failing tool.
		expect(JSON.stringify(model.messages()[1])).toContain('read_file failed');
	});

	it('marks empty tool results so the model never repeats a blind call', async () => {
		const model = scriptedModel([
			[new LanguageModelToolCallPart('c1', 'list_dir', { path: '/x' })],
			[new LanguageModelTextPart('done')],
		]);
		__registerChatModel(model);
		__setInvokeTool(() => ({ content: [] }));

		await runSubAgent(options(model));

		expect(JSON.stringify(model.messages()[1])).toContain('no text output');
	});

	it('stops at the turn cap and returns the last assistant text', async () => {
		const model = scriptedModel([
			[new LanguageModelToolCallPart('c1', 'grep_search', {})],
			[new LanguageModelToolCallPart('c2', 'grep_search', {})],
			[new LanguageModelToolCallPart('c3', 'grep_search', {})],
		]);
		__registerChatModel(model);
		let invoked = 0;
		__setInvokeTool(() => {
			invoked++;
			return { content: [new LanguageModelTextPart('x')] };
		});

		const result = await runSubAgent(options(model, { maxTurns: 2 }));

		expect(result.turns).toBe(2);
		expect(invoked).toBe(2);
	});
});

describe('truncateToolResult', () => {
	it('keeps short text as-is', () => {
		const out = truncateToolResult([new LanguageModelTextPart('short')]);
		expect(out).toHaveLength(1);
		expect(out[0].value).toBe('short');
	});

	it('marks empty results explicitly', () => {
		expect(truncateToolResult([])[0].value).toContain('no text output');
	});

	it('truncates long text with a marker', () => {
		const out = truncateToolResult([new LanguageModelTextPart('x'.repeat(10_000))]);
		expect(out[0].value.length).toBeLessThan(10_000);
		expect(out[0].value).toContain('truncated');
	});
});
