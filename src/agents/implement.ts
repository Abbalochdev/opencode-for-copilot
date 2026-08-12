import * as vscode from 'vscode';
import { safeStringify } from '../json';
import { stripToolCallMarkup, truncateToolResult } from './loop';
import { pickModel, resultToText, resultToTextParts } from './modelSelect';
import type { AgentRoleConfig, PipelineTask, ResearchFinding } from './types';

const IMPLEMENT_SYSTEM_PROMPT =
	'You are the implementation agent. Make the requested change directly using the available tools. '
	+ 'After editing, always run the test suite via the runTests tool before declaring the task done. '
	+ 'If tests fail, read the failure output and fix it yourself in this same conversation — do not ask for a separate reviewer. '
	+ 'When you are finished and tests pass, reply with a short plain-text summary of the diff and explicitly say "tests passed".';

/** Hard cap on the self-correction tool loop; the spin guard below usually exits far earlier. */
const MAX_TURNS = 12;

/** How many recent calls the spin guard inspects for repeats. */
const SPIN_WINDOW = 4;

/** Tool calls that mutate files — repeats around these are legitimate re-reads, not spins. */
const EDIT_TOOL_NAMES = new Set([
	'apply_patch',
	'insert_edit_into_file',
	'create_file',
	'replace_string_in_file',
	'multi_replace_string_in_file',
	'create_directory',
	'edit_notebook_file',
]);

export interface ImplementationResult {
	diffSummary: string;
	testsPassed: boolean;
	ranTests: boolean;
	turns: number;
}

/**
 * Owns implementation AND validation as one continuous session on one model.
 * The same agent runs tests as a tool call and self-corrects in the same turn
 * loop. Removes the biggest source of coordination overhead and context loss
 * from the pipeline.
 *
 * Loop hardening:
 * - Repeated tool calls with no edit in between — identical repeats (A,A,A)
 *   AND oscillation (A,B,A,B) — are treated as a spin, not progress. The
 *   model is told to conclude instead of burning the remaining turns.
 * - With two turns left and no test run yet, a deadline nudge forces the
 *   runTests call before the budget runs out.
 * - If the loop ends at the turn cap without tests, runTests is invoked once
 *   by the pipeline itself so the report carries a real verdict.
 * - Tool results are truncated before being fed back, so the conversation
 *   stays small enough for the model to keep working instead of losing track
 *   and repeating calls.
 * - An empty tool result becomes an explicit "no text output" note so the
 *   model never repeats a call because it couldn't see a result.
 */
