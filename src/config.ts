import vscode from 'vscode';
import { CONFIG_SECTION, LEGACY_CONFIG_SECTION, MODELS } from './consts';
import {
    normalizeBaseUrl,
    resolveEndpointApiKeyUrl,
    resolveEndpointBaseUrl,
    resolveEndpointProtocol
} from './endpoint';
import {
    getDynamicModels
} from './provider/opencode-models';
import type { PonytailMode } from './provider/ponytail';
import type {
    ApiProtocol,
    CustomModelConfig,
    EndpointPreset,
    ModelDefinition,
} from './types';

export type DebugMode = 'minimal' | 'metadata' | 'verbose';

const CUSTOM_MODEL_DETAIL = 'Custom GLM-compatible model';
const CUSTOM_MODEL_MAX_INPUT_TOKENS = 200_000;
const CUSTOM_MODEL_MAX_OUTPUT_TOKENS = 131_072;

/**
 * Get GLM API base URL from settings.
 *
 * Resolution order:
 *   1. `baseUrl` override (highest priority — covers advanced/proxy use cases)
 *   2. `endpoint` preset
 *   3. `opencode-go` when the endpoint preset is unset or invalid
 */
export function getBaseUrl(): string {
	const override = getBaseUrlOverride();
	if (override) {
		return override;
	}

	const preset = getEndpoint();
	return resolveEndpointBaseUrl(preset);
}

export function getBaseUrlOverride(): string | undefined {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<string>('baseUrl', '');
	// Guard against non-string values in settings.json that would crash normalizeBaseUrl().trim()
	const normalized = normalizeBaseUrl(typeof value === 'string' ? value : '');
	return normalized || undefined;
}

/**
 * Get the single-value endpoint preset.
 *
 * Resolution order:
 *   1. Explicit `endpoint` setting (always wins)
 *   2. `opencode-go` when the endpoint preset is unset or invalid
 */
export function getEndpoint(): EndpointPreset {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const explicit = normalizeEndpointPreset(config.get<string>('endpoint'));
	return explicit ?? 'opencode-go';
}

// ---- One-time legacy settings migration (glm-copilot -> opencode-for-copilot) ----

const LEGACY_SETTING_KEYS = [
	'agentRoles',
	'baseUrl',
	'endpoint',
	'maxTokens',
	'experimental.stabilizeToolList',
	'modelIdOverrides',
	'customModels',
	'visionModel',
	'visionPrompt',
	'debugMode',
	'ponytailMode',
	'codeSimplifier',
	'stripThinkTags',
	// Legacy keys no longer contributed but still read for backward compatibility.
	'apiKey',
] as const;

const SETTINGS_MIGRATION_KEY = 'opencode-for-copilot.settingsMigratedFromLegacy.version';
const SETTINGS_MIGRATION_VERSION = 1;

/**
 * One-time copy of user-set `glm-copilot.*` values into the new
 * `opencode-for-copilot.*` section. The old section is shared with the
 * upstream GLM extension (same origin); reading it live would couple the two
 * extensions' configuration. After this runs, the legacy section is never
 * read again — both extensions can coexist with independent settings.
 */
export async function migrateLegacySettings(context: vscode.ExtensionContext): Promise<void> {
	if (context.globalState.get<number>(SETTINGS_MIGRATION_KEY, 0) >= SETTINGS_MIGRATION_VERSION) {
		return;
	}
	for (const key of LEGACY_SETTING_KEYS) {
		const next = vscode.workspace.getConfiguration(CONFIG_SECTION).inspect(key);
		if (
			next?.globalValue !== undefined ||
			next?.workspaceValue !== undefined ||
			next?.workspaceFolderValue !== undefined
		) {
			continue;
		}
		const legacy = vscode.workspace.getConfiguration(LEGACY_CONFIG_SECTION).inspect(key);
		if (legacy?.globalValue !== undefined) {
			await vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.update(key, legacy.globalValue, vscode.ConfigurationTarget.Global);
		}
		if (legacy?.workspaceValue !== undefined) {
			await vscode.workspace
				.getConfiguration(CONFIG_SECTION)
				.update(key, legacy.workspaceValue, vscode.ConfigurationTarget.Workspace);
		}
	}
	await context.globalState.update(SETTINGS_MIGRATION_KEY, SETTINGS_MIGRATION_VERSION);
}

/**
 * Get the wire protocol implied by the active endpoint preset.
 *
 * `baseUrl` override does not change the protocol — users pointing at a
 * custom gateway still pick the protocol shape explicitly via `endpoint`.
 * A leftover explicit `apiProtocol` value (pre-3.10 escape hatch, no longer
 * contributed) still wins when `endpoint` is unset so custom-baseUrl users
 * keep their chosen request shape.
 */
export function getApiProtocol(): ApiProtocol {
	const protocol = resolveEndpointProtocol(getEndpoint());
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	if (normalizeEndpointPreset(config.get<string>('endpoint'))) {
		return protocol;
	}
	return normalizeApiProtocol(config.get<string>('apiProtocol'), protocol) ?? protocol;
}

