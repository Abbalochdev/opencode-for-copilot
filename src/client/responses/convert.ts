import type { GLMMessage, GLMRequest, GLMTool } from '../../types';

interface ResponsesTextPart {
	type: 'input_text' | 'output_text';
	text: string;
}

interface ResponsesMessageItem {
	type: 'message';
	role: 'user' | 'assistant';
	content: ResponsesTextPart[];
}

interface ResponsesFunctionCallItem {
	type: 'function_call';
	call_id: string;
	name: string;
	arguments: string;
}

interface ResponsesFunctionCallOutputItem {
	type: 'function_call_output';
	call_id: string;
	output: string;
}

type ResponsesInputItem =
	| ResponsesMessageItem
	| ResponsesFunctionCallItem
	| ResponsesFunctionCallOutputItem;

interface ResponsesFunctionTool {
	type: 'function';
	name: string;
	description?: string;
	parameters: Record<string, unknown>;
}

export interface ResponsesRequest {
	model: string;
	input: ResponsesInputItem[];
	instructions?: string;
	tools?: ResponsesFunctionTool[];
	tool_choice?: 'none' | 'auto' | 'required';
	stream: boolean;
	max_output_tokens?: number;
	temperature?: number;
	top_p?: number;
	reasoning?: { effort: 'low' | 'medium' | 'high' };
}

/**
 * Convert an internal GLMRequest to the OpenAI Responses API format.
 */
export function convertToResponsesRequest(request: GLMRequest): ResponsesRequest {
	const instructions = extractInstructions(request.messages);
	const input = convertInput(request.messages);
	const tools = request.tools?.length ? request.tools.map(convertTool) : undefined;

	const responsesRequest: ResponsesRequest = {
		model: request.model,
		input,
		stream: request.stream,
	};

	if (instructions) {
		responsesRequest.instructions = instructions;
	}
	if (tools) {
		responsesRequest.tools = tools;
	}
	if (request.tool_choice) {
		responsesRequest.tool_choice = request.tool_choice;
	}
	if (request.max_tokens !== undefined) {
		responsesRequest.max_output_tokens = request.max_tokens;
	}
	if (request.temperature !== undefined) {
		responsesRequest.temperature = request.temperature;
	}
	if (request.top_p !== undefined) {
		responsesRequest.top_p = request.top_p;
	}
	if (request.thinking?.type === 'enabled') {
		responsesRequest.reasoning = { effort: mapReasoningEffort(request.reasoning_effort) };
	}

	return responsesRequest;
}

function extractInstructions(messages: GLMMessage[]): string | undefined {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === 'system') {
			parts.push(msg.content);
		}
	}
	if (parts.length === 0) {
		return undefined;
	}
	return parts.join('\n\n');
}

function convertInput(messages: GLMMessage[]): ResponsesInputItem[] {
	const input: ResponsesInputItem[] = [];

	for (const msg of messages) {
		if (msg.role === 'system') {
			continue;
		}

		if (msg.role === 'tool') {
			if (!msg.tool_call_id) {
				throw new Error('Tool message is missing tool_call_id');
			}
			input.push({
				type: 'function_call_output',
				call_id: msg.tool_call_id,
				output: msg.content,
			});
			continue;
		}

		if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
			if (msg.content) {
				input.push(createAssistantMessage(msg.content));
			}
			for (const tc of msg.tool_calls) {
				input.push({
					type: 'function_call',
					call_id: tc.id,
					name: tc.function.name,
					arguments: tc.function.arguments,
				});
			}
			continue;
		}

		if (msg.role === 'user') {
			input.push({
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: msg.content }],
			});
			continue;
		}

		if (msg.role === 'assistant') {
			input.push(createAssistantMessage(msg.content));
		}
	}

	return input;
}

function createAssistantMessage(content: string): ResponsesMessageItem {
	return {
		type: 'message',
		role: 'assistant',
		content: [{ type: 'output_text', text: content }],
	};
}

function convertTool(tool: GLMTool): ResponsesFunctionTool {
	return {
		type: 'function',
		name: tool.function.name,
		description: tool.function.description,
		parameters: tool.function.parameters ?? { type: 'object', properties: {} },
	};
}

function mapReasoningEffort(effort: GLMRequest['reasoning_effort']): 'low' | 'medium' | 'high' {
	return effort === 'max' ? 'high' : 'medium';
}
