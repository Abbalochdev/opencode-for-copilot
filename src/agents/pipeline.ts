import * as vscode from 'vscode';
import { PipelineCostTracker } from './cost';
import { runImplementation } from './implement';
import { clearToolResultCache } from './loop';
import { clearModelCache } from './modelSelect';
import { runResearch } from './research';
import { runPreImplementationReview } from './review';
import type { AgentRoleConfig, ModelRef, PipelineResult, PipelineTask } from './types';

/**
 * Runs the full agent swarm: parallel research agents → parallel review
 * agents (both with their own tool loops, both before any code is written)
 * → implementation with self-correction. Review notes, if any, are handed to
 * the implementer so issues get addressed in the same run. Only uses the
 * chat model API, so it works with any model the extension can select.
 */
export async function runPipeline(
	task: PipelineTask,
	config: AgentRoleConfig,
	tools: vscode.LanguageModelChatTool[],
	token: vscode.CancellationToken,
	progress: vscode.Progress<{ message: string }>,
	toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
): Promise<PipelineResult> {
	// Fresh per-run caches: model lookups + cost tracking + read-only tool results.
	clearModelCache();
	clearToolResultCache();
	const costTracker = new PipelineCostTracker();

	progress.report({ message: `Researching (parallel, ${config.research.map(label).join(' + ')})` });
	const findings = await runResearch(task, config, tools, token, progress, costTracker);

	let reviewNote: string | undefined;
	if (config.review?.length) {
		progress.report({ message: `Reviewing the research plan (models: ${config.review.map(label).join(' + ')})` });
		const review = await runPreImplementationReview(task, findings, config, tools, token, progress, costTracker);
		if (review?.verdict === 'issues') {
			reviewNote = review.notes;
		}
	}

	progress.report({ message: `Implementing and running tests (model: ${label(config.implement)})...` });
	const { diffSummary, testsPassed, ranTests, turns } = await runImplementation(
		task,
		findings,
		config,
		tools,
		token,
		toolInvocationToken,
		reviewNote,
		progress,
		costTracker,
	);

	return {
		diffSummary,
		testsPassed,
		ranTests,
		turns,
		researchAreas: findings.length,
		reviewNote,
		cost: costTracker.build(),
	};
}

/** Builds the final chat report from the pipeline result. */
export function formatReport(result: PipelineResult): string {
	const lines = [
		result.researchAreas > 0
			? `Research covered ${result.researchAreas} area(s) in parallel before implementation.`
			: 'No research pre-pass was needed for this task.',
		`Implementation finished in ${result.turns} turn(s). `
			+ (result.ranTests
				? `Tests ${result.testsPassed ? 'passed.' : 'did NOT pass — check manually.'}`
				: 'Tests were not run by the agent — verify manually.'),
	];
	if (result.reviewNote) {
		lines.push(`Pre-implementation review flagged something:\n${result.reviewNote}`);
	}
	if (result.cost) {
		lines.push(
			`Cost (est): ${result.cost.inputTokens.toLocaleString()} in / ${result.cost.outputTokens.toLocaleString()} out tokens across ${result.cost.requests} request(s).`,
		);
	}
	lines.push('', result.diffSummary);
	return lines.join('\n');
}

/** Human-readable model name for progress messages. */
function label(ref: ModelRef): string {
	return ref.id ?? ref.family;
}
