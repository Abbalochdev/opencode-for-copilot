import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { listProviderModels } from '../../src/config';
import { MODELS } from '../../src/consts';
import {
	getConfiguredThinkingEffort,
	toChatInfo,
} from '../../src/provider/models';
import { findModelsDevEntry, invalidateModelsDevCache, mergeWithModelsDev, type ModelsDevModel } from '../../src/provider/models-dev';
import {
	displayNameFromId,
	getDynamicModels,
	invalidateModelCache,
} from '../../src/provider/opencode-models';
import { __clearConfigurationValues, __setConfigurationValue } from '../support/vscode.mock';

describe('displayNameFromId (generic placeholder until models.dev enrichment)', () => {
	it('title-cases words and joins version segments', () => {
		// Official casing (DeepSeek, MiMo, …) comes from the models.dev merge;
		// this generator only needs stable, readable placeholders.
		expect(displayNameFromId('claude-opus-4-8')).toBe('Claude Opus 4.8');
		expect(displayNameFromId('glm-5.3')).toBe('Glm 5.3');
		expect(displayNameFromId('qwen3.8-max')).toBe('Qwen3.8 Max');
		expect(displayNameFromId('mimo-v2.5')).toBe('Mimo V2.5');
		expect(displayNameFromId('nemotron-3.5-lightning-free')).toBe(
			'Nemotron 3.5 Lightning Free',
		);
	});
});

describe('offline fallback baseline', () => {
	beforeEach(() => {
		__clearConfigurationValues();
	});

	it('ships four models covering every plan and wire protocol', () => {
		// Minimal offline set used before the first catalog fetch (or if both
		// /models endpoints become unreachable). Live catalog always extends it.
		const models = listProviderModels();

		expect(models.map((m) => m.id)).toEqual([
			'glm-5.2', // Go · OpenAI
			'minimax-m3', // Go · Anthropic
			'claude-sonnet-4-5', // Zen · Anthropic
			'deepseek-v4-flash-free', // Zen · OpenAI (free — works with zero balance)
		]);
		const presets = models.map((m) => m.endpointPreset ?? '');
		expect(presets.some((p) => p.startsWith('opencode-go'))).toBe(true);
		expect(presets.some((p) => p.startsWith('opencode-zen'))).toBe(true);
	});

	it('serves the whole baseline regardless of endpoint preset', () => {
		__setConfigurationValue('opencode-for-copilot.endpoint', 'opencode-go');
		const infos = listProviderModels().map((m) => toChatInfo(m, true));
		expect(infos.every((m) => m.isUserSelectable)).toBe(true);
	});
});

describe('dual catalog pipeline (real captured IDs)', () => {
	const GO_IDS = [
		'minimax-m3', 'minimax-m2.7', 'minimax-m2.5', 'kimi-k3', 'kimi-k2.7-code',
		'kimi-k2.6', 'longcat-2.0', 'kimi-k2.5', 'glm-5.2', 'glm-5.3', 'ox-alpha-free',
		'glm-5.1', 'glm-5', 'deepseek-v4-pro', 'deepseek-v4-flash',
		'deepseek-v4-flash-vision-exp', 'qwen3.7-max', 'qwen3.8-max', 'qwen3.7-plus',
		'qwen3.6-plus', 'qwen3.5-plus', 'mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2.5-pro',
		'mimo-v2.5', 'hy3', 'hy3-preview', 'gpt-5.6-luna', 'grok-4.5',
		'muse-spark-1.2-contributor',
	];
	const ZEN_ONLY_IDS = ['claude-fable-5', 'claude-opus-5', 'big-pickle'];
	// Fallback entries absent from both fetched sets must survive the merge.
	const FALLBACK_ONLY_IDS = ['claude-sonnet-4-5', 'deepseek-v4-flash-free'];

	it('merges both catalogs; unknown IDs pin to the catalog they came from', async () => {
		const realFetch = globalThis.fetch;
		// Serve both model endpoints; fail everything else (models.dev) so
		// enrichment stays a no-op.
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes('/zen/go/v1/models')) {
				return new Response(JSON.stringify({ data: GO_IDS.map((id) => ({ id })) }));
			}
			if (url.includes('/zen/v1/models')) {
				return new Response(JSON.stringify({ data: ZEN_ONLY_IDS.map((id) => ({ id })) }));
			}
			throw new Error('offline');
		}) as typeof fetch;

		try {
			invalidateModelCache();
			invalidateModelsDevCache();
			const models = await getDynamicModels([], MODELS);

			// Both catalogs merge, plus the two copilot-utility models and the
			// fallback entries missing from the captured sets.
			expect(models.length).toBe(
				GO_IDS.length + ZEN_ONLY_IDS.length + FALLBACK_ONLY_IDS.length + 2,
			);
			for (const id of FALLBACK_ONLY_IDS) {
				expect(models.some((m) => m.id === id)).toBe(true);
			}
			// Catalog-only newcomers surface as selectable picker entries.
			const luna = models.find((m) => m.id === 'gpt-5.6-luna');
			expect(luna?.endpointPreset).toBe('opencode-go-responses');
			expect(luna?.name).toContain('Luna');
			// Zen-only newcomer: known IDs keep their overlay pin (Claude is
			// Anthropic-style), unknown IDs get a plain zen pin.
			const fable = models.find((m) => m.id === 'claude-fable-5');
			expect(fable?.endpointPreset?.startsWith('opencode-zen')).toBe(true);
			// …and known IDs keep their overlay pin (Claude is Anthropic-style).
			const opus = models.find((m) => m.id === 'claude-opus-5');
			expect(opus?.endpointPreset).toBe('opencode-zen-anthropic');
		} finally {
			globalThis.fetch = realFetch;
			invalidateModelCache();
			invalidateModelsDevCache();
		}
	});

	it('falls back to the static list only when BOTH catalogs are unreachable', async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () => {
			throw new Error('offline');
		}) as typeof fetch;

		try {
			invalidateModelCache();
			invalidateModelsDevCache();
			const models = await getDynamicModels([], MODELS);

			expect(models.map((m) => m.id)).toEqual(MODELS.map((m) => m.id));
		} finally {
			globalThis.fetch = realFetch;
			invalidateModelCache();
			invalidateModelsDevCache();
		}
	});
});

