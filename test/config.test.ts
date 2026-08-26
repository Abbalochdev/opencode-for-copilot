import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
    findModelDefinition,
    getApiKeyUrl,
    getApiModelId,
    getApiProtocol,
    getBaseUrl,
    getCustomModels,
    getEndpoint,
    listProviderModels,
    migrateLegacySettings,
} from '../src/config';
import { MODELS } from '../src/consts';
import {
    OPENCODE_GO_ANTHROPIC_BASE_URL,
    OPENCODE_GO_API_KEY_URL,
    OPENCODE_GO_OPENAI_BASE_URL
} from '../src/endpoint';
import { __clearConfigurationValues, __setConfigurationValue } from './support/vscode.mock';

describe('legacy settings migration (glm-copilot -> opencode-for-copilot)', () => {
	beforeEach(() => {
		__clearConfigurationValues();
	});

	it('copies user-set legacy values to the new section exactly once', async () => {
		// Simulates an upgrading user: values live in the old shared section.
		__setConfigurationValue('glm-copilot.endpoint', 'opencode-go-anthropic');
		__setConfigurationValue('glm-copilot.maxTokens', 8192);
		const store = new Map<string, unknown>();
		const context = {
			globalState: {
				get: (_key: string) => undefined,
				update: (key: string, value: unknown) => Promise.resolve(store.set(key, value)),
			},
		} as unknown as vscode.ExtensionContext;

		await migrateLegacySettings(context);

		expect(getEndpoint()).toBe('opencode-go-anthropic');
		expect(getBaseUrl()).toBe(OPENCODE_GO_ANTHROPIC_BASE_URL);
		// User-set values in the new section must never be overwritten by a
		// stale legacy value.
		expect(vscode.workspace.getConfiguration('opencode-for-copilot').get('maxTokens')).toBe(8192);
	});
});

describe('configuration helpers', () => {
	beforeEach(() => {
		__clearConfigurationValues();
	});

	it('defaults to the OpenCode Go endpoint (plan=go) when nothing is configured', () => {
		expect(getBaseUrl()).toBe(OPENCODE_GO_OPENAI_BASE_URL);
		expect(getApiKeyUrl()).toBe(OPENCODE_GO_API_KEY_URL);
	});

	it('lets non-empty baseUrl override the endpoint preset', () => {
		__setConfigurationValue('opencode-for-copilot.endpoint', 'opencode-zen');
		__setConfigurationValue('opencode-for-copilot.baseUrl', 'https://proxy.example.com/v1');

		expect(getBaseUrl()).toBe('https://proxy.example.com/v1');
	});
});

describe('endpoint preset selection', () => {
	beforeEach(() => {
		__clearConfigurationValues();
	});

	it('defaults to opencode-go when nothing is configured', () => {
		expect(getEndpoint()).toBe('opencode-go');
		expect(getBaseUrl()).toBe(OPENCODE_GO_OPENAI_BASE_URL);
		expect(getApiProtocol()).toBe('openai');
		expect(getApiKeyUrl()).toBe(OPENCODE_GO_API_KEY_URL);
	});

	it('respects an explicit endpoint preset', () => {
		__setConfigurationValue('opencode-for-copilot.endpoint', 'opencode-zen-anthropic');

		expect(getEndpoint()).toBe('opencode-zen-anthropic');
		expect(getApiProtocol()).toBe('anthropic');
	});

	it('ignores unknown preset values and falls back to opencode-go', () => {
		// Presets removed with the Zhipu/Z.ai endpoint layer must not crash
		// users who still carry them in settings.json.
		__setConfigurationValue('opencode-for-copilot.endpoint', 'china-coding');

		expect(getEndpoint()).toBe('opencode-go');
		expect(getBaseUrl()).toBe(OPENCODE_GO_OPENAI_BASE_URL);
	});

	it('resolves the opencode-go preset to the OpenCode Go OpenAI endpoint', () => {
		__setConfigurationValue('opencode-for-copilot.endpoint', 'opencode-go');

		expect(getEndpoint()).toBe('opencode-go');
		expect(getBaseUrl()).toBe(OPENCODE_GO_OPENAI_BASE_URL);
		expect(getApiProtocol()).toBe('openai');
		expect(getApiKeyUrl()).toBe(OPENCODE_GO_API_KEY_URL);
	});

	it('resolves the opencode-go-anthropic preset to the OpenCode Go Anthropic endpoint', () => {
		__setConfigurationValue('opencode-for-copilot.endpoint', 'opencode-go-anthropic');

		expect(getEndpoint()).toBe('opencode-go-anthropic');
		expect(getBaseUrl()).toBe(OPENCODE_GO_ANTHROPIC_BASE_URL);
		expect(getApiProtocol()).toBe('anthropic');
		expect(getApiKeyUrl()).toBe(OPENCODE_GO_API_KEY_URL);
	});

	it('legacy apiProtocol=anthropic still wins when endpoint is unset', () => {
		// Pre-3.10 escape hatch for custom-baseUrl users; nothing contributes
		// this setting anymore but an existing value keeps working.
		__setConfigurationValue('opencode-for-copilot.apiProtocol', 'anthropic');

		expect(getApiProtocol()).toBe('anthropic');
	});

	it('normalizes custom model strings and objects', () => {
		__setConfigurationValue('opencode-for-copilot.customModels', [
			' team-coder ',
			{
				id: ' custom-no-tools ',
				name: ' Custom No Tools ',
				maxInputTokens: 123.9,
				maxOutputTokens: 456,
				toolCalling: false,
				thinking: false,
			},
			{ id: '   ' },
			123,
		]);

		const models = getCustomModels();

		expect(models).toHaveLength(2);
		expect(models[0]).toMatchObject({
			id: 'team-coder',
			name: 'team-coder',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: {
				toolCalling: true,
				imageInput: true,
				thinking: true,
			},
			requiresThinkingParam: true,
		});
		expect(models[1]).toMatchObject({
			id: 'custom-no-tools',
			name: 'Custom No Tools',
			maxInputTokens: 123,
			maxOutputTokens: 456,
			capabilities: {
				toolCalling: false,
				imageInput: true,
				thinking: false,
			},
			requiresThinkingParam: false,
		});
	});

	it('lets custom model IDs override built-in model lookup and picker registry', () => {
		__setConfigurationValue('opencode-for-copilot.customModels', [
			{
				id: 'glm-5.2',
				name: 'Local GLM-5.2',
				maxInputTokens: 42,
				thinking: false,
			},
		]);

		const models = listProviderModels();

		expect(models).toHaveLength(MODELS.length);
		expect(findModelDefinition('glm-5.2')).toMatchObject({
			id: 'glm-5.2',
			name: 'Local GLM-5.2',
			maxInputTokens: 42,
			capabilities: {
				imageInput: true,
				thinking: false,
			},
		});
	});

	it('supports modelIdOverrides for arbitrary built-in or custom model IDs', () => {
		__setConfigurationValue('opencode-for-copilot.modelIdOverrides', {
			'glm-5.2': 'upstream-glm-5.2',
			'team-coder': 'provider-team-coder',
			empty: '   ',
		});

		expect(getApiModelId('glm-5.2')).toBe('upstream-glm-5.2');
		expect(getApiModelId('team-coder')).toBe('provider-team-coder');
		expect(getApiModelId('empty')).toBe('empty');
		expect(getApiModelId('unknown')).toBe('unknown');
	});
});
