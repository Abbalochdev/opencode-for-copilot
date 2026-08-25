/**
 * Dynamic model fetching from the OpenCode Go and Zen APIs.
 *
 * The APIs return only model IDs (no metadata). This module maintains a local
 * metadata overlay that maps each known model ID to its display name, context
 * windows, capabilities, wire protocol, and pricing. Unknown models that
 * appear in the API response get auto-generated defaults so they show up in
 * the picker immediately — even before a new extension release.
 *
 * Architecture:
 *   1. Fetch model IDs from `opencode.ai/zen/go/v1/models` (Go) and
 *      `opencode.ai/zen/v1/models` (Zen).
 *   2. For each ID, look up the overlay for full metadata.
 *   3. Unknown IDs → auto-generate a ModelDefinition with sensible defaults.
 *   4. Merge with user-supplied customModels from settings.
 *   5. Cache with a TTL; fall back to the static MODELS array on error.
 */

import {
	OPENCODE_GO_OPENAI_BASE_URL,
	OPENCODE_ZEN_OPENAI_BASE_URL
} from '../endpoint';
import { logger } from '../logger';
import type { EndpointPreset, ModelDefinition } from '../types';
import { invalidateModelsDevCache, mergeModelListWithModelsDev } from './models-dev';
import { GLM_TOOLS_LIMIT } from './tools/consts';

// ---- API endpoints ----

const OPENCODE_GO_MODELS_URL = `${OPENCODE_GO_OPENAI_BASE_URL}/models`;
const OPENCODE_ZEN_MODELS_URL = `${OPENCODE_ZEN_OPENAI_BASE_URL}/models`;

// ---- Cache ----

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** After a failed fetch, retry this soon instead of serving the static fallback for a full TTL. */
const FAILED_FETCH_RETRY_MS = 60 * 1000;

let cachedModels: ModelDefinition[] | undefined;
let cacheTimestamp = 0;

// ---- Metadata overlay ----
//
// ---- Model metadata ----
//
// The OpenCode `/models` endpoints return ONLY ids (verified against the live
// API), so per-model metadata comes from three sources, cheapest first:
//
//   1. Family rules (`resolveEndpointPresetForId`) → wire-protocol routing.
//      Validated against https://opencode.ai/docs/go and /docs/zen: Claude
//      and Qwen always speak Anthropic; MiniMax speaks Anthropic on the Go
//      plan only; every other family speaks OpenAI-compatible.
//   2. models.dev enrichment (`models-dev.ts`) → context windows, pricing,
//      capabilities — fetched live together with the catalogs.
//   3. FALLBACK_MODELS → four hand-tuned baselines covering every plan ×
//      protocol, always merged into the catalog (lowest priority) so the
//      extension works before the first fetch or if both `/models`
//      endpoints ever change shape.

/**
 * Resolve which endpoint preset (plan + wire protocol) a catalog model routes
 * to. `origin` is the catalog the id was discovered in.
 */
export function resolveEndpointPresetForId(id: string, origin: 'go' | 'zen'): EndpointPreset {
	const planPrefix = origin === 'go' ? 'opencode-go' : 'opencode-zen';
	const speaksAnthropic =
		id.startsWith('claude') ||
		id.startsWith('qwen') ||
		(origin === 'go' && id.startsWith('minimax'));
	if (!speaksAnthropic) {
		return planPrefix as EndpointPreset;
	}
	return `${planPrefix}-anthropic` as EndpointPreset;
}

// Capability presets for the hand-tuned baselines below.
const CAPS_THINKING = { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true } as const;
const CAPS_STANDARD = { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false } as const;
const CAPS_FREE_TIER = {
	toolCalling: GLM_TOOLS_LIMIT,
	preferredToolLimit: 32,
	imageInput: false,
	thinking: false,
} as const;

