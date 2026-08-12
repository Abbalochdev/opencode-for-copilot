import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GLMClient } from '../../src/client/core';
import type { GLMRequest, StreamCallbacks } from '../../src/client/types';

const SSE_SUCCESS = [
	'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"mock","choices":[{"index":0,"delta":{"content":"Hello from mock"},"finish_reason":null}]}',
	'',
	'data: [DONE]',
	'',
].join('\n');

interface MockResponse {
	status: number;
	body: string;
	headers?: Record<string, string>;
}

type RequestLog = { body: GLMRequest };

const servers: Server[] = [];

afterEach(() => {
	for (const server of servers) {
		server.close();
	}
	servers.length = 0;
});

/** Start a local HTTP server that answers each request from `respond`. */
async function startMockServer(
	respond: (requestIndex: number, log: RequestLog[]) => MockResponse,
): Promise<{ baseUrl: string; log: RequestLog[] }> {
	const log: RequestLog[] = [];
	const server = createServer((req, res) => {
		let raw = '';
		req.on('data', (chunk) => {
			raw += chunk;
		});
		req.on('end', () => {
			const body = JSON.parse(raw || '{}') as GLMRequest;
			log.push({ body });
			const spec = respond(log.length - 1, log);
			res.writeHead(spec.status, { 'Content-Type': 'application/json', ...spec.headers });
			res.end(spec.body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	servers.push(server);
	const { port } = server.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${port}`, log };
}

function userMessage(text = 'hi'): GLMRequest['messages'] {
	return [{ role: 'user', content: text }];
}

function makeCallbacks() {
	const state = { content: '', done: 0, error: undefined as Error | undefined };
	const callbacks: StreamCallbacks = {
		onContent: (text) => {
			state.content += text;
		},
		onThinking: () => {},
		onToolCall: () => {},
		onError: (error) => {
			state.error = error;
		},
		onDone: () => {
			state.done += 1;
		},
	};
	return { state, callbacks };
}

describe('GLMClient retry phases (mock server)', () => {
	it('retries a transient 502 and succeeds on the second attempt', async () => {
		const { baseUrl, log } = await startMockServer((index) =>
			index === 0
				? {
						status: 502,
						body: JSON.stringify({ error: { message: 'RouterUnavailable: upstream unavailable' } }),
						headers: { 'Retry-After': '1' },
					}
				: { status: 200, body: SSE_SUCCESS },
		);

		const client = new GLMClient(baseUrl, 'test-key', 'openai');
		const { state, callbacks } = makeCallbacks();
		await client.streamChatCompletion(
			{ model: 'mock', messages: userMessage(), stream: true },
			callbacks,
		);

		expect(log).toHaveLength(2);
		expect(state.error).toBeUndefined();
		expect(state.content).toBe('Hello from mock');
		expect(state.done).toBe(1);
	}, 10_000);

	it('retries a context-overflow 400 with a reduced max_tokens', async () => {
		const overflowMessage =
			"This model's maximum context length is 131072 tokens. However, you requested 131900 tokens (130772 in the messages; 1128 in the completion).";
		const { baseUrl, log } = await startMockServer((index) =>
			index === 0
				? { status: 400, body: JSON.stringify({ error: { message: overflowMessage } }) }
				: { status: 200, body: SSE_SUCCESS },
		);

		const client = new GLMClient(baseUrl, 'test-key', 'openai');
		const { state, callbacks } = makeCallbacks();
		await client.streamChatCompletion(
			{ model: 'mock', messages: userMessage(), stream: true, max_tokens: 40_000 },
			callbacks,
		);

		expect(log).toHaveLength(2);
		expect(log[1].body.max_tokens).toBe(13_107); // floor(131072 × 0.1)
		expect(state.error).toBeUndefined();
		expect(state.content).toBe('Hello from mock');
	}, 10_000);

	it('halves the tool list on HTTP 500 and succeeds', async () => {
		const tools = Array.from({ length: 10 }, (_, i) => ({
			type: 'function' as const,
			function: { name: `tool_${i}`, description: 't', parameters: {} },
		}));
		const { baseUrl, log } = await startMockServer((index) =>
			index === 0
				? { status: 500, body: JSON.stringify({ error: { message: 'internal error' } }) }
				: { status: 200, body: SSE_SUCCESS },
		);

		const client = new GLMClient(baseUrl, 'test-key', 'openai');
		const { state, callbacks } = makeCallbacks();
		await client.streamChatCompletion(
			{ model: 'mock', messages: userMessage(), stream: true, tools },
			callbacks,
		);

		expect(log).toHaveLength(2);
		expect(log[1].body.tools).toHaveLength(5);
		expect(state.error).toBeUndefined();
		expect(state.content).toBe('Hello from mock');
	}, 10_000);
});
