import vscode from 'vscode';
import { getApiKeyUrl } from '../config';
import { t } from '../i18n';
import { logger } from '../logger';
import { ensureRequestDumpRoot } from '../provider/debug';
import { buildRuntimeDiagnosticsReport } from './diagnostics';

export function registerCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('opencode-for-copilot.showLogs', () => logger.show()),
		vscode.commands.registerCommand('opencode-for-copilot.showDiagnostics', () =>
			showRuntimeDiagnostics(context),
		),
		vscode.commands.registerCommand('opencode-for-copilot.openRequestDumpsFolder', () =>
			openRequestDumpsFolder(context),
		),
		vscode.commands.registerCommand('opencode-for-copilot.getApiKey', () =>
			vscode.env.openExternal(vscode.Uri.parse(getApiKeyUrl())),
		),
		vscode.commands.registerCommand('opencode-for-copilot.openSettings', () =>
			vscode.commands.executeCommand('workbench.action.openSettings', 'opencode-for-copilot'),
		),
	);
}

async function openRequestDumpsFolder(context: vscode.ExtensionContext): Promise<void> {
	try {
		const root = await ensureRequestDumpRoot(context.globalStorageUri);
		logger.info(`Opening request dumps folder: ${root.toString(true)}`);
		await vscode.commands.executeCommand('revealFileInOS', root);
	} catch (error) {
		logger.warn('Failed to open request dumps folder', error);
		void vscode.window.showErrorMessage(t('extension.openRequestDumpsFolderFailed'));
	}
}

/** Open the runtime-diagnostics report as an untitled markdown document. */
async function showRuntimeDiagnostics(context: vscode.ExtensionContext): Promise<void> {
	const doc = await vscode.workspace.openTextDocument({
		language: 'markdown',
		content: buildRuntimeDiagnosticsReport(context),
	});
	await vscode.window.showTextDocument(doc, { preview: true });
}
