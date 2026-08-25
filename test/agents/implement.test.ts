import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runImplementation } from '../../src/agents/implement';
import { clearModelCache } from '../../src/agents/modelSelect';
import type { PipelineTask } from '../../src/agents/types';

/**
 * Extends the shared vscode mock (test/support/vscode.mock.ts) with just the
 * `lm` surface and `LanguageModelChatMessage` that the implementation agent
 * needs, plus scriptable tool-result plumbing.
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

const task: PipelineTask = { id: 't1', description: 'Fix the loop', workspaceRoot: '/repo' };
const config = {
	research: [],
	implement: { vendor: 'glm', family: 'impl', id: 'impl-model' },
};

/** Scripts a fake model that plays back one stream of parts per turn. */
function scriptedModel(streams: unknown[][]) {
	let turn = 0;
	return {
		vendor: 'glm',
		family: 'impl',
		id: 'impl-model',
		async sendRequest() {
			const parts = streams[Math.min(turn++, streams.length - 1)] ?? [];
			return {
				stream: (async function* () {
					yield* parts;
				})(),
				text: (async function* () {})(),
			};
		},
	};
}

describe('runImplementation loop guard', () => {
	beforeEach(() => {
		__resetLm();
		clearModelCache();
	});

	it('M5: treats "6 passed, 4 failed" as NOT passed (structured verdict)', async () => {
		// Regression: the old /pass/i && !/fail/i heuristic misread
		// "6 passed, 4 failed" as a pass because "passed" matched.
		__registerChatModel(
			scriptedModel([
				[new LanguageModelToolCallPart('c1', 'runTests', { command: 'pnpm test' })],
				[new LanguageModelTextPart('Done — tests passed')],
			]),
		);
		__setInvokeTool((name) => ({
			content: [
				new LanguageModelTextPart(
					name === 'runTests'
						? 'Test Files 4 passed\n  Tests 6 passed, 4 failed'
						: 'ok',
				),
			],
		}));

		const result = await runImplementation(task, [], config, [], undefined, undefined);

		expect(result.ranTests).toBe(true);
		// New structured parser sees "4 failed" → not a pass.
		expect(result.testsPassed).toBe(false);
	});

	it('M5: treats an explicit "10 passed" verdict as a pass', async () => {
		__registerChatModel(
			scriptedModel([
				[new LanguageModelToolCallPart('c1', 'runTests', { command: 'pnpm test' })],
				[new LanguageModelTextPart('Done — tests passed')],
			]),
		);
		__setInvokeTool((name) => ({
			content: [
				new LanguageModelTextPart(
					name === 'runTests'
						? 'Test Files 22 passed\n  Tests 160 passed'
						: 'ok',
				),
			],
		}));

		const result = await runImplementation(task, [], config, [], undefined, undefined);

		expect(result.ranTests).toBe(true);
		expect(result.testsPassed).toBe(true);
	});

	it('suppresses the third identical tool call instead of looping to the turn cap', async () => {
		__registerChatModel(
			scriptedModel([
				[new LanguageModelToolCallPart('c1', 'runTests', { command: 'pnpm test' })],
				[new LanguageModelToolCallPart('c2', 'runTests', { command: 'pnpm test' })],
				[new LanguageModelToolCallPart('c3', 'runTests', { command: 'pnpm test' })],
				[new LanguageModelTextPart('Done — tests passed')],
			]),
		);
		const calls: string[] = [];
		__setInvokeTool((name) => {
			calls.push(name);
			return { content: [new LanguageModelTextPart('All tests passed')] };
		});

		const result = await runImplementation(task, [], config, [], undefined, undefined);

		// The third identical call was intercepted, so invokeTool only ran twice.
		expect(calls).toEqual(['runTests', 'runTests']);
		expect(result.turns).toBe(4);
		expect(result.ranTests).toBe(true);
		expect(result.testsPassed).toBe(true);
	});

	it('does not suppress legitimate different consecutive calls', async () => {
		__registerChatModel(
			scriptedModel([
				[new LanguageModelToolCallPart('c1', 'runTests', { command: 'pnpm test' })],
				[new LanguageModelToolCallPart('c2', 'apply_patch', { patch: 'x' })],
				[new LanguageModelToolCallPart('c3', 'runTests', { command: 'pnpm test' })],
				[new LanguageModelTextPart('Done — tests passed')],
			]),
		);
		const calls: string[] = [];
		__setInvokeTool((name) => {
			calls.push(name);
			return { content: [new LanguageModelTextPart('ok')] };
		});

		const result = await runImplementation(task, [], config, [], undefined, undefined);

		expect(calls).toEqual(['runTests', 'apply_patch', 'runTests']);
		expect(result.turns).toBe(4);
		// runTests ran but output was "ok" — not conclusive pass.
		expect(result.ranTests).toBe(true);
		expect(result.testsPassed).toBe(false);
	});

	it('suppresses oscillation between two read-only calls (A,B,A)', async () => {
		__registerChatModel(
			scriptedModel([
				[new LanguageModelToolCallPart('c1', 'read_file', { path: 'a.ts' })],
				[new LanguageModelToolCallPart('c2', 'grep_search', { query: 'foo' })],
				[new LanguageModelToolCallPart('c3', 'read_file', { path: 'a.ts' })],
				[new LanguageModelTextPart('Done')],
			]),
		);
		const calls: string[] = [];
		__setInvokeTool((name) => {
			calls.push(name);
			return { content: [new LanguageModelTextPart('ok')] };
		});

		const result = await runImplementation(task, [], config, [], undefined, undefined);

		// The repeated read_file (no edit in between) was intercepted, and the
		// pipeline ran runTests itself as a safety net since the model never did.
		expect(calls).toEqual(['read_file', 'grep_search', 'runTests']);
		expect(result.turns).toBe(4);
		expect(result.ranTests).toBe(true);
		// Safety-net output was "ok" — inconclusive, not a pass.
		expect(result.testsPassed).toBe(false);
	});

	it('M1: treats equivalent paths as the same call (normalization)', async () => {
		// read_file('a.ts') then read_file('./a.ts') then read_file('a.ts/')
		// should all collapse to the same spin key — the third triggers the
		// spin guard instead of re-reading the file.
		__registerChatModel(
			scriptedModel([
				[new LanguageModelToolCallPart('c1', 'read_file', { path: 'a.ts' })],
				[new LanguageModelToolCallPart('c2', 'read_file', { path: './a.ts' })],
				[new LanguageModelToolCallPart('c3', 'read_file', { path: 'a.ts/' })],
				[new LanguageModelTextPart('Done — tests passed')],
			]),
		);
		const calls: string[] = [];
		__setInvokeTool((name) => {
			calls.push(name);
			return { content: [new LanguageModelTextPart(name === 'runTests' ? 'All tests passed' : 'code')] };
		});

		const result = await runImplementation(task, [], config, [], undefined, undefined);

		// Only the first two read_file calls executed; the third was a spin
		// (same normalized path), and the safety net ran runTests.
		expect(calls.filter((c) => c === 'read_file')).toHaveLength(2);
		expect(calls).toContain('runTests');
		expect(result.ranTests).toBe(true);
		expect(result.testsPassed).toBe(true);
	});

	it('allows a repeated read after an edit (legitimate re-read)', async () => {
		__registerChatModel(
			scriptedModel([
				[new LanguageModelToolCallPart('c1', 'read_file', { path: 'a.ts' })],
				[new LanguageModelToolCallPart('c2', 'apply_patch', { patch: 'x' })],
				[new LanguageModelToolCallPart('c3', 'read_file', { path: 'a.ts' })],
				[new LanguageModelTextPart('Done')],
			]),
		);
		const calls: string[] = [];
		__setInvokeTool((name) => {
			calls.push(name);
			return { content: [new LanguageModelTextPart('ok')] };
		});

		const result = await runImplementation(task, [], config, [], undefined, undefined);

		// Re-read after an edit is legitimate — all three calls executed, then
		// the safety net ran runTests since the model concluded without it.
		expect(calls).toEqual(['read_file', 'apply_patch', 'read_file', 'runTests']);
		expect(result.turns).toBe(4);
		expect(result.ranTests).toBe(true);
		// Safety-net output was "ok" — inconclusive, not a pass.
		expect(result.testsPassed).toBe(false);
	});

	it('forces a test run when the turn budget is nearly exhausted', async () => {
		const streams = Array.from({ length: 9 }, (_, i) => [
			new LanguageModelToolCallPart(`c${i + 1}`, 'read_file', { path: `f${i + 1}.ts` }),
		]);
		streams.push([new LanguageModelToolCallPart('c10', 'runTests', { command: 'pnpm test' })]);
		streams.push([new LanguageModelTextPart('Done — tests passed')]);
		__registerChatModel(scriptedModel(streams));
		const calls: string[] = [];
		__setInvokeTool((name) => {
			calls.push(name);
			return {
				content: [new LanguageModelTextPart(name === 'runTests' ? 'All tests passed' : 'code')],
			};
		});

		const result = await runImplementation(task, [], config, [], undefined, undefined);

		expect(result.ranTests).toBe(true);
		expect(result.testsPassed).toBe(true);
		expect(result.turns).toBe(11);
		expect(calls.filter((c) => c === 'runTests')).toHaveLength(1);
	});

	it('does not trust tool-call markup written as text as a conclusion', async () => {
		__registerChatModel(
			scriptedModel([
				[new LanguageModelTextPart('<｜tool_calls｜><｜invoke name="apply_patch"｜><｜parameter name="patch"｜>x</｜parameter｜></｜invoke｜></｜tool_calls｜>')],
				[new LanguageModelTextPart('Done — tests passed')],
			]),
		);
		const calls: string[] = [];
		__setInvokeTool((name) => {
			calls.push(name);
			return { content: [new LanguageModelTextPart(name === 'runTests' ? 'All tests passed' : 'ok')] };
		});

		const result = await runImplementation(task, [], config, [], undefined, undefined);

		// The markup-only turn was NOT a conclusion (no real tool ran, no
		// trusted text); the model was nudged and concluded on the next turn,
		// and the pipeline ran the tests itself as the safety net.
		expect(result.turns).toBe(2);
		expect(calls).toEqual(['runTests']);
		expect(result.ranTests).toBe(true);
		expect(result.testsPassed).toBe(true);
		expect(result.diffSummary).toBe('Done — tests passed');
	});

	it('runs the test suite itself when the turn cap is hit without tests', async () => {
		// The agent burns all 12 turns on read calls and never runs tests —
		// the safety net must run runTests once so the report has a verdict.
		const streams = Array.from({ length: 12 }, (_, i) => [
			new LanguageModelToolCallPart(`c${i + 1}`, 'read_file', { path: `f${i + 1}.ts` }),
		]);
		__registerChatModel(scriptedModel(streams));
		const calls: string[] = [];
		__setInvokeTool((name) => {
			calls.push(name);
			return {
				content: [new LanguageModelTextPart(name === 'runTests' ? 'All tests passed' : 'code')],
			};
		});

		const result = await runImplementation(task, [], config, [], undefined, undefined);

		expect(result.turns).toBe(12);
		expect(calls.filter((c) => c === 'runTests')).toHaveLength(1);
		expect(result.ranTests).toBe(true);
		expect(result.testsPassed).toBe(true);
	});
});
