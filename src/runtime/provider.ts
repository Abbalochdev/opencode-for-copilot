import vscode from 'vscode';
import { CONFIG_SECTION } from '../consts';
import { logger } from '../logger';
import { GLMChatProvider } from '../provider';
import type { PonytailMode } from '../provider/ponytail';

export async function registerProvider(context: vscode.ExtensionContext): Promise<GLMChatProvider> {
	const provider = new GLMChatProvider(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('glm-copilot.setApiKey', () => provider.configureApiKey()),
		vscode.commands.registerCommand('glm-copilot.queryUsage', () => provider.queryUsage()),
		vscode.commands.registerCommand('glm-copilot.clearApiKey', () => provider.clearApiKey()),
		vscode.commands.registerCommand('glm-copilot.setVisionModel', () => provider.setVisionModel()),
		vscode.commands.registerCommand('glm-copilot.setPonytailMode', () => setPonytailModeCommand()),
		vscode.commands.registerCommand('glm-copilot.toggleCodeSimplifier', () => toggleCodeSimplifierCommand()),
		vscode.lm.registerLanguageModelChatProvider('glm', provider),
	);

	// Copilot Chat can serve cached model info without configurationSchema.
	// Activate it first so this refresh reaches a live listener and re-queries the provider.
	await activateCopilotChat();
	// The provider and commands are already registered above, so a failure here
	// (e.g. no active Chat view, transient API error) must not negate activation.
	try {
		provider.refreshModelPicker();
	} catch (error) {
		logger.warn('Model picker refresh failed; will retry on next chat interaction', error);
	}

	return provider;
}

async function setPonytailModeCommand(): Promise<void> {
	const modes: { label: string; mode: PonytailMode; description: string }[] = [
		{ label: 'Off', mode: 'off', description: 'No extra instruction' },
		{ label: 'Lite', mode: 'lite', description: 'Gentle reuse reminder' },
		{ label: 'Full', mode: 'full', description: 'Full Ponytail ladder (default)' },
		{ label: 'Ultra', mode: 'ultra', description: 'Aggressive minimalism' },
	];

	const current = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>('ponytailMode');
	const picked = await vscode.window.showQuickPick(
		modes.map((m) => ({
			...m,
			picked: m.mode === current,
		})),
		{ placeHolder: 'Select Ponytail verification intensity' },
	);
	if (!picked) {
		return;
	}

	await vscode.workspace
		.getConfiguration(CONFIG_SECTION)
		.update('ponytailMode', picked.mode, vscode.ConfigurationTarget.Global);
	void vscode.window.showInformationMessage(`Ponytail mode set to ${picked.label}.`);
}

async function toggleCodeSimplifierCommand(): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const current = config.get<boolean>('codeSimplifier', false);
	const next = !current;

	const answer = await vscode.window.showInformationMessage(
		next
			? 'Enable Code Simplifier? Ponytail will be lowered to Lite for compatibility.'
			: 'Disable Code Simplifier? Ponytail will return to its configured level.',
		{ modal: true },
		next ? 'Enable' : 'Disable',
	);
	if (!answer) {
		return;
	}

	await config.update('codeSimplifier', next, vscode.ConfigurationTarget.Global);
	void vscode.window.showInformationMessage(
		`Code Simplifier ${next ? 'enabled' : 'disabled'}.`,
	);
}

async function activateCopilotChat(): Promise<void> {
	try {
		await vscode.extensions.getExtension('github.copilot-chat')?.activate();
	} catch (error) {
		logger.warn('Copilot Chat activation unavailable; model picker refresh may be delayed', error);
	}
}
