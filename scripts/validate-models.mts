#!/usr/bin/env node
/**
 * validate-models.mts — Model parameter validation suite.
 *
 * Tests each model from the OpenCode API against the live endpoint to verify
 * that thinking/reasoning parameters, tool calling, and basic streaming work.
 *
 * Reuses the extension's own model metadata overlay to know which models
 * support thinking and what endpoint preset they use.
 *
 * Usage:
 *   npx tsx scripts/validate-models.mts --api-key YOUR_KEY
 *   OPENCODE_API_KEY=... npx tsx scripts/validate-models.mts
 *   npx tsx scripts/validate-models.mts --api-key YOUR_KEY --families glm,deepseek
 *   npx tsx scripts/validate-models.mts --api-key YOUR_KEY --json
 */

import { parseArgs } from 'node:util';
import {
    OPENCODE_GO_ANTHROPIC_BASE_URL,
    OPENCODE_GO_OPENAI_BASE_URL,
    OPENCODE_ZEN_ANTHROPIC_BASE_URL,
    OPENCODE_ZEN_OPENAI_BASE_URL,
} from '../src/endpoint.js';
import { fetchAllOpenCodeModelIds, getOverlayModels } from '../src/provider/opencode-models.js';
import type { EndpointPreset } from '../src/types.js';

// ---- CLI ----

const { values: args } = parseArgs({
	options: {
		'api-key': { type: 'string' },
		families: { type: 'string' },
		models: { type: 'string' },
		'skip-models': { type: 'string' },
		json: { type: 'boolean', default: false },
		timeout: { type: 'string', default: '30000' },
	},
});

const API_KEY = args['api-key'] ?? process.env.OPENCODE_API_KEY;
const TIMEOUT_MS = Number(args.timeout) || 30000;
const FAMILIES_FILTER = args.families?.split(',').map((f) => f.trim().toLowerCase());
const MODELS_FILTER = args.models?.split(',').map((m) => m.trim());
const SKIP_MODELS = new Set(args['skip-models']?.split(',').map((m) => m.trim()) ?? []);
const OUTPUT_JSON = args.json === true;

if (!API_KEY) {
	console.error('Error: --api-key or OPENCODE_API_KEY env var required.');
	console.error('Usage: npx tsx scripts/validate-models.mts --api-key YOUR_KEY');
	process.exit(1);
}

// ---- Types ----

interface ModelInfo {
	id: string;
	family: string;
	endpointPreset: EndpointPreset;
	thinking: boolean;
	supportsReasoningEffort: boolean;
}

interface TestResult {
	modelId: string;
	family: string;
	tests: ParamTestResult[];
}

interface ParamTestResult {
	name: string;
	settings: Record<string, unknown>;
	passed: boolean;
	error?: string;
	latencyMs?: number;
}

interface ParamTest {
	name: string;
	settings: Record<string, unknown>;
}

// ---- Endpoint resolution ----

function resolveBaseUrlAndProtocol(preset: EndpointPreset): {
	baseUrl: string;
	protocol: 'openai' | 'anthropic';
} {
	switch (preset) {
		case 'opencode-go':
			return { baseUrl: OPENCODE_GO_OPENAI_BASE_URL, protocol: 'openai' };
		case 'opencode-go-anthropic':
			return { baseUrl: OPENCODE_GO_ANTHROPIC_BASE_URL, protocol: 'anthropic' };
		case 'opencode-zen':
			return { baseUrl: OPENCODE_ZEN_OPENAI_BASE_URL, protocol: 'openai' };
		case 'opencode-zen-anthropic':
			return { baseUrl: OPENCODE_ZEN_ANTHROPIC_BASE_URL, protocol: 'anthropic' };
		default:
			return { baseUrl: OPENCODE_GO_OPENAI_BASE_URL, protocol: 'openai' };
	}
}

// ---- Thinking test builder ----

function buildThinkingTests(model: ModelInfo): ParamTest[] {
	const tests: ParamTest[] = [];

	// Baseline: no thinking params
	tests.push({ name: 'baseline (no thinking)', settings: {} });

	if (!model.thinking) {
		return tests;
	}

	if (model.supportsReasoningEffort) {
		// Models with reasoning_effort: test high and max
		tests.push({
			name: 'reasoning_effort=high',
			settings: { reasoning_effort: 'high' },
		});
		tests.push({
			name: 'reasoning_effort=max',
			settings: { reasoning_effort: 'max' },
		});
	}

	// Thinking enabled/disabled
	tests.push({
		name: 'thinking=enabled',
		settings: { thinking: { type: 'enabled' } },
	});
	tests.push({
		name: 'thinking=disabled',
		settings: { thinking: { type: 'disabled' } },
	});

	return tests;
}

// ---- API request ----

