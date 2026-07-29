import vscode from 'vscode';
import { CONFIG_SECTION, MODELS } from './consts';
import {
	deriveEndpointPreset,
	normalizeBaseUrl,
	resolveApiKeyUrl,
	resolveEndpointApiKeyUrl,
	resolveEndpointBaseUrl,
	resolveEndpointProtocol,
} from './endpoint';
import {
	getDynamicModels
} from './provider/opencode-models';
import type { PonytailMode } from './provider/ponytail';
import type {
	ApiMode,
	ApiProtocol,
	ApiRegion,
	CustomModelConfig,
	EndpointPreset,
	ModelDefinition,
} from './types';

export type DebugMode = 'minimal' | 'metadata' | 'verbose';

const DEFAULT_API_MODE: ApiMode = 'coding-plan';
const DEFAULT_API_REGION: ApiRegion = 'china';
const DEFAULT_API_PROTOCOL: ApiProtocol = 'openai';
const CUSTOM_MODEL_DETAIL = 'Custom GLM-compatible model';
const CUSTOM_MODEL_MAX_INPUT_TOKENS = 200_000;
const CUSTOM_MODEL_MAX_OUTPUT_TOKENS = 131_072;

/**
 * Get GLM API base URL from settings.
 *
 * Resolution order:
 *   1. `baseUrl` override (highest priority — covers advanced/proxy use cases)
 *   2. `endpoint` preset (new single-value selector)
 *   3. Legacy (region, apiMode, apiProtocol) tuple — transparently mapped to
 *      a preset so existing user settings keep working without migration.
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

export function getApiMode(): ApiMode {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return normalizeApiMode(config.get<string>('apiMode'), DEFAULT_API_MODE) ?? DEFAULT_API_MODE;
}

export function getRegion(): ApiRegion {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return normalizeApiRegion(config.get<string>('region'), DEFAULT_API_REGION) ?? DEFAULT_API_REGION;
}

/**
 * Get the single-value endpoint preset.
 *
 * Falls back to deriving a preset from the legacy (region, apiMode,
 * apiProtocol) tuple when `endpoint` is not explicitly configured. This keeps
 * existing user settings working without a destructive migration.
 */
export function getEndpoint(): EndpointPreset {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const explicit = normalizeEndpointPreset(config.get<string>('endpoint'));
	if (explicit) {
		return explicit;
	}
	return deriveEndpointFromLegacy();
}

/**
 * Get the wire protocol implied by the active endpoint preset.
 *
 * `baseUrl` override does not change the protocol — users pointing at a
 * custom gateway still pick the protocol shape explicitly via `endpoint`.
 */
export function getApiProtocol(): ApiProtocol {
	const preset = getEndpoint();
	const protocol = resolveEndpointProtocol(preset);
	// Preserve the legacy explicit `apiProtocol` override path: when a user has
	// NOT set the new `endpoint` but DID set `apiProtocol`, that intent still
	// wins so custom-baseUrl users keep their chosen protocol shape.
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const explicitEndpoint = normalizeEndpointPreset(config.get<string>('endpoint'));
	if (explicitEndpoint) {
		return protocol;
	}
	const legacyProtocol = normalizeApiProtocol(config.get<string>('apiProtocol'), protocol);
	return legacyProtocol ?? protocol;
}

export function getApiKeyUrl(): string {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	const explicitEndpoint = normalizeEndpointPreset(config.get<string>('endpoint'));
	if (explicitEndpoint) {
		return resolveEndpointApiKeyUrl(explicitEndpoint);
	}
	// Legacy path: derive from the old tuple so old configs keep pointing at
	// the right key-management page.
	return resolveApiKeyUrl(getApiMode(), getRegion());
}

function deriveEndpointFromLegacy(): EndpointPreset {
	const region = getRegion();
	const apiMode = getApiMode();
	const apiProtocol = getApiProtocolLegacy();
	return deriveEndpointPreset(region, apiMode, apiProtocol);
}

function getApiProtocolLegacy(): ApiProtocol {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	return (
		normalizeApiProtocol(config.get<string>('apiProtocol'), DEFAULT_API_PROTOCOL) ??
		DEFAULT_API_PROTOCOL
	);
}

function normalizeEndpointPreset(value: unknown): EndpointPreset | undefined {
	if (
		value === 'china-coding' ||
		value === 'china-standard' ||
		value === 'china-anthropic' ||
		value === 'international-coding' ||
		value === 'international-standard' ||
		value === 'international-anthropic' ||
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

function normalizeApiMode(value: unknown, fallback: ApiMode | undefined): ApiMode | undefined {
	return value === 'coding-plan' || value === 'standard' ? value : fallback;
}

function normalizeApiProtocol(
	value: unknown,
	fallback: ApiProtocol | undefined,
): ApiProtocol | undefined {
	return value === 'openai' || value === 'anthropic' ? value : fallback;
}

function normalizeApiRegion(
	value: unknown,
	fallback: ApiRegion | undefined,
): ApiRegion | undefined {
	return value === 'china' || value === 'international' ? value : fallback;
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
