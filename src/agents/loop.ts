import * as vscode from 'vscode';
import { resultToTextParts } from './modelSelect';

/** Hard cap on a sub-agent's tool loop — probes conclude fast, only the implementer gets a long leash. */
const MAX_SUBAGENT_TURNS = 4;

/** Longest single tool result fed back to a sub-agent, keeps history small over multiple turns. */
const MAX_TOOL_RESULT_CHARS = 6_000;

/** Matches tool-call markup some models write as plain text (e.g. `<｜tool_calls｜><｜invoke name="Browse"｜>`) instead of emitting real tool-call parts. */
const TOOL_CALL_MARKUP_RE =
	/<[｜|]tool_calls[｜|]>[\s\S]*?<\/[｜|]tool_calls[｜|]>|<[｜|]invoke name="[^"｜|]*"[｜|]>[\s\S]*?<\/[｜|]invoke[｜|]>|<[｜|]parameter name="[^"｜|]*"[｜|]>[\s\S]*?<\/[｜|]parameter[｜|]>/gi;

/** Removes tool-call markup written as text so it never leaks into agent reports. */
export function stripToolCallMarkup(text: string): string {
	return text.replace(TOOL_CALL_MARKUP_RE, '').trim();
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
}

export interface SubAgentResult {
	/** Final assistant text — the sub-agent's report. */
	text: string;
	turns: number;
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
	while (turn < maxTurns) {
		turn++;
		options.onTurn?.(turn);
		const response = await options.model.sendRequest(messages, requestOptions, options.token);
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
			return { text: cleanText, turns: turn };
		}
		for (const call of toolCalls) {
			let result: vscode.LanguageModelToolResult;
			try {
				result = await vscode.lm.invokeTool(call.name, {
					input: call.input,
					toolInvocationToken: undefined,
				}, options.token);
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
			messages.push(vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart(call.callId, truncateToolResult(resultToTextParts(result))),
			]));
		}
	}
	return { text: lastAssistantText, turns: turn };
}

/** Feed back at most MAX_TOOL_RESULT_CHARS of text per tool result, so history stays small. */
export function truncateToolResult(parts: vscode.LanguageModelTextPart[]): vscode.LanguageModelTextPart[] {
	if (parts.length === 0) {
		return [new vscode.LanguageModelTextPart('Tool returned no text output.')];
	}
	let total = 0;
	const kept: vscode.LanguageModelTextPart[] = [];
	for (const part of parts) {
		const room = MAX_TOOL_RESULT_CHARS - total;
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