export async function runImplementation(
	task: PipelineTask,
	findings: ResearchFinding[],
	config: AgentRoleConfig,
	tools: vscode.LanguageModelChatTool[],
	token: vscode.CancellationToken,
	toolInvocationToken: vscode.ChatParticipantToolToken | undefined,
	reviewNotes?: string,
): Promise<ImplementationResult> {
	const model = await pickModel(config.implement);
	const findingsBlock = findings.map((f) => `### ${f.area}\n${f.summary}`).join('\n\n');
	const messages: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(IMPLEMENT_SYSTEM_PROMPT),
		vscode.LanguageModelChatMessage.User(
			`Task: ${task.description}\n`
			+ (findings.length > 0 ? `\nResearch findings:\n${findingsBlock}\n` : '')
			+ (reviewNotes ? `\nReviewer feedback to address before finishing:\n${reviewNotes}\n` : '')
			+ `\nWorkspace root: ${task.workspaceRoot}`,
		),
	];

	let testsPassed = false;
	let ranTests = false;
	let turn = 0;
	let lastAssistantText = '';
	let allText = '';
	let lastToolOutput = '';
	let recentCallKeys: string[] = [];
	let testNudgeSent = false;

	while (turn < MAX_TURNS) {
		turn++;
		// Deadline pressure: with two turns left and no test run yet, force the
		// runTests call before the budget runs out.
		if (!ranTests && !testNudgeSent && turn >= MAX_TURNS - 2) {
			testNudgeSent = true;
			messages.push(vscode.LanguageModelChatMessage.User(
				`You have ${MAX_TURNS - turn} turn(s) left and have NOT run the test suite yet. `
				+ 'Call runTests now, then conclude with your final plain-text summary.',
			));
		}
		const response = await model.sendRequest(messages, { tools }, token);
		let assistantText = '';
		const textParts: vscode.LanguageModelTextPart[] = [];
		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				assistantText += part.value;
				textParts.push(part);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push(part);
			}
		}
		allText += assistantText + '\n';
		if (textParts.length > 0 || toolCalls.length > 0) {
			messages.push(vscode.LanguageModelChatMessage.Assistant([...textParts, ...toolCalls]));
		}
		// Tool-call markup written as text (some models do this) is stripped —
		// it must never be trusted as a conclusion or leak into the summary.
		const concluded = stripToolCallMarkup(assistantText);
		if (concluded) {
			lastAssistantText = concluded;
		}
		if (toolCalls.length > 0) {
			for (const call of toolCalls) {
				// Spin guard: repeating a call with no edit in between is a loop,
				// not progress. Catches exact repeats (A,A,A) and oscillation
				// (A,B,A,B); repeats around a real edit are legitimate re-reads.
				const callKey = call.name + '::' + safeStringify(call.input);
				const isEdit = EDIT_TOOL_NAMES.has(call.name);
				const prior = recentCallKeys.slice(-SPIN_WINDOW);
				const isConsecutiveRepeat = prior.length > 0 && prior[prior.length - 1] === callKey;
				const thirdConsecutive =
					prior.length >= 2 && prior[prior.length - 1] === callKey && prior[prior.length - 2] === callKey;
				const oscillating =
					!isConsecutiveRepeat
					&& !isEdit
					&& prior.includes(callKey)
					&& !prior.some((key) => key.startsWith('edit:'));
				if (thirdConsecutive || oscillating) {
					messages.push(vscode.LanguageModelChatMessage.User([
						new vscode.LanguageModelToolResultPart(call.callId, [
							new vscode.LanguageModelTextPart(
								`You called ${call.name} with input you already have in history (repeating calls with no edit in between is a loop, not progress). `
								+ 'Stop looping: conclude with a final plain-text summary instead of another tool call.',
							),
						]),
					]));
					continue;
				}
				recentCallKeys.push((isEdit ? 'edit:' : '') + callKey);
				if (recentCallKeys.length > SPIN_WINDOW * 2) {
					recentCallKeys.shift();
				}

				let result: vscode.LanguageModelToolResult;
				try {
					result = await vscode.lm.invokeTool(call.name, {
						input: call.input,
						toolInvocationToken,
					}, token);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					messages.push(vscode.LanguageModelChatMessage.User([
						new vscode.LanguageModelToolResultPart(call.callId, [
							new vscode.LanguageModelTextPart(
								`Tool ${call.name} failed: ${detail} — adjust and retry if needed.`,
							),
						]),
					]));
					continue;
				}

				const text = resultToText(result);
				if (text.trim()) {
					lastToolOutput = text.slice(0, 2_000);
				}
				const parts = truncateToolResult(resultToTextParts(result));
				messages.push(vscode.LanguageModelChatMessage.User([
					new vscode.LanguageModelToolResultPart(call.callId, parts),
				]));
				if (call.name === 'runTests') {
					ranTests = true;
					testsPassed = /pass/i.test(text) && !/fail/i.test(text);
				}
			}
		} else if (concluded) {
			// The model concluded with plain text — trust it, but only treat
			// tests as passed if it says so (a text-only conclusion is not a
			// test run). Tool-call markup written as text is stripped first,
			// so a "conclusion" of only markup is not trusted.
			if (!ranTests) {
				testsPassed = /tests? (?:pass|passed)/i.test(concluded);
			}
			break;
		} else if (assistantText.trim()) {
			// Only tool-call markup as text (already stripped) — not a
			// conclusion. Tell the model to use the real tool API or conclude
			// with plain text, then keep looping within the turn budget.
			messages.push(vscode.LanguageModelChatMessage.User(
				'Your previous reply contained only tool-call markup written as text, which cannot be executed. '
				+ 'Use the real tool API if you need to call a tool, then conclude with a plain-text summary.',
			));
		}
	}

	// The turn cap was hit without a test run — run the suite once ourselves so
	// the report carries a real verdict instead of "verify manually". Best-effort
	// only: a failure keeps the honest "tests were not run" report.
	if (!ranTests) {
		try {
			const result = await vscode.lm.invokeTool('runTests', { input: {}, toolInvocationToken }, token);
			const text = resultToText(result);
			if (text.trim()) {
				ranTests = true;
				testsPassed = /pass/i.test(text) && !/fail/i.test(text);
			}
		} catch {
			// Ignore — the report stays honest about what actually ran.
		}
	}

	return {
		diffSummary:
			stripToolCallMarkup(lastAssistantText)
			|| stripToolCallMarkup(allText)
			|| (lastToolOutput
				? `Implementation hit the turn limit. Last tool output:\n\n${lastToolOutput}`
				: 'Max turns reached without an explicit completion signal — check manually.'),
		testsPassed,
		ranTests,
		turns: turn,
	};
}
