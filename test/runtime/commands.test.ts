import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
    GLM_CN_CODING_API_KEY_URL,
    GLM_CN_GENERAL_API_KEY_URL,
    GLM_INTERNATIONAL_CODING_API_KEY_URL,
    GLM_INTERNATIONAL_GENERAL_API_KEY_URL,
} from '../../src/endpoint';
import { registerCommands } from '../../src/runtime/commands';
import {
    __clearConfigurationValues,
    __getOpenedExternal,
    __resetCommandState,
    __setConfigurationValue,
} from '../support/vscode.mock';

describe('runtime commands', () => {
	beforeEach(() => {
		__clearConfigurationValues();
		__resetCommandState();
	});

	it.each([
		['coding-plan', 'china', GLM_CN_CODING_API_KEY_URL],
		['standard', 'china', GLM_CN_GENERAL_API_KEY_URL],
		['coding-plan', 'international', GLM_INTERNATIONAL_CODING_API_KEY_URL],
		['standard', 'international', GLM_INTERNATIONAL_GENERAL_API_KEY_URL],
	])('opens the API key page for %s/%s', async (apiMode, region, expectedUrl) => {
		__setConfigurationValue('opencode-for-copilot.apiMode', apiMode);
		__setConfigurationValue('opencode-for-copilot.region', region);
		registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);

		await vscode.commands.executeCommand('opencode-for-copilot.getApiKey');

		expect(__getOpenedExternal()?.toString()).toBe(expectedUrl);
	});
});
