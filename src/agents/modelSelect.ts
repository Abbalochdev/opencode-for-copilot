import * as vscode from 'vscode';
import type { ModelRef } from './types';

/**
 * Selects a specific model programmatically, independent of whatever the
 * user currently has picked in the Copilot Chat model picker. This is the
 * mechanism that lets different pipeline stages run on different models
 * in the same run.
 */
export async function pickModel(ref: ModelRef): Promise<vscode.LanguageModelChat> {
	const models = ref.id
		? await vscode.lm.selectChatModels({ vendor: ref.vendor, id: ref.id })
		: await vscode.lm.selectChatModels({ vendor: ref.vendor, family: ref.family });
	if (models.length === 0) {
		throw new Error(
			`No model found for vendor="${ref.vendor}" family="${ref.family}"${ref.id ? ` id="${ref.id}"` : ''}. `
			+ 'Check opencode-for-copilot.modelIdOverrides for the exact id string this model registers under.',
		);
	}
	return models[0];
}

/** Text parts of a tool result — everything else (tsx, data) is dropped. */
export function resultToTextParts(result: vscode.LanguageModelToolResult): vscode.LanguageModelTextPart[] {
	return result.content.filter(
		(part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart,
	);
}

/** Flat text of a tool result. */
export function resultToText(result: vscode.LanguageModelToolResult): string {
	return resultToTextParts(result).map((part) => part.value).join('\n');
}
