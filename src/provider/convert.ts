import vscode from 'vscode';
import { LANGUAGE_MODEL_CHAT_SYSTEM_ROLE } from '../consts';
import { safeStringify } from '../json';
import type { GLMMessage, GLMTool, GLMToolCall } from '../types';
import { parseFirstReplayMarker } from './replay';

/**
 * Convert VS Code chat messages to GLM format.
 * Injects marker-replayed reasoning_content for assistant messages.
 */
export function convertMessages(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	isThinkingModel: boolean,
	modelId?: string,
): GLMMessage[] {
	const result: GLMMessage[] = [];
	const echoThinkingHistory = shouldEchoThinkingHistory(modelId);

	for (const message of messages) {
		const role = mapRole(message.role);

		let content = '';
		let thinkingContent = '';
		const toolCalls: GLMToolCall[] = [];
		const toolResults: Array<{ callId: string; content: string }> = [];

		for (const part of message.content) {
			if (part instanceof vscode.LanguageModelTextPart) {
				content += part.value;
			} else if (isLanguageModelThinkingPart(part)) {
				thinkingContent += normalizeThinkingPartText(part.value);
			} else if (part instanceof vscode.LanguageModelToolCallPart) {
				toolCalls.push({
					id: part.callId,
					type: 'function',
					function: {
						name: part.name,
						arguments: safeStringify(part.input),
					},
				});
			} else if (part instanceof vscode.LanguageModelToolResultPart) {
				let toolContent = '';
				for (const item of part.content) {
					if (item instanceof vscode.LanguageModelTextPart) {
						toolContent += item.value;
					}
				}
				toolResults.push({
					callId: part.callId,
					content: toolContent || safeStringify(part.content),
				});
			}
		}

		if (role === 'assistant') {
			if (content || toolCalls.length > 0 || (isThinkingModel && echoThinkingHistory && thinkingContent)) {
				const replayMarker = isThinkingModel && echoThinkingHistory ? parseFirstReplayMarker(message) : undefined;
				const msg: GLMMessage = {
					role: 'assistant' as const,
					content: content || '',
				};

				if (toolCalls.length > 0) {
					msg.tool_calls = toolCalls;
				}

				if (isThinkingModel && echoThinkingHistory) {
					msg.reasoning_content = getReasoningContent(replayMarker, thinkingContent);
				}

				result.push(msg);
			}
		} else {
			if (content) {
				result.push({
					role,
					content: content,
				});
			}
		}

		// Tool result messages follow their associated assistant message
		for (const tr of toolResults) {
			result.push({
				role: 'tool',
				content: tr.content,
				tool_call_id: tr.callId,
			});
		}
	}

	return result;
}

/**
 * Whether to echo prior assistant reasoning into the next request.
 *
 * DeepSeek requires the previous `reasoning_content` for correct multi-turn
 * reasoning; the other built-in families treat it as optional, so skipping it
 * saves tokens. Unknown/custom models keep the conservative default (echo).
 */
const OPTIONAL_REASONING_ECHO_PATTERN =
	/^(glm|kimi|grok|mimo|minimax|qwen|claude|pickle|north|nemotron|laguna|ling)/i;

export function shouldEchoThinkingHistory(modelId: string | undefined): boolean {
	if (!modelId) {
		return true;
	}
	return !OPTIONAL_REASONING_ECHO_PATTERN.test(modelId);
}

function getReasoningContent(
	replayMarker: ReturnType<typeof parseFirstReplayMarker>,
	thinkingContent: string,
): string {
	if (replayMarker?.valid && replayMarker.reasoningText) {
		return replayMarker.reasoningText;
	}
	return thinkingContent;
}

function isLanguageModelThinkingPart(part: unknown): part is vscode.LanguageModelThinkingPart {
	return (
		typeof vscode.LanguageModelThinkingPart === 'function' &&
		part instanceof vscode.LanguageModelThinkingPart
	);
}

function normalizeThinkingPartText(value: string | string[]): string {
	return Array.isArray(value) ? value.join('') : value;
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'system' | 'user' | 'assistant' {
	switch (role) {
		case vscode.LanguageModelChatMessageRole.User:
			return 'user';
		case vscode.LanguageModelChatMessageRole.Assistant:
			return 'assistant';
		default:
			if (role === LANGUAGE_MODEL_CHAT_SYSTEM_ROLE) {
				return 'system';
			}
			return 'user';
	}
}

/**
 * Convert VS Code tool definitions to GLM format.
 */
export function convertTools(
	tools: readonly vscode.LanguageModelChatTool[] | undefined,
): GLMTool[] | undefined {
	if (!tools || tools.length === 0) {
		return undefined;
	}

	return tools.map((tool) => ({
		type: 'function' as const,
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.inputSchema as Record<string, unknown> | undefined,
		},
	}));
}

/**
 * Count total characters across all messages to calibrate chars-per-token ratio.
 */
export function countMessageChars(messages: GLMMessage[], tools?: GLMTool[]): number {
	let total = 0;
	for (const msg of messages) {
		total += msg.content?.length ?? 0;
		total += msg.reasoning_content?.length ?? 0;
		if (msg.tool_calls) {
			for (const tc of msg.tool_calls) {
				total += tc.function?.name?.length ?? 0;
				total += tc.function?.arguments?.length ?? 0;
			}
		}
	}
	if (tools) {
		// Tool schemas count toward the API's `prompt_tokens`; including them
		// keeps the chars-per-token calibration honest.
		for (const tool of tools) {
			total += tool.function.name.length;
			total += tool.function.description?.length ?? 0;
			if (tool.function.parameters) {
				try {
					total += safeStringify(tool.function.parameters).length;
				} catch {
					total += 64; // unresolvable schema — approximate
				}
			}
		}
	}
	return total;
}
