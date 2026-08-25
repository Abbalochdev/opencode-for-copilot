import * as vscode from 'vscode';
import type { PipelineCostTracker } from './cost';
import { pickModel, resultToTextParts } from './modelSelect';
import { withModelFailover, withRetry } from './retry';
import type { ModelRef, PipelineTask } from './types';

/**
 * Per-run read-only tool-result cache (C4). Parallel sub-agents often read
 * the same file during research — without a cache every agent re-reads it
 * from disk and burns duplicate tokens. Cache is keyed by `name::inputJson`
 * and survives across turns of one pipeline run; cleared per run via
 * `clearToolResultCache()`. Only applied to read-only tools (`selectReadOnlyTools`).
 */
const toolResultCache = new Map<string, vscode.LanguageModelToolResult>();

/** Clears the per-run tool-result cache — call at the start of each pipeline run. */
export function clearToolResultCache(): void {
	toolResultCache.clear();
}

/** Read-only tool names eligible for the shared result cache. */
const CACHED_TOOL_NAMES = new Set(['read_file', 'list_dir', 'file_search', 'grep_search']);

/** Hard cap on a sub-agent's tool loop — probes conclude fast, only the implementer gets a long leash. */
const MAX_SUBAGENT_TURNS = 4;

/** Longest single tool result fed back to a sub-agent, keeps history small over multiple turns. */
const MAX_TOOL_RESULT_CHARS = 6_000;
/**
 * Scales truncation for sub-agots by turn budget — early turns have more
 * budget to read complete results, later turns trim harder to leave room.
 * Returns the effective char cap for a given turn and turn cap.
 */
export function adaptiveToolResultCap(turn: number, maxTurns: number, base = MAX_TOOL_RESULT_CHARS): number {
	// First half of the budget: full base budget. After that, linearly shrink
	// to half the base by the final turn. Keeps early investigation rich and
	// ensures a near-cap search doesn't blow the whole history.
	const halfway = Math.ceil(maxTurns / 2);
	if (turn <= halfway) {
		return base;
	}
	const remaining = maxTurns - turn + 1;
	const fraction = Math.max(0.5, remaining / halfway);
	return Math.floor(base * fraction);
}