export function getApiKeyUrl(): string {
	return resolveEndpointApiKeyUrl(getEndpoint());
}

function normalizeEndpointPreset(value: unknown): EndpointPreset | undefined {
	if (
		value === 'opencode-go' ||
		value === 'opencode-go-anthropic' ||
		value === 'opencode-zen' ||
		value === 'opencode-zen-anthropic'
	) {
		return value;
	}
	return undefined;
}

/**
 * Resolve the API model ID to send to the endpoint.
 *
 * Users can override model IDs via the `modelIdOverrides` setting object
 * (e.g. for third-party API proxies). Falls back to the VS Code model ID
 * when no override is configured.
 */
export function getApiModelId(vscodeModelId: string): string {
	const override = getModelIdOverrides()[vscodeModelId]?.trim();
	return override || vscodeModelId;
}

export function getModelIdOverrides(): Record<string, string> {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<Record<string, unknown>>('modelIdOverrides');
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return {};
	}

	return Object.fromEntries(
		Object.entries(raw)
			.map(([key, value]) => [key.trim(), typeof value === 'string' ? value.trim() : ''])
			.filter(([key, value]) => key.length > 0 && value.length > 0),
	);
}

export function getCustomModels(): ModelDefinition[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<unknown[]>('customModels', []);
	if (!Array.isArray(raw)) {
		return [];
	}

	const byId = new Map<string, ModelDefinition>();
	for (const entry of raw) {
		const model = normalizeCustomModel(entry);
		if (model) {
			byId.set(model.id, model);
		}
	}
	return [...byId.values()];
}

/**
 * Dynamic model list override. When set by `refreshDynamicModels()`, this is
 * used instead of the static `MODELS` array. This lets us serve live model
 * lists from the OpenCode API while keeping the static array as a fallback.
 */
let dynamicModelsOverride: readonly ModelDefinition[] | undefined;

/** Build the merged model map: dynamic/static base + custom overrides. */
function buildModelMap(): Map<string, ModelDefinition> {
	const source = dynamicModelsOverride ?? MODELS;
	const byId = new Map(source.map((model) => [model.id, model]));
	for (const model of getCustomModels()) {
		byId.set(model.id, model);
	}
	return byId;
}

/**
 * Synchronous model list — used by the model picker, request handler, and tests.
 * Returns dynamic models if available, otherwise falls back to static MODELS.
 */
export function listProviderModels(): ModelDefinition[] {
	return [...buildModelMap().values()];
}

/**
 * Asynchronously refresh the model list from the OpenCode API.
 * Updates `dynamicModelsOverride` so the next call to
 * `listProviderModels()` returns fresh data.
 *
 * On network failure the existing list (or static fallback) stays in place.
 */
export async function refreshDynamicModels(): Promise<void> {
	const customModels = getCustomModels();
	const fallback = dynamicModelsOverride ?? MODELS;
	dynamicModelsOverride = await getDynamicModels(customModels, fallback);
}

export function findModelDefinition(modelId: string): ModelDefinition | undefined {
	return buildModelMap().get(modelId);
}

/**
 * Get the configured max output tokens limit.
 * Returns `undefined` when set to 0 (API default — no limit).
 */
export function getMaxTokens(): number | undefined {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<number>('maxTokens', 0);
	// Guard against Infinity (e.g. from misconfiguration) which would satisfy
	// value > 0 but produce an invalid API request.
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Diagnostic mode. `verbose` also enables metadata logs.
 *
 * The legacy boolean `debug` setting is still read as a fallback so old
 * settings keep working even if migration cannot update every scope.
 */
export function getDebugMode(): DebugMode {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const mode = getConfiguredDebugMode(config);
	if (mode) return mode;

	return config.get<boolean>('debug', false) ? 'metadata' : 'minimal';
}

/**
 * Whether to log privacy-preserving diagnostic debug information.
 */
export function getDebugLoggingEnabled(): boolean {
	return getDebugMode() !== 'minimal';
}

/**
 * Whether to write full GLM request payloads to disk.
 */
export function getRequestDumpEnabled(): boolean {
	return getDebugMode() === 'verbose';
}

export function getStabilizeToolListEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('experimental.stabilizeToolList', false);
}

export type StripThinkTagsMode = 'auto' | 'always' | 'never';

/**
 * Controls stripping of leaked think tags (`<think>`, `<ground>`, `deliberation`)
 * from model output. Some models (MiniMax M2, DeepSeek) leak these into content
 * instead of routing them through `reasoning_content`.
 *
 * - `auto` (default): strip only for models known to leak (MiniMax M2 family)
 * - `always`: strip for all models
 * - `never`: never strip
 */
export function getStripThinkTagsMode(): StripThinkTagsMode {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<string>('stripThinkTags', 'auto');
	if (value === 'always' || value === 'never') {
		return value;
	}
	return 'auto';
}

const DEFAULT_PONYTAIL_MODE: PonytailMode = 'full';

