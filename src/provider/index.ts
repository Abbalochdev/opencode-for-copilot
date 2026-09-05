import { createHash } from 'crypto';
import vscode from 'vscode';
import { AuthManager } from '../auth';
import {
	getBaseUrl,
	getPonytailMode,
	getStabilizeToolListEnabled,
	listProviderModels,
	refreshDynamicModels,
} from '../config';
import { API_KEY_GO_SECRET, API_KEY_SECRET, API_KEY_ZEN_SECRET, CONFIG_SECTION } from '../consts';
import {
	OPENCODE_GO_USAGE_CONSOLE_URL
} from '../endpoint';
import { t } from '../i18n';
import { logger } from '../logger';
import { setContextWindowStore, setOnContextWindowLearned } from './context-windows';
import { createCacheDiagnosticsRecorder, dumpProviderInput } from './debug';
import { toChatInfo } from './models';
import { setModelsDevSnapshotStorage } from './models-dev';
import { invalidateModelCache, isDynamicModelsStale } from './opencode-models';
import { getPricingCurrencyForBaseUrl } from './pricing/currency';
import { UsageCostStatus } from './pricing/status';
import { clearClientCache, prepareChatRequest } from './request';
import { classifyProviderRequest, type RequestKind } from './routing';
import { resolveConversationSegment } from './segment';
import { streamChatCompletion } from './stream';
import { estimateTokenCount } from './tokens';
import { processToolFlow } from './tools/flow';
import { createVisionService } from './vision';

// ---- Request deduplication for utility kinds ----
// Prevents duplicate in-flight API calls when VS Code fires the same
// utility request concurrently (e.g. prompt-categorizer, chat-title).
// Only applies to deterministic, idempotent request kinds.
const DEDUP_TTL_MS = 5_000;

const DEDUPABLE_REQUEST_KINDS = new Set<RequestKind>([
	'chat-title',
	'git-branch-name',
	'git-commit-message',
	'rename-suggestions',
	'inline-progress-message',
	'prompt-categorizer',
	'settings-resolver',
]);

/** Extract a dedup key from the last user message content hash + request kind. */
function computeDedupKey(
	requestKind: RequestKind,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): string | undefined {
	if (!DEDUPABLE_REQUEST_KINDS.has(requestKind)) {
		return undefined;
	}
	// Find last user message for keying.
	const lastUser = [...messages].reverse().find((m) => m.role === vscode.LanguageModelChatMessageRole.User);
	if (!lastUser) {
		return undefined;
	}
	const content = typeof lastUser.content === 'string'
		? lastUser.content
		: Array.isArray(lastUser.content)
			? lastUser.content.map((p) => (p as { value?: string }).value ?? '').join('')
			: '';
	const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
	return `${requestKind}:${hash}`;
}

// In-flight dedup map: dedupKey → { promise, expiresAt }
const inflightDedup = new Map<string, { promise: Promise<void>; expiresAt: number }>();

function cleanupInflightDedup(): void {
	const now = Date.now();
	for (const [key, entry] of inflightDedup) {
		if (now > entry.expiresAt) {
			inflightDedup.delete(key);
		}
	}
}

/**
 * GLM Chat Provider — implements vscode.LanguageModelChatProvider so
 * GLM models appear directly in the Copilot Chat model picker.
 */
export class GLMChatProvider implements vscode.LanguageModelChatProvider {
	private readonly authManager: AuthManager;
	private readonly globalStorageUri: vscode.Uri;
	private readonly onDidChangeLanguageModelChatInformationEmitter = new vscode.EventEmitter<void>();
	private isActive = true;

	readonly onDidChangeLanguageModelChatInformation =
		this.onDidChangeLanguageModelChatInformationEmitter.event;

	private readonly cacheDiagnostics = createCacheDiagnosticsRecorder();

	/** Vision proxy: internal bridge + VS Code LM fallback. */
	private readonly vision: ReturnType<typeof createVisionService>;
	private readonly usageCostStatus: UsageCostStatus;

	/**
	 * Adaptive chars-per-token ratio, calibrated from actual usage data.
	 * Updated via exponential moving average each time the API reports real token counts.
	 */
	private charsPerToken = 4.0;