/** Matches tool-call markup some models write as plain text (e.g. `<｜tool_calls｜><｜invoke name="Browse"｜>`) instead of emitting real tool-call parts. */
const TOOL_CALL_MARKUP_RE =
	/<[｜|]tool_calls[｜|]>[\s\S]*?<\/[｜|]tool_calls[｜|]>|<[｜|]invoke name="[^"｜|]*"[｜|]>[\s\S]*?<\/[｜|]invoke[｜|]>|<[｜|]parameter name="[^"｜|]*"[｜|]>[\s\S]*?<\/[｜|]parameter[｜|]>/gi;

/** Removes tool-call markup written as text so it never leaks into agent reports. */
export function stripToolCallMarkup(text: string): string {
	return text.replace(TOOL_CALL_MARKUP_RE, '').trim();
}

/**
 * Build the user-prompt **prefix** for a sub-agent — `Task: <description>`
 * plus the optional chat-context preamble ({@link PipelineTask.contextPreamble}),
 * so the agent actually sees attached @-references: files, folders, selection,
 * URLs the user attached in Copilot Chat. When the preamble is empty or
 * whitespace-only, the returned string is exactly `Task: <description>\n<rest>`,
 * preserving the historical prompt shape (and the stable prefix used for
 * server-side prompt caching).
 *
 * Used by research / review sub-agents — the implementer builds its own
 * larger inline message and prepends the preamble in place.
 */
export function joinTaskPrompt(task: PipelineTask, rest: string): string {
	const head = `Task: ${task.description}`;
	const preamble = task.contextPreamble?.trim();
	if (!preamble) {
		return `${head}\n${rest}`;
	}
	return `${head}\n\nAttached context:\n${preamble}\n\n${rest}`;
}

export interface SubAgentOptions {
	model: vscode.LanguageModelChat;
	systemPrompt: string;
	prompt: string;
	tools?: vscode.LanguageModelChatTool[];
	token: vscode.CancellationToken;
	maxTurns?: number;
	/** Called with the turn number before each model request (for progress reporting). */
	onTurn?: (turn: number) => void;
	/** Optional cost tracker — counts input/output tokens per turn. */
	costTracker?: PipelineCostTracker;
	/**
	  * times" — see {@link withModelFailover}. Empty = no failover, primary
	 * only (the historical behavior).
	 */
	fallbackRefs?: ModelRef[];
}

export interface SubAgentResult {
	/** Final assistant text — the sub-agent's report. */
	text: string;
	turns: number;
	/**
	 * Ref of a fallback model that handled at least one turn when the primary.
	 */
	fallbackUsed?: ModelRef;
}

/**
 * Runs one autonomous sub-agent: system + user prompt, then a tool loop until
 * the model concludes without tool calls or the turn cap is hit. The final
 * assistant text is the sub-agent's report back to the pipeline. This is what
 * makes research and review "real" agents — each has its own agenda, can
 * explore the codebase with its tools, and reports a synthesized result.
 */
export async function runSubAgent(options: SubAgentOptions): Promise<SubAgentResult> {
	const maxTurns = options.maxTurns ?? MAX_SUBAGENT_TURNS;
	const requestOptions = options.tools && options.tools.length > 0 ? { tools: options.tools } : {};
	const messages: vscode.LanguageModelChatMessage[] = [
		vscode.LanguageModelChatMessage.User(options.systemPrompt),
		vscode.LanguageModelChatMessage.User(options.prompt),
	];
	let lastAssistantText = '';
	let turn = 0;
	// Tracks the ref of any fallback model that handled a turn — surfaced up to
	let fallbackUsed: ModelRef | undefined;
	while (turn < maxTurns) {
		turn++;
		options.onTurn?.(turn);
		options.costTracker?.countInput(messages);
		const send = (model: vscode.LanguageModelChat): Thenable<vscode.LanguageModelChatResponse> =>
			model.sendRequest(messages, requestOptions, options.token);
		let response: vscode.LanguageModelChatResponse;
		if (options.fallbackRefs && options.fallbackRefs.length > 0) {
			const failover = await withModelFailover(
				options.model,
				options.fallbackRefs,
				pickModel,
				send,
				options.token,
			);
			response = failover.result;
			if (failover.usedFallback && failover.usedRef) {
				fallbackUsed = failover.usedRef;
			}
		} else {
			response = await withRetry(() => send(options.model), options.token);
		}
		const textParts: vscode.LanguageModelTextPart[] = [];
		const toolCalls: vscode.LanguageModelToolCallPart[] = [];
		for await (const part of response.stream) {
			if (part instanceof vscode.LanguageModelTextPart) {
				textParts.push(part);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push(part);
			}
		}
		const assistantText = textParts.map((p) => p.value).join('');
		const cleanText = stripToolCallMarkup(assistantText);
		if (cleanText) {
			lastAssistantText = cleanText;
		}
		options.costTracker?.countOutput(assistantText.length);
		if (textParts.length > 0 || toolCalls.length > 0) {
			messages.push(vscode.LanguageModelChatMessage.Assistant([...textParts, ...toolCalls]));
		}
		if (toolCalls.length === 0) {
			// The model "concluded" but only wrote tool-call markup as text
			// (some models do this instead of emitting real tool calls). That
			// is not a usable report — nudge it to conclude with plain text.
			if (assistantText.trim() && !cleanText) {
				messages.push(vscode.LanguageModelChatMessage.User(
					'Your previous reply contained only tool-call markup written as text, which cannot be executed. '
					+ 'Use the real tool API if you need to call a tool, then conclude with a plain-text report.',
				));
				continue;
			}
			return { text: cleanText, turns: turn, ...(fallbackUsed ? { fallbackUsed } : {}) };
		}
		for (const call of toolCalls) {
			let result: vscode.LanguageModelToolResult;
		const cacheKey = call.name + '::' + JSON.stringify(call.input);
		const isCacheable = CACHED_TOOL_NAMES.has(call.name);
		const cached = isCacheable ? toolResultCache.get(cacheKey) : undefined;
		if (cached) {
			result = cached;
		} else {
			try {
				result = await vscode.lm.invokeTool(call.name, {
					input: call.input,
					toolInvocationToken: undefined,
				}, options.token);
				if (isCacheable) {
					toolResultCache.set(cacheKey, result);
				}
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
		}
		messages.push(vscode.LanguageModelChatMessage.User([
			new vscode.LanguageModelToolResultPart(
				call.callId,
				truncateToolResult(resultToTextParts(result), adaptiveToolResultCap(turn, maxTurns)),
			),
		]));
	}
	}
	return { text: lastAssistantText, turns: turn, ...(fallbackUsed ? { fallbackUsed } : {}) };
}

/** Feed back at most `cap` (default MAX_TOOL_RESULT_CHARS) of text per tool result, so history stays small. */
export function truncateToolResult(
	parts: vscode.LanguageModelTextPart[],
	cap: number = MAX_TOOL_RESULT_CHARS,
): vscode.LanguageModelTextPart[] {
	if (parts.length === 0) {
		return [new vscode.LanguageModelTextPart('Tool returned no text output.')];
	}
	const effectiveCap = Math.max(1, cap);
	let total = 0;
	const kept: vscode.LanguageModelTextPart[] = [];
	for (const part of parts) {
		const room = effectiveCap - total;
		if (room <= 0) {
			break;
		}
		kept.push(room >= part.value.length
			? part
			: new vscode.LanguageModelTextPart(part.value.slice(0, room) + '\n… [truncated]'));
		total += part.value.length;
	}
	return kept;
}