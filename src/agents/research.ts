import * as vscode from 'vscode';
import type { PipelineCostTracker } from './cost';
import { joinTaskPrompt, runSubAgent } from './loop';
import { pickModel } from './modelSelect';
import { withRetry } from './retry';
import { selectReadOnlyTools } from './tools';
import type { AgentRoleConfig, PipelineTask, ResearchFinding } from './types';

const RESEARCH_SYSTEM_PROMPT =
	'You are a read-only research agent. You may read files and search the workspace to investigate your focus area, '
	+ 'but you cannot and must not suggest or make edits. '
	+ 'Investigate as much as you need, then conclude with a short report containing only: relevant files, '
	+ 'relevant symbols/functions, and any constraints or gotchas. Keep it to a short summary, not a file dump.';

/** Cap on parallel research areas produced by decomposition. */
const MAX_RESEARCH_AREAS = 3;

/** Max tool-loop turns per research agent before it must conclude its report. */
const MAX_RESEARCH_TURNS = 4;

const DECOMPOSE_PROMPT =
	`You are a task decomposition agent. Split the task below into at most ${MAX_RESEARCH_AREAS} independent, `
	+ 'non-overlapping research focus areas. Reply with a numbered list only, one area per line, nothing else.';

/**
 * Runs one autonomous research agent per area, concurrently, round-robining
 * across the configured research models so parallel calls don't all hit one
 * rate limit. Each agent gets read-only tools and its own tool loop, so it
 * can actually explore the codebase before reporting back — a full swarm,
 * not single-shot probes. Findings are condensed summaries, never raw
 * transcripts, so the implementation stage's context stays small.
 * Decomposition and a whole-task scan start together so the fan-out engages —
 * no sequential prefix.
 */
export async function runResearch(
	task: PipelineTask,
	config: AgentRoleConfig,
	tools: vscode.LanguageModelChatTool[],
	token: vscode.CancellationToken,
	progress?: vscode.Progress<{ message: string }>,
	costTracker?: PipelineCostTracker,
): Promise<ResearchFinding[]> {
	if (config.research.length === 0) {
		throw new Error('AgentRoleConfig.research must list at least one model.');
	}
	const readOnlyTools = selectReadOnlyTools(tools);
	// lazy: decomposition is one cheap call (~<1s); the overview scan overlaps
	// it, so the only serialization is the `await decompose` gate before the
	// narrow agents start. Accepting this ceiling: decomposition rarely blocks
	// long enough to justify a speculative fan-out.
	const decompose = deriveResearchAreas(task, config, token);
	const overviewCall = researchOneArea(task, task.description, 0, config, readOnlyTools, token, progress, costTracker)
		.catch((err) => failedFinding(task.description, err));
	const areas = await decompose;
	const narrowAreas = areas.filter((area) => area !== task.description);
	const narrowCalls = narrowAreas.map((area, i) =>
		researchOneArea(task, area, i + 1, config, readOnlyTools, token, progress, costTracker)
			.catch((err) => failedFinding(area, err)),
	);
	const [overview, ...narrow] = await Promise.all([overviewCall, ...narrowCalls]);
	return [overview, ...narrow];
}

/** Degraded finding for a research agent that failed — keeps the swarm alive. */
function failedFinding(area: string, err: unknown): ResearchFinding {
	return {
		area,
		summary: `(research agent failed: ${err instanceof Error ? err.message : String(err)})`,
		relevantFiles: [],
	};
}

async function researchOneArea(
	task: PipelineTask,
	area: string,
	index: number,
	config: AgentRoleConfig,
	tools: vscode.LanguageModelChatTool[],
	token: vscode.CancellationToken,
	progress?: vscode.Progress<{ message: string }>,
	costTracker?: PipelineCostTracker,
): Promise<ResearchFinding> {
	const modelRef = config.research[index % config.research.length];
	progress?.report({
		message: `Researching (${modelRef.id ?? modelRef.family}): ${area.slice(0, 60)}`,
	});
	const model = await pickModel(modelRef);
	const { text } = await runSubAgent({
		model,
		systemPrompt: RESEARCH_SYSTEM_PROMPT,
		prompt: joinTaskPrompt(task, `Focus area: ${area}\nWorkspace root: ${task.workspaceRoot}`),
		tools,
		token,
		maxTurns: MAX_RESEARCH_TURNS,
		costTracker,
	});
	return {
		area,
		summary: text,
		relevantFiles: extractFilePaths(text),
	};
}

/**
 * Splits the task into independent focus areas for parallel research via one
 * cheap call on the first research model. Parsing is intentionally loose:
 * any failure or empty result falls back to a single whole-task area.
 */
async function deriveResearchAreas(
	task: PipelineTask,
	config: AgentRoleConfig,
	token: vscode.CancellationToken,
): Promise<string[]> {
	const model = await pickModel(config.research[0]);
	const messages = [
		vscode.LanguageModelChatMessage.User(DECOMPOSE_PROMPT),
		vscode.LanguageModelChatMessage.User(task.description),
	];
	try {
		const response = await withRetry(
			() => model.sendRequest(messages, {}, token),
			token,
		);
		let text = '';
		for await (const chunk of response.text) {
			text += chunk;
		}
		const areas = text
			.split(/\r?\n/)
			.map((line) => line.replace(/^\s*(?:[-*]|\d+[.)]?)\s*/, '').trim())
			.filter((line) => line.length > 0)
			.slice(0, MAX_RESEARCH_AREAS);
		return areas.length > 0 ? areas : [task.description];
	} catch {
		return [task.description];
	}
}

/**
 * Extract file-ish paths from research output.
 *
 * M4 fix: the old `[\w./-]+\.\w+` regex matched bare version strings like
 * `v2.0`, `node v22.1` as paths. The tighter regex requires either (a) a
 * leading `./` prefix (relative path form), or (b) a path separator
 * (`/` or `\`) somewhere in the candidate, plus a known alphanumeric
 * extension — so `src/auth.ts` and `./config.ts` survive while bare
 * versions and bare dotted words are filtered out. Deduplicates via Set.
 */
function extractFilePaths(text: string): string[] {
	// Path candidate: word chars, dots, dashes, slashes, backslashes. Must
	// include at least one `/` or `\` OR start with `./`, and end with `.`alpha+.
	const re = /(?:^|[^\w./\\-])(\.?[\w.\\-]+(?:\/|\\)[\w.\\/-]*\.[A-Za-z]{1,8}|\.{2}[\w.-]+\.[A-Za-z]{1,8}|\.[\\/][\w.\\/-]*\.[A-Za-z]{1,8})/g;
	const matches: string[] = [];
	for (let m: RegExpExecArray | null = re.exec(text); m !== null; m = re.exec(text)) {
		// m[1] excludes the leading boundary char; trim any trailing punctuation.
		const path = m[1].replace(/[),;:]+$/, '');
		if (path) {
			matches.push(path);
		}
	}
	return [...new Set(matches)];
}