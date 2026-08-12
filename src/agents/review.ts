import * as vscode from 'vscode';
import { runSubAgent } from './loop';
import { pickModel } from './modelSelect';
import { selectReadOnlyTools } from './tools';
import type { AgentRoleConfig, PipelineTask, ResearchFinding, ReviewResult } from './types';

const REVIEW_SYSTEM_PROMPT =
	'You are a review agent in a multi-agent pipeline. The research stage just finished and implementation has NOT started yet. '
	+ 'Review the task and the research findings below. You may read files in the workspace to verify claims. '
	+ 'Check that the research is complete and consistent: no contradictions, no obvious gaps, risks and gotchas flagged. '
	+ 'Then conclude with either one short line saying the plan is sound (e.g. "no issues") or a numbered list of '
	+ 'issues the implementer MUST address before writing code.';

/** Max tool-loop turns per reviewer before it must conclude its verdict. */
const MAX_REVIEW_TURNS = 4;

/**
 * Full-agent pre-implementation review: each configured reviewer is an
 * autonomous agent with read-only tools and its own tool loop, so it can
 * verify research claims against the codebase before the implementer starts.
 * Reviewers run in parallel; any 'issues' verdict wins and flagged notes are
 * kept separate. Returns null when config.review is unset or empty — review
 * is optional by design, not a required pipeline stage.
 */
export async function runPreImplementationReview(
	task: PipelineTask,
	findings: ResearchFinding[],
	config: AgentRoleConfig,
	tools: vscode.LanguageModelChatTool[],
	token: vscode.CancellationToken,
	progress?: vscode.Progress<{ message: string }>,
): Promise<ReviewResult | null> {
	const reviewers = config.review ?? [];
	if (reviewers.length === 0) {
		return null;
	}
	const readOnlyTools = selectReadOnlyTools(tools);
	const findingsBlock = findings.map((f) => `### ${f.area}\n${f.summary}`).join('\n\n');
	const calls = reviewers.map(async (ref): Promise<ReviewResult> => {
		progress?.report({ message: `Reviewing research plan (${ref.id ?? ref.family})...` });
		const model = await pickModel(ref);
		const { text } = await runSubAgent({
			model,
			systemPrompt: REVIEW_SYSTEM_PROMPT,
			prompt: `Task: ${task.description}\n\nResearch findings:\n${findingsBlock}\n\nWorkspace root: ${task.workspaceRoot}`,
			tools: readOnlyTools,
			token,
			maxTurns: MAX_REVIEW_TURNS,
		});
		return {
			verdict: /no issues|plan is sound|looks sound|\bcorrect\b/i.test(text) ? 'ok' : 'issues',
			notes: text,
		};
	});
	const results = await Promise.all(calls);
	const flagged = results
		.map((r, i) => ({ ...r, reviewer: i + 1 }))
		.filter((r) => r.verdict === 'issues' && r.notes.trim().length > 0);
	if (flagged.length === 0) {
		return {
			verdict: 'ok',
			notes: results.map((r) => r.notes).join('\n'),
		};
	}
	return {
		verdict: 'issues',
		notes: flagged.map((r) => `Reviewer ${r.reviewer}: ${r.notes}`).join('\n\n'),
	};
}
