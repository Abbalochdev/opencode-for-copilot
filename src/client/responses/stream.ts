import { logger } from '../../logger';
import type { GLMToolCall, GLMUsage, StreamCallbacks } from '../../types';

interface ResponsesSSEPayload {
	type?: string;
	delta?: string;
	text?: string;
	name?: string;
	arguments?: string;
	call_id?: string;
	item?: {
		id?: string;
		type?: string;
		call_id?: string;
		name?: string;
	};
	response?: {
		usage?: {
			input_tokens?: number;
			output_tokens?: number;
			total_tokens?: number;
			input_tokens_details?: { cached_tokens?: number };
		};
	};
	error?: { message?: string; type?: string };
}

interface PendingFunctionCall {
	callId: string;
	name: string;
	arguments: string;
}

/**
 * Parse an OpenAI Responses API SSE stream and dispatch to StreamCallbacks.
 */
export async function parseResponsesStream(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	callbacks: StreamCallbacks,
): Promise<void> {
	const decoder = new TextDecoder();
	let buffer = '';
	let latestUsage: GLMUsage | undefined;
	const pendingCalls = new Map<string, PendingFunctionCall>();
	const emittedCallIds = new Set<string>();

	const processPayload = (payload: ResponsesSSEPayload): boolean => {
		const type = payload.type;
		if (!type) {
			return false;
		}

		switch (type) {
			case 'response.output_text.delta':
				if (payload.delta) {
					callbacks.onContent(payload.delta);
				}
				return false;
			case 'response.reasoning_summary_text.delta':
			case 'response.reasoning_text.delta':
				if (payload.delta) {
					callbacks.onThinking(payload.delta);
				}
				return false;
			case 'response.output_item.added': {
				const item = payload.item;
				if (item?.type === 'function_call' && item.id) {
					pendingCalls.set(item.id, {
						callId: item.call_id ?? item.id,
						name: item.name ?? '',
						arguments: '',
					});
				}
				return false;
			}
			case 'response.function_call_arguments.delta': {
				const itemId = getItemId(payload);
				const pending = itemId ? pendingCalls.get(itemId) : undefined;
				if (pending && payload.delta) {
					pending.arguments += payload.delta;
				}
				return false;
			}
			case 'response.function_call_arguments.done': {
				const itemId = getItemId(payload);
				const pending = itemId ? pendingCalls.get(itemId) : undefined;
				const callId = payload.call_id ?? pending?.callId;
				const name = payload.name ?? pending?.name ?? '';
				const args = payload.arguments ?? pending?.arguments ?? '';
				if (callId && name && !emittedCallIds.has(callId)) {
					emittedCallIds.add(callId);
					callbacks.onToolCall({
						id: callId,
						type: 'function',
						function: { name, arguments: args },
					});
				}
				if (itemId) {
					pendingCalls.delete(itemId);
				}
				return false;
			}
			case 'response.completed': {
				latestUsage = mapUsage(payload.response?.usage);
				reportFinalUsage(callbacks, latestUsage);
				callbacks.onDone();
				return true;
			}
			case 'error': {
				const message = payload.error?.message ?? 'Responses API stream error';
				throw new Error(message);
			}
			default:
				return false;
		}
	};

	const processEventBlock = (rawEvent: string): boolean => {
		const lines = rawEvent.replace(/\r\n/g, '\n').split('\n');
		let dataLine: string | undefined;
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith(':')) {
				continue;
			}
			if (trimmed.startsWith('data:')) {
				dataLine = trimmed.slice(5).trimStart();
			}
		}
		if (!dataLine || dataLine === '[DONE]') {
			if (dataLine === '[DONE]') {
				reportFinalUsage(callbacks, latestUsage);
				callbacks.onDone();
				return true;
			}
			return false;
		}

		try {
			const payload = JSON.parse(dataLine) as ResponsesSSEPayload;
			return processPayload(payload);
		} catch (error) {
			logger.error('Failed to parse Responses SSE payload:', dataLine.slice(0, 200), error);
			return false;
		}
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });
		const normalized = buffer.replace(/\r\n/g, '\n');
		const events = normalized.split('\n\n');
		buffer = events.pop() || '';

		for (const rawEvent of events) {
			if (processEventBlock(rawEvent)) {
				return;
			}
		}
	}

	buffer += decoder.decode();
	if (buffer.length > 0) {
		for (const rawEvent of buffer.split('\n\n')) {
			if (processEventBlock(rawEvent)) {
				return;
			}
		}
	}

	for (const pending of pendingCalls.values()) {
		if (pending.callId && pending.name && !emittedCallIds.has(pending.callId)) {
			emittedCallIds.add(pending.callId);
			callbacks.onToolCall({
				id: pending.callId,
				type: 'function',
				function: { name: pending.name, arguments: pending.arguments },
			});
		}
	}
	reportFinalUsage(callbacks, latestUsage);
	callbacks.onDone();
}

function getItemId(payload: ResponsesSSEPayload): string | undefined {
	const itemId = (payload as { item_id?: string }).item_id;
	return typeof itemId === 'string' ? itemId : payload.item?.id;
}

function mapUsage(usage: unknown): GLMUsage | undefined {
	if (!usage || typeof usage !== 'object') {
		return undefined;
	}
	const record = usage as {
		input_tokens?: number;
		output_tokens?: number;
		total_tokens?: number;
		input_tokens_details?: { cached_tokens?: number };
	};
	const inputTokens = record.input_tokens ?? 0;
	const outputTokens = record.output_tokens ?? 0;
	const cachedTokens = record.input_tokens_details?.cached_tokens ?? 0;
	return {
		prompt_tokens: inputTokens,
		completion_tokens: outputTokens,
		total_tokens: record.total_tokens ?? inputTokens + outputTokens,
		prompt_cache_hit_tokens: cachedTokens,
	};
}

function reportFinalUsage(callbacks: StreamCallbacks, usage: GLMUsage | undefined): void {
	if (!usage || !callbacks.onUsage) {
		return;
	}
	callbacks.onUsage(usage);
}
