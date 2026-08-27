import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GLMClient } from '../../src/client/core';
import { convertToResponsesRequest } from '../../src/client/responses/convert';
import { parseResponsesStream } from '../../src/client/responses/stream';
import type { GLMRequest, StreamCallbacks } from '../../src/client/types';
import { resolveEndpointPresetForId } from '../../src/provider/opencode-models';
import { resolveEndpointProtocol } from '../../src/endpoint';

const servers: Server[] = [];

afterEach(() => {
	for (const server of servers) {
		server.close();
	}
	servers.length = 0;
});

function makeCallbacks() {
	const state = {
		content: '',
		thinking: '',
		toolCalls: [] as Array<{ name: string; arguments: string }>,
		done: 0,
		usage: undefined as { prompt_tokens: number; completion_tokens: number } | undefined,
		error: undefined as Error | undefined,
	};
	const callbacks: StreamCallbacks = {
		onContent: (text) => {
			state.content += text;
		},
		onThinking: (text) => {
			state.thinking += text;
		},
		onToolCall: (toolCall) => {
			state.toolCalls.push({
				name: toolCall.function.name,
				arguments: toolCall.function.arguments,
			});
		},
		onError: (error) => {
			state.error = error;
		},
		onDone: () => {
			state.done += 1;
		},
		onUsage: (usage) => {
			state.usage = {
				prompt_tokens: usage.prompt_tokens,
				completion_tokens: usage.completion_tokens,
			};
		},
	};
	return { state, callbacks };
}

describe('responses routing', () => {
	it('pins Go Responses models to the responses preset', () => {
		expect(resolveEndpointPresetForId('gpt-5.6-luna', 'go')).toBe('opencode-go-responses');
		expect(resolveEndpointPresetForId('grok-4.6', 'go')).toBe('opencode-go-responses');
		expect(resolveEndpointPresetForId('glm-5.2', 'go')).toBe('opencode-go');
		expect(resolveEndpointProtocol('opencode-go-responses')).toBe('responses');
	});
});

describe('convertToResponsesRequest', () => {
	it('maps system, user, assistant, and tool history into Responses input', () => {
		const request: GLMRequest = {
			model: 'gpt-5.6-luna',
			stream: true,
			max_tokens: 4096,
			tool_choice: 'auto',
			tools: [
				{
					type: 'function',
					function: {
						name: 'read_file',
						description: 'Read a file',
						parameters: { type: 'object', properties: { path: { type: 'string' } } },
					},
				},
			],
			messages: [
				{ role: 'system', content: 'Be concise.' },
				{ role: 'user', content: 'Inspect src/main.ts' },
				{
					role: 'assistant',
					content: '',
					tool_calls: [
						{
							id: 'call_1',
							type: 'function',
							function: { name: 'read_file', arguments: '{"path":"src/main.ts"}' },
						},
					],
				},
				{ role: 'tool', content: 'export {}', tool_call_id: 'call_1' },
			],
			thinking: { type: 'enabled' },
			reasoning_effort: 'max',
		};

		const converted = convertToResponsesRequest(request);

		expect(converted.instructions).toBe('Be concise.');
		expect(converted.max_output_tokens).toBe(4096);
		expect(converted.reasoning).toEqual({ effort: 'high' });
		expect(converted.input).toEqual([
			{
				type: 'message',
				role: 'user',
				content: [{ type: 'input_text', text: 'Inspect src/main.ts' }],
			},
			{
				type: 'function_call',
				call_id: 'call_1',
				name: 'read_file',
				arguments: '{"path":"src/main.ts"}',
			},
			{
				type: 'function_call_output',
				call_id: 'call_1',
				output: 'export {}',
			},
		]);
	});
});

describe('parseResponsesStream', () => {
	it('streams assistant text and usage from Responses SSE events', async () => {
		const sse = [
			'data: {"type":"response.output_text.delta","delta":"Hello"}',
			'',
			'data: {"type":"response.output_text.delta","delta":" Luna"}',
			'',
			'data: {"type":"response.completed","response":{"usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15,"input_tokens_details":{"cached_tokens":4}}}}',
			'',
		].join('\n');

		const { state, callbacks } = makeCallbacks();
		const reader = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(sse));
				controller.close();
			},
		}).getReader();

		await parseResponsesStream(reader, callbacks);

		expect(state.content).toBe('Hello Luna');
		expect(state.done).toBe(1);
		expect(state.usage).toEqual({ prompt_tokens: 12, completion_tokens: 3 });
	});

	it('streams reasoning and function-call arguments', async () => {
		const sse = [
			'data: {"type":"response.reasoning_summary_text.delta","delta":"think"}',
			'',
			'data: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_1","name":"grep"}}',
			'',
			'data: {"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\\"pattern\\":\\"foo\\"}"}',
			'',
			'data: {"type":"response.function_call_arguments.done","item_id":"fc_1","call_id":"call_1","name":"grep","arguments":"{\\"pattern\\":\\"foo\\"}"}',
			'',
			'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
			'',
		].join('\n');

		const { state, callbacks } = makeCallbacks();
		const reader = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(sse));
				controller.close();
			},
		}).getReader();

		await parseResponsesStream(reader, callbacks);

		expect(state.thinking).toBe('think');
		expect(state.toolCalls).toEqual([{ name: 'grep', arguments: '{"pattern":"foo"}' }]);
	});
});

describe('GLMClient responses protocol (mock server)', () => {
	it('posts to /responses and parses the stream', async () => {
		let requestPath = '';
		let requestBody: unknown;

		const server = createServer((req, res) => {
			requestPath = req.url ?? '';
			let raw = '';
			req.on('data', (chunk) => {
				raw += chunk;
			});
			req.on('end', () => {
				requestBody = JSON.parse(raw || '{}');
				res.writeHead(200, { 'Content-Type': 'text/event-stream' });
				res.end(
					[
						'data: {"type":"response.output_text.delta","delta":"ok"}',
						'',
						'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
						'',
					].join('\n'),
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		servers.push(server);
		const { port } = server.address() as AddressInfo;

		const client = new GLMClient(`http://127.0.0.1:${port}/v1`, 'test-key', 'responses');
		const { state, callbacks } = makeCallbacks();
		await client.streamChatCompletion(
			{
				model: 'gpt-5.6-luna',
				stream: true,
				messages: [{ role: 'user', content: 'hi' }],
			},
			callbacks,
		);

		expect(requestPath).toBe('/v1/responses');
		expect(requestBody).toMatchObject({
			model: 'gpt-5.6-luna',
			stream: true,
			input: [
				{
					type: 'message',
					role: 'user',
					content: [{ type: 'input_text', text: 'hi' }],
				},
			],
		});
		expect(state.content).toBe('ok');
		expect(state.done).toBe(1);
		expect(state.error).toBeUndefined();
	});
});
