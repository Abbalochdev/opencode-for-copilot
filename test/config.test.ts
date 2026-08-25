import * as vscode from 'vscode';
import { beforeEach, describe, expect, it } from 'vitest';
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
	OPENCODE_GO_OPENAI_BASE_URL,
	OPENCODE_ZEN_ANTHROPIC_BASE_URL,
	OPENCODE_ZEN_API_KEY_URL,
	OPENCODE_ZEN_OPENAI_BASE_URL,
} from '../src/endpoint';
import { __clearConfigurationValues, __setConfigurationValue } from './support/vscode.mock';

describe('legacy settings migration (glm-copilot -> opencode-for-copilot)', () => {
	beforeEach(() => {
		__clearConfigurationValues();
	});

	it('copies user-set legacy values to the new section exactly once', async () => {
		__setConfigurationValue('glm-copilot.endpoint', 'china-anthropic');
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
		__setConfigurationValue('opencode-for-copilot.endpoint', 'opencode-zen-anthropic');
		__setConfigurationValue('opencode-for-copilot.baseUrl', 'https://proxy.example.com/v1');

		expect(getBaseUrl()).toBe('https://proxy.example.com/v1');
	});
});

describe('endpoint preset selection', () => {
	beforeEach(() => {
		__clearConfigurationValues();
	});

	it('defaults to opencode-go when nothing is configured (plan default)', () => {
		expect(getEndpoint()).toBe('opencode-go');
		expect(getBaseUrl()).toBe(OPENCODE_GO_OPENAI_BASE_URL);
		expect(getApiProtocol()).toBe('openai');
		expect(getApiKeyUrl()).toBe(OPENCODE_GO_API_KEY_URL);
	});

	it('defaults to opencode-zen when opencodePlan is zen', () => {
		__setConfigurationValue('opencode-for-copilot.opencodePlan', 'zen');

		expect(getEndpoint()).toBe('opencode-zen');
		expect(getBaseUrl()).toBe(OPENCODE_ZEN_OPENAI_BASE_URL);
	});

	it('migrates legacy china-anthropic preset to OpenCode Go Anthropic', () => {
		__setConfigurationValue('opencode-for-copilot.endpoint', 'china-anthropic');

		expect(getEndpoint()).toBe('opencode-go-anthropic');
		expect(getBaseUrl()).toBe(OPENCODE_GO_ANTHROPIC_BASE_URL);
		expect(getApiProtocol()).toBe('anthropic');
	});

	it('migrates legacy international-coding preset to OpenCode Zen', () => {
		__setConfigurationValue('opencode-for-copilot.endpoint', 'international-coding');

		expect(getEndpoint()).toBe('opencode-zen');
		expect(getBaseUrl()).toBe(OPENCODE_ZEN_OPENAI_BASE_URL);
		expect(getApiProtocol()).toBe('openai');
		expect(getApiKeyUrl()).toBe(OPENCODE_ZEN_API_KEY_URL);
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

	it('resolves the opencode-zen-anthropic preset', () => {
		__setConfigurationValue('opencode-for-copilot.endpoint', 'opencode-zen-anthropic');

		expect(getEndpoint()).toBe('opencode-zen-anthropic');
		expect(getBaseUrl()).toBe(OPENCODE_ZEN_ANTHROPIC_BASE_URL);
		expect(getApiProtocol()).toBe('anthropic');
		expect(getApiKeyUrl()).toBe(OPENCODE_ZEN_API_KEY_URL);
	});

	it('uses legacy apiProtocol=anthropic when endpoint is unset', () => {
		__setConfigurationValue('opencode-for-copilot.apiProtocol', 'anthropic');

		expect(getEndpoint()).toBe('opencode-go-anthropic');
		expect(getBaseUrl()).toBe(OPENCODE_GO_ANTHROPIC_BASE_URL);
		expect(getApiProtocol()).toBe('anthropic');
	});

	it('uses zen anthropic preset when plan is zen and apiProtocol=anthropic', () => {
		__setConfigurationValue('opencode-for-copilot.opencodePlan', 'zen');
		__setConfigurationValue('opencode-for-copilot.apiProtocol', 'anthropic');

		expect(getEndpoint()).toBe('opencode-zen-anthropic');
		expect(getBaseUrl()).toBe(OPENCODE_ZEN_ANTHROPIC_BASE_URL);
	});

	it('endpoint preset takes precedence over legacy apiProtocol', () => {
		__setConfigurationValue('opencode-for-copilot.endpoint', 'opencode-go');
		__setConfigurationValue('opencode-for-copilot.apiProtocol', 'anthropic');

		expect(getEndpoint()).toBe('opencode-go');
		expect(getBaseUrl()).toBe(OPENCODE_GO_OPENAI_BASE_URL);
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
		});
		expect(models[1]).toMatchObject({
			id: 'custom-no-tools',
			name: 'Custom No Tools',
			maxInputTokens: 123,
			maxOutputTokens: 456,
			capabilities: {
				toolCalling: false,
				thinking: false,
			},
		});
	});
});

describe('model registry helpers', () => {
	beforeEach(() => {
		__clearConfigurationValues();
	});

	it('finds built-in models by id', () => {
		const model = findModelDefinition('glm-5.2');
		expect(model).toBeDefined();
		expect(model?.id).toBe('glm-5.2');
	});

	it('lists provider models including custom models', () => {
		__setConfigurationValue('opencode-for-copilot.customModels', ['team-coder']);

		const models = listProviderModels();
		expect(models.some((m) => m.id === 'team-coder')).toBe(true);
		expect(models.length).toBeGreaterThanOrEqual(MODELS.length);
	});

	it('applies modelIdOverrides for API model IDs', () => {
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