export function getPonytailMode(): PonytailMode {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<string>('ponytailMode');
	const raw = normalizePonytailMode(value) ?? DEFAULT_PONYTAIL_MODE;
	// Code Simplifier's proactive review conflicts with Ponytail full/ultra's
	// "be brief, never volunteer." Downgrade to lite so both coexist cleanly.
	if (getCodeSimplifierEnabled() && (raw === 'full' || raw === 'ultra')) {
		return 'lite';
	}
	return raw;
}

function normalizePonytailMode(value: unknown): PonytailMode | undefined {
	if (value === 'off' || value === 'lite' || value === 'full' || value === 'ultra') {
		return value;
	}
	return undefined;
}

/** Whether the Code Simplifier autonomous refinement agent is enabled. */
export function getCodeSimplifierEnabled(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('codeSimplifier', false);
}

/**
 * User-defined rules, verbatim, injected into the system message for every
 * coding request. Empty / whitespace entries are dropped before injection
 * (see {@link injectRulesSystemMessage}). Returns `[]` by default so the
 * prompt shape is unchanged for users who don't set this.
 *
 * Inspired by Continue's `rules:` block — keeps a small, declarative way to
 * enforce project conventions ("always TypeScript", "concise responses")
 * without code changes or a separate system-message-setting surface.
 */
export function getRules(): string[] {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const value = config.get<unknown>('rules');
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((r): r is string => typeof r === 'string');
}

/**
 * Opt-in flag that releases the agent swarm's curated tool-name whitelist.
 *
 * When `true`, {@link selectPipelineTools} / {@link selectReadOnlyTools}
 * additionally forward tools whose names are NOT in the curated set, so
 * MCP-discovered tools and other Copilot-registered external tools become
 * visible to the swarm. Off by default to preserve the curated-tool behaviour
 * and 128-entry GLM request cap the whitelist was designed for. The hard cap
 * (MAX_TOOLS) still applies after pass-through.
 *
 * Inspired by Continue's first-class MCP support — Copilot already surfaces
 * MCP tools via {@link vscode.lm.tools}, but with the whitelist active they
 * are silently dropped before the swarm sees them. This setting unblocks them.
 */
export function getAllowExtraTools(): boolean {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return config.get<boolean>('allowExtraTools', false);
}

/**
 * Per-model probe timeout for the agent swarm's free-tier audit. When the
 * user has NOT pinned `glm-copilot.agentRoles.*`, each swarm run starts by
 * probing every OpenCode free model in parallel and ranking the responders
 * by latency; this setting bounds a single probe. The audit's wall-clock is
 * the *slowest* probe (all probes run in parallel), so the audit adds at
 * most this much to the front of `@swarm`.
 *
 * Default 6000ms. Tune down on slow connections to truncate the audit
 * (we'd rather lose one suspect model than wait through it).
 */
export function getAuditFreeModelProbeMs(): number {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const raw = config.get<unknown>('auditFreeModelProbeMs', 6_000);
	// Coerce to a sane positive integer — guard against stray strings/booleans.
	const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 6_000;
	return Math.max(500, Math.floor(n));
}

function getConfiguredDebugMode(config: vscode.WorkspaceConfiguration): DebugMode | undefined {
	const mode = config.inspect<unknown>('debugMode');
	return (
		normalizeDebugMode(mode?.workspaceFolderValue) ??
		normalizeDebugMode(mode?.workspaceValue) ??
		normalizeDebugMode(mode?.globalValue)
	);
}

function normalizeDebugMode(value: unknown): DebugMode | undefined {
	if (value === 'minimal' || value === 'metadata' || value === 'verbose') {
		return value;
	}
	return undefined;
}

function normalizeApiProtocol(
	value: unknown,
	fallback: ApiProtocol | undefined,
): ApiProtocol | undefined {
	return value === 'openai' || value === 'anthropic' || value === 'responses' ? value : fallback;
}

function normalizeCustomModel(entry: unknown): ModelDefinition | undefined {
	const model = readCustomModelConfig(entry);
	if (!model) {
		return undefined;
	}

	const id = model.id?.trim();
	if (!id) {
		return undefined;
	}

	const thinking = model.thinking !== false;
	return {
		id,
		name: getCustomModelName(model, id),
		family: 'glm',
		version: 'custom',
		detail: CUSTOM_MODEL_DETAIL,
		maxInputTokens: getPositiveInteger(model.maxInputTokens, CUSTOM_MODEL_MAX_INPUT_TOKENS),
		maxOutputTokens: getPositiveInteger(model.maxOutputTokens, CUSTOM_MODEL_MAX_OUTPUT_TOKENS),
		capabilities: {
			toolCalling: model.toolCalling === false ? false : true,
			imageInput: true,
			thinking,
		},
		requiresThinkingParam: thinking,
	};
}

function readCustomModelConfig(entry: unknown): CustomModelConfig | undefined {
	if (typeof entry === 'string') {
		return { id: entry };
	}

	if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
		return undefined;
	}

	return entry as CustomModelConfig;
}

function getCustomModelName(model: CustomModelConfig, id: string): string {
	const name = model.name?.trim();
	return name || id;
}

function getPositiveInteger(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: fallback;
}