/**
 * Curated offline baseline: the smallest set covering every billing path ×
 * wire protocol. Always present in the catalog; live catalog entries and user
 * custom models override these.
 *
 * - `glm-5.2`                → Go · OpenAI protocol (flagship)
 * - `minimax-m3`             → Go · Anthropic protocol
 * - `claude-sonnet-4-5`      → Zen · Anthropic protocol
 * - `deepseek-v4-flash-free` → Zen · OpenAI protocol (free — zero balance OK)
 */
const FALLBACK_MODELS: readonly ModelDefinition[] = [
	{
		id: 'glm-5.2',
		name: 'GLM-5.2',
		family: 'glm',
		version: '5.2',
		detail: 'Flagship coding and reasoning model',
		maxInputTokens: 1_000_000,
		maxOutputTokens: 131_072,
		capabilities: { ...CAPS_THINKING },
		requiresThinkingParam: true,
		supportsReasoningEffort: true,
		pricing: { USD: { cacheHitInput: 0.26, cacheMissInput: 1.4, output: 4.4 } },
		priceCategory: 'high',
	},
	{
		id: 'minimax-m3',
		name: 'MiniMax M3',
		family: 'minimax',
		version: 'm3',
		detail: 'Coding agent work (Anthropic protocol)',
		maxInputTokens: 200_000,
		maxOutputTokens: 131_072,
		capabilities: { ...CAPS_STANDARD },
		requiresThinkingParam: false,
		endpointPreset: 'opencode-go-anthropic',
		pricing: { USD: { cacheHitInput: 0.06, cacheMissInput: 0.3, output: 1.2 } },
		priceCategory: 'low',
	},
	{
		id: 'claude-sonnet-4-5',
		name: 'Claude Sonnet 4.5',
		family: 'claude',
		version: 'sonnet-4.5',
		detail: 'Balanced reasoning (Anthropic protocol)',
		maxInputTokens: 200_000,
		maxOutputTokens: 131_072,
		capabilities: { ...CAPS_THINKING },
		requiresThinkingParam: true,
		supportsReasoningEffort: true,
		endpointPreset: 'opencode-zen-anthropic',
		pricing: { USD: { cacheHitInput: 0.3, cacheMissInput: 3.0, output: 15.0 } },
		priceCategory: 'high',
	},
	{
		id: 'deepseek-v4-flash-free',
		name: 'DeepSeek V4 Flash Free',
		family: 'deepseek',
		version: 'v4-flash-free',
		detail: 'Free fast coding model (limited time)',
		maxInputTokens: 128_000,
		maxOutputTokens: 131_072,
		capabilities: { ...CAPS_FREE_TIER },
		requiresThinkingParam: false,
		endpointPreset: 'opencode-zen',
		priceCategory: 'low',
	},
];

/** The curated fallback baselines (see {@link FALLBACK_MODELS}). */
export function getFallbackModels(): readonly ModelDefinition[] {
	return FALLBACK_MODELS;
}

// ---- API response types ----

/**
 * `ModelRef`s for every free-tier OpenCode model. Used by the agent swarm's
 * runtime audit (`auditFreeModels`) to probe which free models are alive
 * before research/review/implementer-fallback begin a run.
 *
 * `vendor: 'glm'` matches the extension's declared
 * {@link LanguageModelChatProvider} vendor — Copilot Chat's
 * `selectChatModels` keys off `id` first (when set), so family mismatches
 * are not a concern.
 *
 * Order is the catalogue's natural ordering (Big Pickle / DeepSeek V4 Flash
 * Free first — the historical defaults) so the audit's stable sort by
 * latency keeps a deterministic ordering for models with equal response time.
 */
export const FREE_MODEL_REFS: readonly { vendor: 'glm'; family: string; id: string }[] = [
	{ vendor: 'glm', family: 'pickle', id: 'big-pickle' },
	{ vendor: 'glm', family: 'deepseek', id: 'deepseek-v4-flash-free' },
	{ vendor: 'glm', family: 'mimo', id: 'mimo-v2.5-free' },
	{ vendor: 'glm', family: 'north', id: 'north-mini-code-free' },
	{ vendor: 'glm', family: 'nemotron', id: 'nemotron-3-ultra-free' },
	{ vendor: 'glm', family: 'laguna', id: 'laguna-s-2.1-free' },
	{ vendor: 'glm', family: 'ling', id: 'ling-3.0-flash-free' },
];

