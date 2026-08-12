import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModelChatTool } from 'vscode';

/**
 * Extends the shared vscode mock with the `lm` surface needed by the review
 * stage (model lookup via pickModel, tool invocation inside the sub-agent
 * loop). Reviewers are scripted models returning verdict text.
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

import { LanguageModelTextPart, __registerChatModel, __resetLm } from 'vscode';
import { runPreImplementationReview } from '../../src/agents/review';
import type { AgentRoleConfig, PipelineTask } from '../../src/agents/types';

/** Scripts a reviewer model that returns one text stream per turn. */
function reviewerModel(id: string, texts: string[]) {
	let turn = 0;
	return {
		vendor: 'glm',
		family: 'rev',
		id,
		async sendRequest() {
			const parts = [new LanguageModelTextPart(texts[Math.min(turn++, texts.length - 1)] ?? '')];
			return {
				stream: (async function* () {
					yield* parts;
				})(),
				text: (async function* () {})(),
			};
		},
	};
}

const task: PipelineTask = { id: 't1', description: 'Fix login bug', workspaceRoot: '/repo' };
const findings = [
	{ area: 'Auth flow', summary: 'auth.ts holds the session logic.', relevantFiles: ['auth.ts'] },
	{ area: 'UI polish', summary: 'login.tsx renders the form.', relevantFiles: ['login.tsx'] },
];
const baseConfig: AgentRoleConfig = {
	research: [],
	implement: { vendor: 'glm', family: 'impl', id: 'impl-model' },
};

describe('runPreImplementationReview', () => {
	beforeEach(() => {
		__resetLm();
	});

	it('returns null when no reviewers are configured', async () => {
		const result = await runPreImplementationReview(
			task,
			findings,
			{ ...baseConfig, review: [] },
			[] as unknown as LanguageModelChatTool[],
			undefined,
		);
		expect(result).toBeNull();
	});

	it('returns ok when every reviewer approves', async () => {
		__registerChatModel(reviewerModel('rev-1', ['no issues']));
		__registerChatModel(reviewerModel('rev-2', ['Plan is sound.']));

		const result = await runPreImplementationReview(
			task,
			findings,
			{ ...baseConfig, review: [
				{ vendor: 'glm', family: 'rev', id: 'rev-1' },
				{ vendor: 'glm', family: 'rev', id: 'rev-2' },
			] },
			[] as unknown as LanguageModelChatTool[],
			undefined,
		);

		expect(result?.verdict).toBe('ok');
	});

	it('flags issues with the original reviewer numbering', async () => {
		// Reviewer 1 approves; reviewer 2 flags. The note must say "Reviewer 2", not "Reviewer 1".
		__registerChatModel(reviewerModel('rev-1', ['no issues']));
		__registerChatModel(reviewerModel('rev-2', ['Research missed the token refresh path.']));

		const result = await runPreImplementationReview(
			task,
			findings,
			{ ...baseConfig, review: [
				{ vendor: 'glm', family: 'rev', id: 'rev-1' },
				{ vendor: 'glm', family: 'rev', id: 'rev-2' },
			] },
			[] as unknown as LanguageModelChatTool[],
			undefined,
		);

		expect(result?.verdict).toBe('issues');
		expect(result?.notes).toContain('Reviewer 2:');
		expect(result?.notes).not.toContain('Reviewer 1:');
	});

	it('does not treat "incorrect" as an approval', async () => {
		// Regression: /\bcorrect\b/ must not match inside "incorrect".
		__registerChatModel(reviewerModel('rev-1', ['The plan is incorrect.']));

		const result = await runPreImplementationReview(
			task,
			findings,
			{ ...baseConfig, review: [{ vendor: 'glm', family: 'rev', id: 'rev-1' }] },
			[] as unknown as LanguageModelChatTool[],
			undefined,
		);

		expect(result?.verdict).toBe('issues');
		expect(result?.notes).toContain('incorrect');
	});
});