describe('model metadata helpers', () => {
	beforeEach(() => {
		__clearConfigurationValues();
	});

	it('normalizes configured thinking effort aliases', () => {
		expect(
			getConfiguredThinkingEffort({
				modelConfiguration: { reasoningEffort: 'disabled' },
			}),
		).toBe('none');
		expect(
			getConfiguredThinkingEffort({
				configuration: { thinking_effort: 'balanced' },
			}),
		).toBe('high');
		expect(
			getConfiguredThinkingEffort({
				modelConfiguration: { thinkingEffort: 'deep' },
			}),
		).toBe('max');
	});

	it('defaults thinking effort to max when no valid value is configured', () => {
		expect(getConfiguredThinkingEffort({})).toBe('max');
		expect(
			getConfiguredThinkingEffort({
				modelConfiguration: { reasoningEffort: 'surprise' },
			}),
		).toBe('max');
	});

	it('shows locked model metadata before an API key is configured', () => {
		const info = toChatInfo(MODELS[0], false, 'CNY');

		expect(info.statusIcon).toBeInstanceOf(vscode.ThemeIcon);
		expect(info.statusIcon?.id).toBe('warning');
		expect(info.detail).toBe('Please run OpenCode: Set API Key to configure.');
		expect(info.tooltip).toBe('Please run OpenCode: Set API Key to configure.');
		expect(info.isBYOK).toBe(true);
		expect(info.isUserSelectable).toBe(true);
	});

	it('hides models.dev-deprecated models from the picker', () => {
		const info = toChatInfo({ ...MODELS[0], deprecated: true }, true, 'USD');

		expect(info.isUserSelectable).toBe(false);
		expect(info.statusIcon?.id).toBe('warning');
		expect(info.detail).toBe(
			'Deprecated by the provider — kept for existing chats; pick another model.',
		);
	});

	it('prefixes picker names with the go/zen billing path', () => {
		const infos = listProviderModels().map((model) => toChatInfo(model, true, 'USD'));
		const byId = new Map(infos.map((info) => [info.id, info]));

		// Go-billing models carry the `go/` prefix...
		const goModel = MODELS.find((m) => m.endpointPreset?.startsWith('opencode-go'))!;
		expect(byId.get(goModel.id)?.name).toBe(`go/${goModel.name}`);
		// ...Zen-billing models the `zen/` prefix.
		const zenModel = MODELS.find((m) => m.endpointPreset?.startsWith('opencode-zen'))!;
		expect(byId.get(zenModel.id)?.name).toBe(`zen/${zenModel.name}`);
	});

	it('leaves custom models without an endpoint pin unprefixed', () => {
		__setConfigurationValue('opencode-for-copilot.customModels', ['team-coder']);

		const info = listProviderModels()
			.map((model) => toChatInfo(model, true, 'USD'))
			.find((entry) => entry.id === 'team-coder');

		expect(info?.name).toBe('team-coder');
	});

	it('reports capabilities, thinking configuration, and price metadata when unlocked', () => {
		const info = toChatInfo(MODELS[0], true, 'USD');

		expect(info.statusIcon).toBeUndefined();
		expect(info.capabilities).toEqual({
			toolCalling: MODELS[0].capabilities.toolCalling,
			imageInput: true,
		});
		expect(info.configurationSchema?.properties.reasoningEffort.default).toBe('max');
		expect(info.inputCost).toBe(1.4);
		expect(info.outputCost).toBe(4.4);
		expect(info.cacheCost).toBe(0.26);
		expect(info.priceCategory).toBe('high');
	});

	it('includes custom models in picker metadata with Vision Proxy image support', () => {
		__setConfigurationValue('opencode-for-copilot.customModels', [
			'team-coder',
			{ id: 'no-thinking', thinking: false },
		]);

		const infos = listProviderModels().map((model) => toChatInfo(model, true, 'USD'));
		const custom = infos.find((info) => info.id === 'team-coder');
		const noThinking = infos.find((info) => info.id === 'no-thinking');

		expect(infos.map((info) => info.id)).toEqual([
			...MODELS.map((model) => model.id),
			'team-coder',
			'no-thinking',
		]);
		expect(custom).toMatchObject({
			id: 'team-coder',
			name: 'team-coder',
			detail: 'Custom GLM-compatible model',
			capabilities: {
				toolCalling: true,
				imageInput: true,
			},
		});
		expect(custom?.configurationSchema?.properties.reasoningEffort.default).toBe('max');
		expect(noThinking?.capabilities.imageInput).toBe(true);
		expect(noThinking?.configurationSchema).toBeUndefined();
	});
});

