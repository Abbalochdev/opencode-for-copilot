import { execFileSync } from 'node:child_process';
import vscode from 'vscode';
import {
	getApiProtocol,
	getBaseUrl,
	getCodeSimplifierEnabled,
	getDebugMode,
	getEndpoint,
	getOpencodePlan,
	getPonytailMode,
} from '../config';
import { CONFIG_SECTION } from '../consts';
import { logger } from '../logger';

export async function initializeDiagnostics(context: vscode.ExtensionContext): Promise<void> {
	logger.info(
		`Activating extension version=${context.extension.packageJSON.version}` +
			` vscode=${vscode.version}` +
			` extensionKind=${context.extension.extensionKind}` +
			` remoteName=${vscode.env.remoteName ?? 'none'}` +
			` uiKind=${vscode.env.uiKind}` +
			` platform=${process.platform}` +
			` arch=${process.arch}` +
			` debugMode=${getDebugMode()}`,
	);

	let currentDebugMode = getDebugMode();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(`${CONFIG_SECTION}.debugMode`)) {
				const previous = currentDebugMode;
				currentDebugMode = getDebugMode();
				logger.info(`debugMode changed: ${previous} -> ${currentDebugMode}`);
			}
		}),
	);
}

/**
 * Build a markdown runtime-diagnostics report for bug reports.
 *
 * Ported from the opencode-copilot-chat fork's `runtimeDiagnostics.ts` and
 * adapted to this extension's config surface. Privacy-safe: never includes
 * the API key, request payloads, or prompt content.
 */
export function buildRuntimeDiagnosticsReport(context: vscode.ExtensionContext): string {
	const lines = [
		'# OpenCode for Copilot — Runtime Diagnostics',
		'',
		'## Environment',
		`- Extension version: ${stringValue(context.extension.packageJSON?.version, 'unknown')}`,
		`- VS Code version: ${vscode.version}`,
		`- App host: ${vscode.env.appHost}`,
		`- Remote: ${vscode.env.remoteName ?? 'local'}`,
		`- UI kind: ${vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop'}`,
		`- Extension mode: ${extensionModeLabel(context.extensionMode)}`,
		`- Workspace trusted: ${vscode.workspace.isTrusted}`,
		`- Platform: ${process.platform} (${process.arch})`,
		`- Node: ${process.version}`,
		`- Windows integrity: ${windowsIntegrityLevel()}`,
		'',
		'## Configuration',
		`- Endpoint preset: ${getEndpoint()}`,
		`- OpenCode plan: ${getOpencodePlan()}`,
		`- Base URL: ${getBaseUrl()}`,
		`- API protocol: ${getApiProtocol()}`,
		`- Debug mode: ${getDebugMode()}`,
		`- Ponytail mode: ${getPonytailMode()}`,
		`- Code simplifier: ${getCodeSimplifierEnabled() ? 'on' : 'off'}`,
	];
	return lines.join('\n');
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === 'string' && value ? value : fallback;
}

function extensionModeLabel(mode: vscode.ExtensionMode): string {
	switch (mode) {
		case vscode.ExtensionMode.Development:
			return 'development';
		case vscode.ExtensionMode.Test:
			return 'test';
		default:
			return 'production';
	}
}

/** Elevation level (win32 only) — elevated VS Code explains many "weird" bugs. */
function windowsIntegrityLevel(): string {
	if (process.platform !== 'win32') {
		return 'not-applicable';
	}
	try {
		const groups = execFileSync('whoami.exe', ['/groups', '/fo', 'csv', '/nh'], {
			encoding: 'utf8',
			timeout: 2000,
			windowsHide: true,
		});
		if (/S-1-16-(?:12288|16384|20480)/i.test(groups)) {
			return 'high (elevated)';
		}
		if (/S-1-16-8192/i.test(groups)) {
			return 'medium (not elevated)';
		}
		if (/S-1-16-4096/i.test(groups)) {
			return 'low';
		}
		return 'unknown';
	} catch (error) {
		return `unavailable (${error instanceof Error ? error.message : String(error)})`;
	}
}
