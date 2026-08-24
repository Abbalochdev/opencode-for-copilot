import vscode from 'vscode';
import { API_KEY_GO_SECRET, API_KEY_SECRET, API_KEY_ZEN_SECRET, CONFIG_SECTION } from './consts';
import { resolveOpencodePlanForBaseUrl, type OpencodePlan } from './endpoint';
import { t } from './i18n';

/**
 * Manages GLM API key via VS Code SecretStorage (secure) with
 * fallback to extension settings (less secure, for CI/automation).
 */
export class AuthManager {
	private readonly secretStorage: vscode.SecretStorage;

	constructor(context: vscode.ExtensionContext) {
		this.secretStorage = context.secrets;
	}

	/**
	 * Get API key. Tries SecretStorage first, then falls back to settings.
	 */
	async getApiKey(): Promise<string | undefined> {
		const secretKey = await this.secretStorage.get(API_KEY_SECRET);
		if (secretKey) {
			return secretKey;
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

	/**
	 * API key for an OpenCode plan. Falls back to the legacy single key so
	 * existing users keep working after the split.
	 */
	async getPlanApiKey(plan: OpencodePlan): Promise<string | undefined> {
		const secretKey = await this.secretStorage.get(
			plan === 'go' ? API_KEY_GO_SECRET : API_KEY_ZEN_SECRET,
		);
		if (secretKey) {
			return secretKey;
		}
		return this.getApiKey();
	}

	async setPlanApiKey(plan: OpencodePlan, apiKey: string): Promise<void> {
		await this.secretStorage.store(
			plan === 'go' ? API_KEY_GO_SECRET : API_KEY_ZEN_SECRET,
			apiKey.trim(),
		);
	}

	async deletePlanApiKey(plan: OpencodePlan): Promise<void> {
		await this.secretStorage.delete(plan === 'go' ? API_KEY_GO_SECRET : API_KEY_ZEN_SECRET);
	}

	async hasPlanApiKey(plan: OpencodePlan): Promise<boolean> {
		const key = await this.getPlanApiKey(plan);
		return key !== undefined && key.length > 0;
	}

	/** Key for a request URL: Go URLs → Go key, Zen URLs → Zen key, else legacy. */
	async getApiKeyForEndpoint(baseUrl: string): Promise<string | undefined> {
		const plan = resolveOpencodePlanForBaseUrl(baseUrl);
		return plan ? this.getPlanApiKey(plan) : this.getApiKey();
	}

	/** Remove every stored API key (Go + Zen + legacy) and the settings fallback. */
	async deleteAllApiKeys(): Promise<void> {
		await this.deletePlanApiKey('go');
		await this.deletePlanApiKey('zen');
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
	 * Prompt user to enter an API key via input box. With a plan, stores the
	 * key in that plan's slot; without, stores the legacy single key.
	 */
	async promptForApiKey(plan?: OpencodePlan): Promise<boolean> {
		const apiKey = await vscode.window.showInputBox({
			prompt: t(plan ? `auth.prompt.${plan}` : 'auth.prompt'),
			placeHolder: t(plan ? `auth.placeholder.${plan}` : 'auth.placeholder'),
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
			if (plan) {
				await this.setPlanApiKey(plan, apiKey);
			} else {
				await this.setApiKey(apiKey);
			}
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
