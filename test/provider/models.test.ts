import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { listProviderModels } from '../../src/config';
import { MODELS } from '../../src/consts';
import { getConfiguredThinkingEffort, toChatInfo } from '../../src/provider/models';
import { findModelsDevEntry, mergeWithModelsDev, type ModelsDevModel } from '../../src/provider/models-dev';
import { __clearConfigurationValues, __setConfigurationValue } from '../support/vscode.mock';

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

	it('reports capabilities, thinking configuration, and price metadata when unlocked', () => {
		const info = toChatInfo(MODELS[0], true, 'CNY');

		expect(info.statusIcon).toBeUndefined();
		expect(info.capabilities).toEqual({
			toolCalling: MODELS[0].capabilities.toolCalling,
			imageInput: true,
		});
		expect(info.configurationSchema?.properties.reasoningEffort.default).toBe('max');
		expect(info.inputCost).toBe(8);
		expect(info.outputCost).toBe(28);
		expect(info.cacheCost).toBe(2);
		expect(info.priceCategory).toBe('high');
	});

	it('includes custom models in picker metadata with Vision Proxy image support', () => {
		__setConfigurationValue('glm-copilot.customModels', [
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

	it('uses the models.dev description only when the overlay has no detail', () => {
		const merged = mergeWithModelsDev({ ...base, detail: '' }, {
			id: 'deepseek/deepseek-v4-flash',
			description: 'Fallback description text',
		});
		expect(merged.detail).toBe('Fallback description text');
	});
});