interface OpenCodeModelEntry {
	id: string;
	object: string;
	created: number;
	owned_by: string;
}

interface OpenCodeModelListResponse {
	object: string;
	data: OpenCodeModelEntry[];
}

// ---- Fetching ----

/**
 * Fetch model IDs from one OpenCode API endpoint.
 * Returns an empty set on error so the caller can fall back gracefully.
 */
async function fetchModelIdsFromEndpoint(url: string): Promise<ReadonlySet<string>> {
	try {
		const response = await fetch(url, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			logger.warn(`OpenCode model list fetch failed (${response.status}): ${url}`);
			return new Set();
		}
		const body = (await response.json()) as OpenCodeModelListResponse;
		if (!Array.isArray(body.data)) {
			return new Set();
		}
		return new Set(body.data.map((m) => m.id));
	} catch (error) {
		logger.warn(`OpenCode model list fetch error: ${url}`, error);
		return new Set();
	}
}

/**
 * Fetch model IDs for both OpenCode catalogs — the Go subscription
 * (`/zen/go/v1/models`) and Zen pay-as-you-go (`/zen/v1/models`). Each side
 * returns an empty set on error so the caller can fall back gracefully.
 */
export async function fetchOpenCodeCatalogIds(): Promise<{
	go: ReadonlySet<string>;
	zen: ReadonlySet<string>;
}> {
	const [go, zen] = await Promise.all([
		fetchModelIdsFromEndpoint(OPENCODE_GO_MODELS_URL),
		fetchModelIdsFromEndpoint(OPENCODE_ZEN_MODELS_URL),
	]);
	logger.info(`Fetched ${go.size} Go + ${zen.size} Zen models from the OpenCode catalogs`);
	return { go, zen };
}

// ---- Auto-generation for unknown models ----

/**
 * Derive a placeholder display name from a raw model ID. Purely algorithmic —
 * no vendor tables. models.dev enrichment replaces this with the official
 * name moments later (it lists every OpenCode model); this only paints the
 * first frame and covers models models.dev does not know yet.
 *
 * Rules: title-case words, keep word+digit tokens together (`qwen3.8-max` →
 * "Qwen3.8 Max"), and join trailing numeric segments with `.` —
 * `claude-opus-4-8` → "Claude Opus 4.8".
 */
export function displayNameFromId(id: string): string {
	const words: string[] = [];
	for (const segment of id.split('-')) {
		if (/^\d+(\.\d+)*$/.test(segment)) {
			const previous = words.at(-1);
			if (previous !== undefined && /\d$/.test(previous)) {
				words[words.length - 1] += `.${segment}`;
			} else {
				words.push(segment);
			}
			continue;
		}
		words.push(casingForWord(segment));
	}
	return words.join(' ');
}

function casingForWord(segment: string): string {
	const match = segment.toLowerCase().match(/^([a-z]+)(\d.*)?$/);
	if (!match) {
		return capitalize(segment.toLowerCase());
	}
	const word = capitalize(match[1]);
	return match[2] ? `${word}${match[2]}` : word;
}

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Derive a family name from a raw model ID. */
function familyFromId(id: string): string {
	const firstSegment = id.split('-')[0];
	return firstSegment.toLowerCase();
}

/** Build a ModelDefinition for an unknown model not in the fallback set. */
function generateDefaultModel(id: string, origin: 'go' | 'zen'): ModelDefinition {
	return {
		id,
		name: displayNameFromId(id),
		family: familyFromId(id),
		version: id,
		// No `detail` — models.dev enrichment fills it with its short
		// description; mergeWithModelsDev only writes when this is empty.
		maxInputTokens: 128_000,
		maxOutputTokens: 32_768,
		capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: false, thinking: false },
		requiresThinkingParam: false,
		endpointPreset: resolveEndpointPresetForId(id, origin),
	};
}

// ---- Model list construction ----