	private ponytailMode = getPonytailMode();

	constructor(context: vscode.ExtensionContext) {
		this.authManager = new AuthManager(context);
		this.globalStorageUri = context.globalStorageUri;
		this.vision = createVisionService(context, this.authManager);
		this.usageCostStatus = new UsageCostStatus(context.globalState);

		// Persist the models.dev snapshot (context: ML-ware-adjacent global
		// state via globalState Memento) so cold restarts stay offline-safe.
		setModelsDevSnapshotStorage({
			get: (key) => context.globalState.get(key),
			update: (key, value) => context.globalState.update(key, value),
		});
		// Persist learned gateway context windows (from overflow errors) so a
		// model's real effective window survives restarts. When a new window is
		// learned, re-notify so the picker shows the corrected limit right away.
		setContextWindowStore({
			get: (key) => context.globalState.get(key),
			update: (key, value) => context.globalState.update(key, value),
		});
		setOnContextWindowLearned(() => this.refreshModelPicker());

		// Fetch live model list from OpenCode API on startup.
		// Fire-and-forget: static MODELS array is used until this completes.
		void refreshDynamicModels().then(() => this.refreshModelPicker());

		context.subscriptions.push(
			this.onDidChangeLanguageModelChatInformationEmitter,
			this.usageCostStatus,
			// Settings-based fallback API key + base URL changes.
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration(`${CONFIG_SECTION}.apiKey`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.baseUrl`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.endpoint`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.customModels`) ||
					e.affectsConfiguration(`${CONFIG_SECTION}.modelIdOverrides`)
				) {
					// Discard stale GLMClient instances whose baseUrl/apiKey/protocol may have changed.
					clearClientCache();
					// Re-fetch dynamic models when endpoint or custom models change.
					void refreshDynamicModels().then(() => this.refreshModelPicker());
				}
				if (e.affectsConfiguration(`${CONFIG_SECTION}.ponytailMode`)) {
					this.ponytailMode = getPonytailMode();
				}
			}),
			// Multi-window: SecretStorage changes don't fire onDidChangeConfiguration.
			// When another window sets/clears the API key, refresh this window's
			// model picker so the warning state stays in sync.
			context.secrets.onDidChange((e) => {
				if (
					e.key === API_KEY_SECRET ||
					e.key === API_KEY_GO_SECRET ||
					e.key === API_KEY_ZEN_SECRET
				) {
					this.refreshModelPicker();
				}
			}),
		);
	}

	// ---- Public commands ----

	async configureApiKey(): Promise<void> {
		const saved = await this.authManager.promptForApiKey();
		if (saved) {
			this.refreshModelPicker();
		}
	}

	/** Manually re-fetch the model catalog from the OpenCode API. */
	async refreshModels(): Promise<void> {
		invalidateModelCache();
		await refreshDynamicModels();
		this.refreshModelPicker();
	}

	async clearApiKey(): Promise<void> {
		await this.authManager.deleteAllApiKeys();
		this.refreshModelPicker();
		vscode.window.showInformationMessage(t('auth.removed'));
	}

	async queryUsage(): Promise<void> {
		// OpenCode has no monitor API — Go limits and Zen spend live in the
		// web console at opencode.ai/auth.
		void vscode.window.showInformationMessage(t('usage.opencodeConsole'));
		await vscode.env.openExternal(vscode.Uri.parse(OPENCODE_GO_USAGE_CONSOLE_URL));
	}

	async hasApiKey(): Promise<boolean> {
		return this.authManager.hasApiKey();
	}

	/** Force Copilot Chat to re-query model information (including configurationSchema). */
	refreshModelPicker(): void {
		this.onDidChangeLanguageModelChatInformationEmitter.fire();
	}

	async prepareForDeactivate(): Promise<void> {
		this.isActive = false;
		this.onDidChangeLanguageModelChatInformationEmitter.fire();

		// Force the host to re-pull `provideLanguageModelChatInformation` synchronously
		// before the extension unloads. With `isActive = false` we now return [],
		// which makes Copilot Chat drop GLM models from the picker immediately
		// instead of leaving stale entries behind after deactivate. The returned
		// model list itself is unused — we only call this for its side effect.
		try {
			await vscode.lm.selectChatModels({ vendor: 'opencode' });
		} catch (error) {
			logger.warn('Failed to refresh GLM models during deactivate', error);
		}
	}

	async setVisionModel(): Promise<void> {
		await this.vision.openConfiguration();
	}

	// ---- LanguageModelChatProvider ----

	async provideLanguageModelChatInformation(
		_options: vscode.PrepareLanguageModelChatModelOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (!this.isActive) {
			return [];
		}

		// Stale catalog → refresh in the background and re-notify, so VPN /
		// network changes surface the next time the picker opens without a
		// window reload. The change event re-queries us; by then the cache is
		// fresh (or on the failed-fetch retry backoff), so this cannot loop.
		if (isDynamicModelsStale()) {
			void refreshDynamicModels().then(() => this.refreshModelPicker());
		}
		// One shared credential gates the whole picker — Go and Zen endpoints
		// accept the same key. The full catalog is always shown; entitlement
		// (Go subscription vs Zen credit) is decided server-side per request.
		const hasKey = await this.authManager.hasApiKey();
		const pricingCurrency = getPricingCurrencyForBaseUrl(getBaseUrl());
		return listProviderModels().map((model) => toChatInfo(model, hasKey, pricingCurrency));
	}

	async provideLanguageModelChatResponse(
		modelInfo: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const segment = resolveConversationSegment(messages);
		const requestKind = classifyProviderRequest({
			messages,
			tools: options.tools,
		});

		dumpProviderInput({
			globalStorageUri: this.globalStorageUri,
			segment,
			modelInfo,
			messages,
			requestOptions: options,
			requestKind,
		});

		// Deduplicate concurrent identical utility requests.
		cleanupInflightDedup();
		const dedupKey = computeDedupKey(requestKind, messages);
		if (dedupKey) {
			const existing = inflightDedup.get(dedupKey);
			if (existing && Date.now() < existing.expiresAt) {
				logger.debug(`[dedup] Coalescing duplicate ${requestKind} request`);
				await existing.promise;
				return;
			}
		}

		const toolFlow = processToolFlow({
			stabilizeToolList: getStabilizeToolListEnabled(),
			messages,
			tools: options.tools,
			progress,
			requestKind,
		});
		if (toolFlow.preflightHandled) {
			return;
		}

		const prepared = await prepareChatRequest({
			authManager: this.authManager,
			globalStorageUri: this.globalStorageUri,
			modelInfo,
			segment,
			messages: toolFlow.messages,
			options,
			token,
			cacheDiagnostics: this.cacheDiagnostics,
			getVisionDescriber: () => this.vision.get(),
			requestKind,
		});

		const completionPromise = streamChatCompletion({
			prepared,
			progress,
			token,
			initialResponseNotice: joinInitialResponseNotices(
				toolFlow.initialResponseNotice,
				prepared.initialResponseNotice,
			),
			getCharsPerToken: () => this.charsPerToken,
			setCharsPerToken: (charsPerToken) => {
				this.charsPerToken = charsPerToken;
			},
			onUsageCost: (estimate) => this.usageCostStatus.report(estimate),
		});

		if (dedupKey) {
			const expiresAt = Date.now() + DEDUP_TTL_MS;
			const entry = { promise: completionPromise, expiresAt };
			inflightDedup.set(dedupKey, entry);
			void completionPromise.finally(() => {
				// Remove after TTL to allow fresh requests.
				setTimeout(() => inflightDedup.delete(dedupKey), DEDUP_TTL_MS);
			});
		}

		return completionPromise;
	}

	async provideTokenCount(
		_modelInfo: vscode.LanguageModelChatInformation,
		text: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken,
	): Promise<number> {
		return estimateTokenCount(text, this.charsPerToken);
	}
}

function joinInitialResponseNotices(...notices: (string | undefined)[]): string | undefined {
	const joined = notices.filter((notice) => notice && notice.trim().length > 0).join('\n');
	return joined || undefined;
}
