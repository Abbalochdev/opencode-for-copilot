import { beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import type { AuthManager } from '../../src/auth';
import { createCacheDiagnosticsRecorder } from '../../src/provider/debug';
import { prepareChatRequest } from '../../src/provider/request';
import type { RequestKind } from '../../src/provider/routing';
import type { ConversationSegment } from '../../src/provider/segment';
import { __clearConfigurationValues, __setConfigurationValue } from '../support/vscode.mock';

const token = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
} as vscode.CancellationToken;

const segment: ConversationSegment = { segmentId: 'segment-1', reason: 'markerMissing' };

function userMessage(text: string): vscode.LanguageModelChatRequestMessage {
	return {
		role: vscode.LanguageModelChatMessageRole.User,
		content: [new vscode.LanguageModelTextPart(text)],
	} as vscode.LanguageModelChatRequestMessage;
}

async function prepare(requestKind: RequestKind) {
	return prepareChatRequest({
		authManager: { getApiKey: async () => 'test-key' } as unknown as AuthManager,
		globalStorageUri: vscode.Uri.file('/tmp/glm-sysinstr-test'),
		modelInfo: { id: 'glm-5.2' } as vscode.LanguageModelChatInformation,
		segment,
		messages: [userMessage('Refactor this function')],
		options: {} as vscode.ProvideLanguageModelChatResponseOptions,
		token,
		cacheDiagnostics: createCacheDiagnosticsRecorder(),
		getVisionDescriber: async () => undefined,
		requestKind,
	});
}

function systemContent(prepared: Awaited<ReturnType<typeof prepare>>): string {
	return prepared.request.messages
		.filter((m) => m.role === 'system')
		.map((m) => m.content)
		.join('\n');
}

describe('system instruction injection (Ponytail + Code Simplifier)', () => {
	beforeEach(() => {
		__clearConfigurationValues();
	});

	it('injects Ponytail into a real coding chat (main-agent)', async () => {
		__setConfigurationValue('glm-copilot.ponytailMode', 'full');
		const prepared = await prepare('main-agent');
		expect(systemContent(prepared)).toContain('lazy senior developer');
	});

	it('injects Ponytail into background coding chats', async () => {
		__setConfigurationValue('glm-copilot.ponytailMode', 'full');
		const prepared = await prepare('background');
		expect(systemContent(prepared)).toContain('lazy senior developer');
	});

	it('injects Code Simplifier into coding chats when enabled', async () => {
		__setConfigurationValue('glm-copilot.ponytailMode', 'off');
		__setConfigurationValue('glm-copilot.codeSimplifier', true);
		const prepared = await prepare('main-agent');
		expect(systemContent(prepared)).toContain('CODE SIMPLIFIER');
	});

	it('injects BOTH Ponytail and Code Simplifier together on coding chats', async () => {
		__setConfigurationValue('glm-copilot.ponytailMode', 'full');
		__setConfigurationValue('glm-copilot.codeSimplifier', true);
		const prepared = await prepare('main-agent');
		const content = systemContent(prepared);
		expect(content).toContain('lazy senior developer');
		expect(content).toContain('CODE SIMPLIFIER');
	});

	it('does NOT inject Ponytail into utility chats (chat-title)', async () => {
		__setConfigurationValue('glm-copilot.ponytailMode', 'full');
		const prepared = await prepare('chat-title');
		expect(systemContent(prepared)).not.toContain('lazy senior developer');
	});

	it('does NOT inject Code Simplifier into utility chats even when enabled', async () => {
		__setConfigurationValue('glm-copilot.codeSimplifier', true);
		const prepared = await prepare('git-commit-message');
		expect(systemContent(prepared)).not.toContain('CODE SIMPLIFIER');
	});

	it('does NOT inject Ponytail when mode is off, even on coding chats', async () => {
		__setConfigurationValue('glm-copilot.ponytailMode', 'off');
		const prepared = await prepare('main-agent');
		expect(systemContent(prepared)).not.toContain('lazy senior developer');
	});

	it('injects USER RULES into a coding chat when rules are set', async () => {
		__setConfigurationValue('glm-copilot.ponytailMode', 'off');
		__setConfigurationValue('glm-copilot.rules', ['Always TypeScript', 'Be concise']);
		const prepared = await prepare('main-agent');
		const content = systemContent(prepared);
		expect(content).toContain('### USER RULES');
		expect(content).toContain('- Always TypeScript');
		expect(content).toContain('- Be concise');
	});

	it('does NOT inject USER RULES into utility chats even when rules are set', async () => {
		__setConfigurationValue('glm-copilot.rules', ['Always TypeScript']);
		const prepared = await prepare('chat-title');
		expect(systemContent(prepared)).not.toContain('USER RULES');
	});

	it('stacks USER RULES under Ponytail and Code Simplifier (priority order)', async () => {
		__setConfigurationValue('glm-copilot.ponytailMode', 'full');
		__setConfigurationValue('glm-copilot.codeSimplifier', true);
		__setConfigurationValue('glm-copilot.rules', ['Always TypeScript']);
		const content = systemContent(await prepare('main-agent'));
		const simplifierIdx = content.indexOf('CODE SIMPLIFIER');
		const ponytailIdx = content.indexOf('PONYTAIL');
		const rulesIdx = content.indexOf('USER RULES');
		expect(simplifierIdx).toBeGreaterThan(-1);
		expect(ponytailIdx).toBeGreaterThan(simplifierIdx);
		expect(rulesIdx).toBeGreaterThan(ponytailIdx);
	});

	it('drops empty rules entries and does not inject an empty block', async () => {
		__setConfigurationValue('glm-copilot.ponytailMode', 'off');
		__setConfigurationValue('glm-copilot.rules', ['   ', '']);
		const prepared = await prepare('main-agent');
		expect(systemContent(prepared)).not.toContain('USER RULES');
	});
});