describe('findModelsDevEntry', () => {
	it('matches a bare ID keyed directly by models.dev', () => {
		const snapshot = new Map([
			['deepseek/deepseek-v4-flash', { id: 'deepseek/deepseek-v4-flash', limit: { context: 1_000_000 } }],
		]);
		expect(findModelsDevEntry(snapshot, 'deepseek-v4-flash')?.limit?.context).toBe(1_000_000);
	});

	it('matches a provider-prefixed models.dev id field', () => {
		const snapshot = new Map([
			['deepseek-v4-flash', { id: 'deepseek/deepseek-v4-flash', limit: { context: 1_000_000 } }],
		]);
		expect(findModelsDevEntry(snapshot, 'deepseek-v4-flash')?.limit?.context).toBe(1_000_000);
	});

	it('prefers the shallowest provider path over mirrors with the same id', () => {
		const snapshot = new Map<string, ModelsDevModel>([
			['nvidia/deepseek-ai/deepseek-v4-flash', { id: 'nvidia/deepseek-ai/deepseek-v4-flash', limit: { context: 200_000 } }],
			['deepseek/deepseek-v4-flash', { id: 'deepseek/deepseek-v4-flash', limit: { context: 1_000_000 } }],
		]);
		expect(findModelsDevEntry(snapshot, 'deepseek-v4-flash')?.limit?.context).toBe(1_000_000);
	});

	it('rejects near-miss ids (case/suffix differences)', () => {
		const snapshot = new Map<string, ModelsDevModel>([
			['baseten/deepseek-ai/DeepSeek-V4-Flash-0731', { id: 'baseten/deepseek-ai/DeepSeek-V4-Flash-0731' }],
			['nvidia/deepseek-ai/DeepSeek-V4-Flash-0731', { id: 'nvidia/deepseek-ai/DeepSeek-V4-Flash-0731' }],
		]);
		expect(findModelsDevEntry(snapshot, 'deepseek-v4-flash')).toBeUndefined();
	});

	it('matches the opencode-gateway free tier id', () => {
		const snapshot = new Map<string, ModelsDevModel>([
			['opencode/deepseek-v4-flash-free', { id: 'opencode/deepseek-v4-flash-free', limit: { context: 1_000_000 } }],
		]);
		expect(findModelsDevEntry(snapshot, 'deepseek-v4-flash-free')?.limit?.context).toBe(1_000_000);
	});

	it('returns undefined for an unmatched ID (overlay wins unchanged)', () => {
		const snapshot = new Map<string, ModelsDevModel>([
			['glm-5.2', { id: 'glm/glm-5.2', limit: { context: 1_000_000 } }],
		]);
		expect(findModelsDevEntry(snapshot, 'deepseek-v4-flash')).toBeUndefined();
	});
});

describe('mergeWithModelsDev', () => {
	const base: Parameters<typeof mergeWithModelsDev>[0] = {
		id: 'deepseek-v4-flash',
		name: 'DeepSeek V4 Flash',
		family: 'deepseek',
		version: 'v4-flash',
		detail: 'Fast and economical coding model',
		maxInputTokens: 128_000,
		maxOutputTokens: 131_072,
		capabilities: { toolCalling: true, imageInput: true, thinking: false },
		requiresThinkingParam: false,
		endpointPreset: 'opencode-go',
		priceCategory: 'low',
	};

	it('keeps the short overlay detail (no paragraph text in the picker)', () => {
		const merged = mergeWithModelsDev(base, {
			id: 'deepseek/deepseek-v4-flash',
			description: 'DeepSeek V4 Flash is a fast, economical coding model with a very long description that would wrap into a paragraph in the model picker.',
			limit: { context: 1_000_000, output: 384_000 },
		});
		expect(merged.detail).toBe('Fast and economical coding model');
		expect(merged.maxInputTokens).toBe(1_000_000);
		expect(merged.maxOutputTokens).toBe(384_000);
	});

	it('never surfaces the models.dev paragraph description as the picker detail', () => {
		const merged = mergeWithModelsDev({ ...base, detail: '' }, {
			id: 'deepseek/deepseek-v4-flash',
			description: 'Fallback description text that would wrap into a paragraph in the picker',
		});
		expect(merged.detail).toBe('');
	});
});
