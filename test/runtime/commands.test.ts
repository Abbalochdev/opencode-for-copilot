import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import {
    OPENCODE_GO_API_KEY_URL,
    OPENCODE_ZEN_API_KEY_URL,
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
		['go', OPENCODE_GO_API_KEY_URL],
		['zen', OPENCODE_ZEN_API_KEY_URL],
	])('opens the API key page for the %s plan', async (plan, expectedUrl) => {
		__setConfigurationValue('opencode-for-copilot.opencodePlan', plan);
		registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);

		await vscode.commands.executeCommand('opencode-for-copilot.getApiKey');

		expect(__getOpenedExternal()?.toString()).toBe(expectedUrl);
	});
});