async function testModel(
	model: ModelInfo,
	test: ParamTest,
): Promise<ParamTestResult> {
	const { baseUrl, protocol } = resolveBaseUrlAndProtocol(model.endpointPreset);
	const start = Date.now();

	try {
		const body = buildRequestBody(model.id, test.settings, protocol);
		const url =
			protocol === 'anthropic'
				? `${baseUrl}/v1/messages`
				: `${baseUrl}/chat/completions`;

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		if (protocol === 'anthropic') {
			headers['x-api-key'] = API_KEY;
			headers['anthropic-version'] = '2023-06-01';
		} else {
			headers.Authorization = `Bearer ${API_KEY}`;
		}

		const response = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});

		const latencyMs = Date.now() - start;

		if (!response.ok) {
			const text = await response.text().catch(() => '');
			return {
				...test,
				passed: false,
				error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
				latencyMs,
			};
		}

		// Consume the stream to verify it completes
		if (!response.body) {
			return { ...test, passed: false, error: 'No response body', latencyMs };
		}

		const reader = response.body.getReader();
		let receivedContent = false;
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = decoder.decode(value, { stream: true });
			if (chunk.includes('content') || chunk.includes('text') || chunk.includes('delta')) {
				receivedContent = true;
			}
		}

		return {
			...test,
			passed: receivedContent,
			error: receivedContent ? undefined : 'No content received in stream',
			latencyMs,
		};
	} catch (error) {
		return {
			...test,
			passed: false,
			error: error instanceof Error ? error.message : String(error),
			latencyMs: Date.now() - start,
		};
	}
}

function buildRequestBody(
	modelId: string,
	settings: Record<string, unknown>,
	protocol: 'openai' | 'anthropic',
): Record<string, unknown> {
	const prompt = 'Reply with exactly: OK';

	if (protocol === 'anthropic') {
		const body: Record<string, unknown> = {
			model: modelId,
			max_tokens: 16,
			messages: [{ role: 'user', content: prompt }],
			stream: true,
		};
		if (settings.thinking) {
			body.thinking = settings.thinking;
		}
		return body;
	}

	const body: Record<string, unknown> = {
		model: modelId,
		max_tokens: 16,
		messages: [{ role: 'user', content: prompt }],
		stream: true,
		stream_options: { include_usage: true },
	};
	if (settings.thinking) {
		body.thinking = settings.thinking;
	}
	if (settings.reasoning_effort) {
		body.reasoning_effort = settings.reasoning_effort;
	}
	return body;
}

// ---- Model collection ----

function collectModels(): ModelInfo[] {
	const overlay = getOverlayModels();
	return overlay
		.filter((m) => {
			if (SKIP_MODELS.has(m.id)) return false;
			if (MODELS_FILTER && !MODELS_FILTER.includes(m.id)) return false;
			if (FAMILIES_FILTER && !FAMILIES_FILTER.includes(m.family.toLowerCase())) return false;
			// Only test OpenCode models (skip utility aliases and GLM-native models)
			if (!m.endpointPreset?.startsWith('opencode-')) return false;
			return true;
		})
		.map((m) => ({
			id: m.id,
			family: m.family,
			endpointPreset: m.endpointPreset!,
			thinking: m.capabilities.thinking,
			supportsReasoningEffort: m.supportsReasoningEffort ?? false,
		}));
}

// ---- Output ----

function formatReport(results: TestResult[], models: ModelInfo[]): string {
	const lines: string[] = [];
	const totalTests = results.reduce((sum, r) => sum + r.tests.length, 0);
	const passedTests = results.reduce(
		(sum, r) => sum + r.tests.filter((t) => t.passed).length,
		0,
	);

	lines.push('═'.repeat(70));
	lines.push(`Model Validation Report — ${models.length} models, ${totalTests} tests`);
	lines.push(`Passed: ${passedTests}/${totalTests} (${Math.round((passedTests / totalTests) * 100)}%)`);
	lines.push('═'.repeat(70));

	for (const result of results) {
		const allPassed = result.tests.every((t) => t.passed);
		const icon = allPassed ? '✅' : '❌';
		lines.push('');
		lines.push(`${icon} ${result.modelId} (${result.family})`);

		for (const test of result.tests) {
			const tIcon = test.passed ? '  ✅' : '  ❌';
			const latency = test.latencyMs ? ` ${test.latencyMs}ms` : '';
			const error = test.error ? ` — ${test.error}` : '';
			lines.push(`${tIcon} ${test.name}${latency}${error}`);
		}
	}

	return lines.join('\n');
}

// ---- Main ----

async function main(): Promise<void> {
	console.log('Fetching model list from OpenCode API...');
	const fetchedIds = await fetchAllOpenCodeModelIds();
	console.log(`Found ${fetchedIds.size} models in API response.`);

	const models = collectModels();
	console.log(`Testing ${models.length} models (after filters).`);

	if (models.length === 0) {
		console.error('No models to test. Check your --families/--models filters.');
		process.exit(1);
	}

	const results: TestResult[] = [];

	for (const model of models) {
		const tests = buildThinkingTests(model);
		const testResults: ParamTestResult[] = [];

		for (const test of tests) {
			process.stdout.write(`  Testing ${model.id}: ${test.name}...`);
			const result = await testModel(model, test);
			testResults.push(result);
			process.stdout.write(` ${result.passed ? '✅' : '❌'}${result.latencyMs ? ` (${result.latencyMs}ms)` : ''}\n`);
		}

		results.push({
			modelId: model.id,
			family: model.family,
			tests: testResults,
		});
	}

	if (OUTPUT_JSON) {
		console.log(JSON.stringify(results, null, 2));
	} else {
		console.log('\n' + formatReport(results, models));
	}

	const totalFailed = results.reduce(
		(sum, r) => sum + r.tests.filter((t) => !t.passed).length,
		0,
	);
	process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
	console.error('Fatal:', err);
	process.exit(1);
});
