import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LanguageModelChatTool } from 'vscode';

/**
 * Extends the shared vscode mock with the `lm` surface the research stage
 * needs (model lookup for decomposition). The sub-agent loop is mocked so the
 * fan-out and failure behavior can be asserted directly.
 */
vi.mock('vscode', async (importOriginal) => {
	const original = (await importOriginal()) as typeof import('../support/vscode.mock');
	const { LanguageModelChatMessageRole, LanguageModelTextPart } = original;

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

	const lm = {
		async selectChatModels(filter?: { vendor?: string; family?: string; id?: string }) {
			return registeredChatModels.filter(
				(m) =>
					(!filter?.vendor || m.vendor === filter.vendor) &&
					(!filter?.family || m.family === filter.family) &&
					(!filter?.id || m.id === filter.id),
			);
		},
	};

	return {
		...original,
		LanguageModelChatMessage,
		lm,
		__registerChatModel(model: (typeof registeredChatModels)[number]): void {
			registeredChatModels.push(model);
		},
		__resetLm(): void {
			registeredChatModels.length = 0;
		},
	};
});

vi.mock('../../src/agents/loop', async (importOriginal) => {
	const original = (await importOriginal()) as typeof import('../../src/agents/loop');
	return {
		...original,
		// Preserve the real joinTaskPrompt (used by researchOneArea to build the
		// prompt) so test assertions on `prompt.includes('Auth flow')` keep
		// working; only runSubAgent needs to be a vi.fn for call-counting.
		runSubAgent: vi.fn(),
	};
});

import { __registerChatModel, __resetLm } from 'vscode';
import { runSubAgent } from '../../src/agents/loop';
import { clearModelCache } from '../../src/agents/modelSelect';
import { runResearch } from '../../src/agents/research';
import type { AgentRoleConfig, PipelineTask } from '../../src/agents/types';

const task: PipelineTask = { id: 't1', description: 'Fix login bug', workspaceRoot: '/repo' };
const config: AgentRoleConfig = {
	research: [{ vendor: 'glm', family: 'decomp', id: 'decomp' }],
	implement: { vendor: 'glm', family: 'impl', id: 'impl-model' },
};

/** Decomposition model that answers with a numbered area list via response.text. */
function decomposeModel(lines: string[]) {
	return {
		vendor: 'glm',
		family: 'decomp',
		id: 'decomp',
		async sendRequest() {
			return {
				stream: (async function* () {})(),
				text: (async function* () {
					yield lines.join('\n');
				})(),
			};
		},
	};
}

/** Decomposition model that fails outright (tests the fallback path). */
function failingDecomposeModel() {
	return {
		vendor: 'glm',
		family: 'decomp',
		id: 'decomp',
		async sendRequest() {
			throw new Error('decompose exploded');
		},
	};
}

describe('runResearch swarm', () => {
	beforeEach(() => {
		__resetLm();
		clearModelCache();
		vi.mocked(runSubAgent).mockReset();
		vi.mocked(runSubAgent).mockResolvedValue({ text: 'findings', turns: 1 });
	});

	it('spawns one agent per decomposed area plus a whole-task scan', async () => {
		__registerChatModel(decomposeModel(['1. Auth flow', '2. UI polish']));

		const findings = await runResearch(task, config, [] as unknown as LanguageModelChatTool[], undefined);

		expect(findings).toHaveLength(3);
		expect(findings[0].area).toBe(task.description);
		expect(runSubAgent).toHaveBeenCalledTimes(3);
		// Every sub-agent is a full agent: read-only tools + bounded turn cap.
		for (const call of vi.mocked(runSubAgent).mock.calls) {
			expect(call[0].maxTurns).toBe(4);
			expect(Array.isArray(call[0].tools)).toBe(true);
		}
		// Findings carry the condensed summaries, not raw transcripts.
		expect(findings.map((f) => f.summary)).toEqual(['findings', 'findings', 'findings']);
	});

	it('falls back to a single whole-task scan when decomposition fails', async () => {
		__registerChatModel(failingDecomposeModel());

		const findings = await runResearch(task, config, [] as unknown as LanguageModelChatTool[], undefined);

		expect(findings).toHaveLength(1);
		expect(findings[0].area).toBe(task.description);
		expect(runSubAgent).toHaveBeenCalledTimes(1);
	});

	it('degrades when one research agent fails instead of sinking the swarm', async () => {
		__registerChatModel(decomposeModel(['1. Auth flow', '2. UI polish']));
		vi.mocked(runSubAgent).mockImplementation(async ({ prompt }) => {
			if (prompt.includes('Auth flow')) {
				throw new Error('rate limited');
			}
			return { text: 'findings', turns: 1 };
		});

		const findings = await runResearch(task, config, [] as unknown as LanguageModelChatTool[], undefined);

		expect(findings).toHaveLength(3);
		expect(findings[1].summary).toContain('research agent failed');
		expect(findings[1].relevantFiles).toEqual([]);
		expect(findings[2].summary).toBe('findings');
	});

	it('M4: extracts real file paths but not bare version strings', async () => {
		// Previously, /[\w./-]+\.\w+/g matched "v2.0" and "node v22.1" as
		// paths. The tighter regex requires a path separator or leading "./".
		__registerChatModel(decomposeModel(['1. Auth flow']));
		vi.mocked(runSubAgent).mockResolvedValue({
			text: 'See src/auth.ts and ./config.ts. Uses node v22.1 and lib v2.0.',
			turns: 1,
		});

		const findings = await runResearch(task, config, [] as unknown as LanguageModelChatTool[], undefined);

		expect(findings[0].relevantFiles).toContain('src/auth.ts');
		expect(findings[0].relevantFiles).toContain('./config.ts');
		// Version strings must NOT leak as "paths".
		expect(findings[0].relevantFiles).not.toContain('v22.1');
		expect(findings[0].relevantFiles).not.toContain('v2.0');
	});
});
