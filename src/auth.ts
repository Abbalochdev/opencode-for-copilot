import vscode from 'vscode';
import { API_KEY_GO_SECRET, API_KEY_SECRET, API_KEY_ZEN_SECRET, CONFIG_SECTION } from './consts';
import { t } from './i18n';

/**
 * Manages GLM API key via VS Code SecretStorage (secure) with
 * fallback to extension settings (less secure, for CI/automation).
 *
 * OpenCode Go and Zen share one credential: a single key from
 * opencode.ai/auth authenticates both the Go subscription endpoints and the
 * Zen pay-as-you-go endpoints; entitlement is decided server-side. The two
 * per-plan slots below exist only to read/clean up keys stored by older
 * versions that modeled them as separate secrets.
 */
export class AuthManager {
	private readonly secretStorage: vscode.SecretStorage;

	constructor(context: vscode.ExtensionContext) {
		this.secretStorage = context.secrets;
	}

	/**
	 * Get API key. Tries SecretStorage first, then falls back to settings.
	 * Legacy per-plan slots are consulted so users of versions that split the
	 * key keep working without re-entering it.
	 */
	async getApiKey(): Promise<string | undefined> {
		for (const secretKey of [
			await this.secretStorage.get(API_KEY_SECRET),
			await this.secretStorage.get(API_KEY_GO_SECRET),
			await this.secretStorage.get(API_KEY_ZEN_SECRET),
		]) {
			if (secretKey) {
				return secretKey;
			}
		}

		const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
		const settingsKey = config.get<string>('apiKey');
		if (settingsKey?.trim()) {
			return settingsKey.trim();
		}

		return undefined;
	}

	/**
	 * Store API key in SecretStorage.
	 */
	async setApiKey(apiKey: string): Promise<void> {
		await this.secretStorage.store(API_KEY_SECRET, apiKey.trim());
	}

	/**
	 * Delete stored API key.
	 */
	async deleteApiKey(): Promise<void> {
		await this.secretStorage.delete(API_KEY_SECRET);
		await clearSettingsApiKey();
	}

	/** Remove every stored API key (current + legacy per-plan slots) and the settings fallback. */
	async deleteAllApiKeys(): Promise<void> {
		await this.secretStorage.delete(API_KEY_GO_SECRET);
		await this.secretStorage.delete(API_KEY_ZEN_SECRET);
		await this.deleteApiKey();
	}

	/**
	 * Check if an API key is configured.
	 */
	async hasApiKey(): Promise<boolean> {
		const key = await this.getApiKey();
		return key !== undefined && key.length > 0;
	}

	/**
	 * Prompt user to enter an API key via input box.
	 */
	async promptForApiKey(): Promise<boolean> {
		const apiKey = await vscode.window.showInputBox({
			prompt: t('auth.prompt'),
			placeHolder: t('auth.placeholder'),
			password: true,
			ignoreFocusOut: true,
			validateInput: (value: string) => {
				if (!value?.trim()) {
					return t('auth.emptyValidation');
				}
				return undefined;
			},
		});

		if (apiKey) {
			await this.setApiKey(apiKey);
			vscode.window.showInformationMessage(t('auth.saved'));
			return true;
		}

		return false;
	}
}

async function clearSettingsApiKey(): Promise<void> {
	await clearSettingsApiKeyAtScope(vscode.ConfigurationTarget.Global);

	if (vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length) {
		await clearSettingsApiKeyAtScope(vscode.ConfigurationTarget.Workspace);
	}

	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		await clearSettingsApiKeyAtScope(vscode.ConfigurationTarget.WorkspaceFolder, folder.uri);
	}
}

async function clearSettingsApiKeyAtScope(
	target: vscode.ConfigurationTarget,
	resource?: vscode.Uri,
): Promise<void> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION, resource);
	const inspection = config.inspect<string>('apiKey');
	if (!hasScopedApiKey(inspection, target)) {
		return;
	}
	await config.update('apiKey', undefined, target);
}

function hasScopedApiKey(
	inspection:
		| {
				globalValue?: string;
				workspaceValue?: string;
				workspaceFolderValue?: string;
		  }
		| undefined,
	target: vscode.ConfigurationTarget,
): boolean {
	if (!inspection) {
		return false;
	}
	if (target === vscode.ConfigurationTarget.Global) {
		return typeof inspection.globalValue === 'string';
	}
	if (target === vscode.ConfigurationTarget.Workspace) {
		return typeof inspection.workspaceValue === 'string';
	}
	return typeof inspection.workspaceFolderValue === 'string';
}