/** Utility model IDs that should always be included regardless of API response. */
const UTILITY_MODEL_IDS = new Set(['copilot-utility', 'copilot-utility-small']);

/**
 * Build the dynamic model list from both catalogs' fetched IDs + metadata
 * overlay.
 *
 * Merge priority (lowest → highest): curated fallback → fetched IDs → custom
 * models. For each fetched ID:
 *   - If in overlay → use overlay metadata (which pins its own endpoint)
 *   - If not in overlay → auto-generate with sensible defaults, pinned to the
 *     catalog it came from (Go wins when a model is served on both, since the
 *     subscription covers it)
 *
 * Seeding with the fallback first means a partial outage (one catalog
 * unreachable) still serves the four well-known baseline models alongside
 * whatever catalog did respond.
 */
export function buildDynamicModels(
	catalogs: { go: ReadonlySet<string>; zen: ReadonlySet<string> },
	customModels: readonly ModelDefinition[],
	fallbackModels: readonly ModelDefinition[],
): ModelDefinition[] {
	const byId = new Map<string, ModelDefinition>();

	// 0. Curated baseline — overridden by any fetched/custom entry below.
	for (const model of fallbackModels) {
		byId.set(model.id, model);
	}

	// 1. Models from the API responses
	for (const [origin, ids] of [
		['go', catalogs.go],
		['zen', catalogs.zen],
	] as const) {
		for (const id of ids) {
			if (byId.has(id)) {
				continue; // served on both catalogs → keep the Go pin
			}
			byId.set(id, generateDefaultModel(id, origin));
		}
	}

	// 2. Always include utility models (may not appear in API)
	for (const id of UTILITY_MODEL_IDS) {
		if (!byId.has(id)) {
			byId.set(id, generateDefaultModel(id, 'go'));
		}
	}

	// 3. Merge user-supplied custom models (highest priority)
	for (const model of customModels) {
		byId.set(model.id, model);
	}

	return [...byId.values()];
}

/**
 * Get the dynamic model list with caching.
 *
 * On the first call (or after cache expiry), fetches from the OpenCode API.
 * On network failure, falls back to the static MODELS array from consts.ts
 * so the extension remains functional offline.
 */
export async function getDynamicModels(
	customModels: readonly ModelDefinition[],
	fallbackModels: readonly ModelDefinition[],
): Promise<readonly ModelDefinition[]> {
	const now = Date.now();
	if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
		return cachedModels;
	}

	const catalogs = await fetchOpenCodeCatalogIds();

	// If both APIs returned zero models (likely a network issue), use fallback
	if (catalogs.go.size === 0 && catalogs.zen.size === 0) {
		logger.warn('OpenCode API returned no models — falling back to static model list');
		const byId = new Map(fallbackModels.map((m) => [m.id, m]));
		for (const model of customModels) {
			byId.set(model.id, model);
		}
		cachedModels = [...byId.values()];
		// Backdate the cache so a failed fetch (e.g. startup before the VPN is
		// up) is retried after FAILED_FETCH_RETRY_MS, not after a full TTL.
		cacheTimestamp = now - (CACHE_TTL_MS - FAILED_FETCH_RETRY_MS);
		return cachedModels;
	}

	cachedModels = buildDynamicModels(catalogs, customModels, fallbackModels);
	// Enrich with models.dev metadata (context windows, pricing, capabilities).
	// Falls back silently to overlay-only data on network failure.
	const enriched = [...await mergeModelListWithModelsDev(cachedModels)];
	cachedModels = enriched;
	cacheTimestamp = now;
	return enriched;
}

/** Whether the dynamic catalog is past its TTL (or was never fetched) and should be re-fetched. */
export function isDynamicModelsStale(): boolean {
	return !cachedModels || Date.now() - cacheTimestamp >= CACHE_TTL_MS;
}

/**
 * Invalidate the cache so the next call to `getDynamicModels` re-fetches.
 */
export function invalidateModelCache(): void {
	cachedModels = undefined;
	cacheTimestamp = 0;
	invalidateModelsDevCache();
}
