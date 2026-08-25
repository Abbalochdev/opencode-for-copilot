/**
 * models.dev metadata integration.
 *
 * Fetches model metadata from https://models.dev/api.json and merges it into
 * the locally-defined models. The local definitions (fallback baselines plus
 * family-rule defaults) remain the source of truth for endpoint-preset
 * pinning and requiresThinkingParam; models.dev provides accurate context
 * windows, output limits, capabilities, reasoning options, and USD pricing —
 * eliminating the need to manually update these per release.
 *
 * The snapshot is cached in memory (30-min TTL) and, when storage is wired
 * in via `setModelsDevSnapshotStorage`, persisted for cold-start reuse and
 * revalidated with a conditional (ETag) request. On network failure the
 * newest cached copy is served so the extension remains functional offline.
 */

import { logger } from '../logger';
import type { ModelDefinition, ModelPricing } from '../types';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT_MS = 10_000;
const SNAPSHOT_STORAGE_KEY = 'modelsDevSnapshot.v1';

// ---- models.dev API types (subset) ----

interface ModelsDevCost {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write?: number;
}

interface ModelsDevLimit {
	context?: number;
	output?: number;
}

interface ModelsDevReasoningOption {
	type?: string;
	values?: string[];
}

export interface ModelsDevModel {
	id: string;
	name?: string;
	description?: string;
	family?: string;
	attachment?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	tool_call?: boolean;
	deprecated?: boolean;
	temperature?: boolean;
	modalities?: {
		input?: string[];
		output?: string[];
	};
	limit?: ModelsDevLimit;
	cost?: ModelsDevCost;
}

interface ModelsDevProvider {
	id: string;
	name?: string;
	models: Record<string, ModelsDevModel>;
}

type ModelsDevResponse = Record<string, ModelsDevProvider>;

// ---- Cache ----

let cachedSnapshot: Map<string, ModelsDevModel> | undefined;
let cacheTimestamp = 0;
let lastEtag: string | undefined;
let inFlightFetch: Promise<Map<string, ModelsDevModel>> | undefined;

/**
 * Minimal key/value store the snapshot can be persisted to. Hook up
 * `ExtensionContext.globalState` via `setModelsDevSnapshotStorage`. No-op
 * until set, so the module stays functional and testable without VS Code.
 */
export interface SnapshotStorage {
	get(key: string): unknown;
	update(key: string, value: string): PromiseLike<void>;
}

let snapshotStorage: SnapshotStorage | undefined;

/** Enable cold-start persistence of the models.dev snapshot. */
export function setModelsDevSnapshotStorage(storage: SnapshotStorage | undefined): void {
	snapshotStorage = storage;
}

interface PersistedEnvelope {
	etag?: string;
	snapshot: Array<[string, ModelsDevModel]>;
}

function serializeSnapshot(): string {
	const envelope: PersistedEnvelope = {
		etag: lastEtag,
		snapshot: cachedSnapshot ? [...cachedSnapshot.entries()] : [],
	};
	return JSON.stringify(envelope);
}

function deserializeSnapshot(raw: string | undefined): PersistedEnvelope | undefined {
	if (!raw) {
		return undefined;
	}
	try {
		const envelope = JSON.parse(raw) as PersistedEnvelope;
		if (!Array.isArray(envelope.snapshot)) {
			return undefined;
		}
		return envelope;
	} catch (error) {
		logger.warn('models.dev persisted snapshot ignored (corrupt):', error);
		return undefined;
	}
}

async function persistSnapshot(): Promise<void> {
	if (!snapshotStorage) {
		return;
	}
	try {
		await snapshotStorage.update(SNAPSHOT_STORAGE_KEY, serializeSnapshot());
	} catch (error) {
		logger.warn('models.dev snapshot persistence failed:', error);
	}
}

/** Serve the persisted snapshot on cold start (stale-while-revalidate). */
function restorePersistedSnapshot(): void {
	if (cachedSnapshot || !snapshotStorage) {
		return;
	}
	const envelope = deserializeSnapshot(snapshotStorage.get(SNAPSHOT_STORAGE_KEY) as string | undefined);
	if (envelope && envelope.snapshot.length > 0) {
		cachedSnapshot = new Map(envelope.snapshot);
		cacheTimestamp = 0; // stale — force a revalidation below
		if (envelope.etag) {
			lastEtag = envelope.etag;
		}
	}
}

/**
 * Fetch and index models.dev metadata by model ID.
 * Returns an empty map on failure so callers fall back to the overlay.
 *
 * Cold start: a persisted snapshot is served immediately and revalidated in
 * the background, so an offline restart still shows last-known limits.
 * Expired in-memory snapshots refresh single-flight (concurrent callers
 * share one network request).
 */
export async function fetchModelsDevSnapshot(): Promise<Map<string, ModelsDevModel>> {
	if (!cachedSnapshot) {
		restorePersistedSnapshot();
		if (cachedSnapshot) {
			// Stale-but-persisted beats waiting on the network at startup.
			void refreshSnapshot();
			return cachedSnapshot;
		}
	}

	if (cachedSnapshot && Date.now() - cacheTimestamp < CACHE_TTL_MS) {
		return cachedSnapshot;
	}
	return refreshSnapshot();
}

/** Single-flight refresh; returns the current snapshot on network failure. */
function refreshSnapshot(): Promise<Map<string, ModelsDevModel>> {
	if (!inFlightFetch) {
		inFlightFetch = doFetch()
			.then((snapshot) => {
				cachedSnapshot = snapshot;
				cacheTimestamp = Date.now();
				return snapshot;
			})
			.catch((error) => {
				logger.warn('models.dev fetch error:', error);
				return cachedSnapshot ?? new Map();
			})
			.finally(() => {
				inFlightFetch = undefined;
			});
	}
	return inFlightFetch;
}

async function doFetch(): Promise<Map<string, ModelsDevModel>> {
	const headers: Record<string, string> = { Accept: 'application/json' };
	if (lastEtag) {
		headers['If-None-Match'] = lastEtag;
	}
	const response = await fetch(MODELS_DEV_URL, {
		headers,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (response.status === 304) {
		// Not modified — keep cached snapshot (note: 304 has `ok === false`).
		return cachedSnapshot ?? new Map();
	}
	if (!response.ok) {
		logger.warn(`models.dev fetch failed (${response.status})`);
		return cachedSnapshot ?? new Map();
	}
	const body = (await response.json()) as ModelsDevResponse;

	const index = new Map<string, ModelsDevModel>();
	// Several providers expose the same bare model ID (opencode-go, opencode
	// Zen, plus upstream mirrors). Prefer OpenCode-owned entries for names and
	// pricing deterministically — JSON key order must not decide the winner.
	const PROVIDER_PRIORITY: Record<string, number> = { 'opencode-go': 0, opencode: 1 };
	const entryPriority = new Map<string, number>();
	for (const [providerKey, provider] of Object.entries(body)) {
		if (!provider?.models) continue;
		const priority = PROVIDER_PRIORITY[providerKey] ?? Number.MAX_SAFE_INTEGER;
		for (const model of Object.values(provider.models)) {
			if (!model?.id) {
				continue;
			}
			const existingPriority = entryPriority.get(model.id);
			if (existingPriority !== undefined && existingPriority <= priority) {
				continue;
			}
			index.set(model.id, model);
			entryPriority.set(model.id, priority);
		}
	}

	lastEtag = response.headers.get('etag') ?? undefined;
	logger.info(`models.dev: indexed ${index.size} models`);
	await persistSnapshot();
	return index;
}

/** Invalidate the cache so the next call re-fetches. */
export function invalidateModelsDevCache(): void {
	cachedSnapshot = undefined;
	cacheTimestamp = 0;
	lastEtag = undefined;
	inFlightFetch = undefined;
}

// ---- Merge logic ----

/**
 * Merge models.dev metadata into a model definition.
 *
 * The local definition wins for: endpointPreset, requiresThinkingParam,
 * priceCategory, preferredToolLimit, and any hand-tuned short `detail` blurb
 * (models.dev's `description` is a long paragraph that renders poorly in the
 * model picker — it's only used when the local definition has no `detail`).
 * models.dev wins for: maxInputTokens, maxOutputTokens, imageInput,
 * toolCalling, thinking, USD pricing, name.
 */
export function mergeWithModelsDev(
	base: ModelDefinition,
	devModel: ModelsDevModel | undefined,
): ModelDefinition {
	if (!devModel) {
		return base;
	}

	const merged: ModelDefinition = { ...base };

	// Display name (short title) — models.dev wins.
	if (devModel.name) {
		merged.name = devModel.name;
	}
	// NOTE: models.dev `description` is a full paragraph that wraps badly in
	// the Copilot model picker, so it is deliberately NOT surfaced as `detail`.
	// Only the curated overlay blurb (base.detail) is shown; models without one
	// simply render with their proper title and no subtitle.

	// Context and output limits
	if (devModel.limit?.context) {
		merged.maxInputTokens = devModel.limit.context;
	}
	if (devModel.limit?.output) {
		merged.maxOutputTokens = devModel.limit.output;
	}

	// Capabilities
	merged.capabilities = {
		...base.capabilities,
		toolCalling: devModel.tool_call ?? base.capabilities.toolCalling,
		imageInput: hasImageInput(devModel) ?? base.capabilities.imageInput,
		thinking: devModel.reasoning ?? base.capabilities.thinking,
	};

	// Deprecation — models.dev marks retired/unavailable entries.
	if (devModel.deprecated) {
		merged.deprecated = true;
	}

	// Reasoning effort support
	if (devModel.reasoning_options) {
		const hasEffort = devModel.reasoning_options.some((opt) => opt.type === 'effort');
		if (hasEffort) {
			merged.supportsReasoningEffort = true;
		}
	}

	// USD pricing — only set if models.dev provides cost data and the local
	// definition doesn't already have USD pricing.
	if (devModel.cost && !base.pricing?.USD) {
		const usdPricing = extractPricing(devModel.cost);
		if (usdPricing) {
			merged.pricing = {
				...base.pricing,
				USD: usdPricing,
			};
		}
	}

	return merged;
}

function hasImageInput(model: ModelsDevModel): boolean | undefined {
	const inputs = model.modalities?.input;
	if (!inputs) return undefined;
	return inputs.includes('image');
}

function extractPricing(cost: ModelsDevCost): ModelPricing | undefined {
	if (cost.input === undefined || cost.output === undefined) {
		return undefined;
	}
	return {
		cacheHitInput: cost.cache_read ?? cost.input,
		cacheMissInput: cost.input,
		output: cost.output,
	};
}

/**
 * Merge an entire model list with models.dev metadata.
 * Models not present in models.dev are returned unchanged.
 */
export async function mergeModelListWithModelsDev(
	models: readonly ModelDefinition[],
): Promise<readonly ModelDefinition[]> {
	const snapshot = await fetchModelsDevSnapshot();
	if (snapshot.size === 0) {
		return models;
	}

	return models.map((model) => {
		const devModel = findModelsDevEntry(snapshot, model.id);
		return devModel ? mergeWithModelsDev(model, devModel) : model;
	});
}

/**
 * Match a local model ID against an indexed models.dev snapshot.
 *
 * The OpenCode API returns bare IDs (e.g. `deepseek-v4-flash`) while models.dev
 * exposes the same model under one or more provider-prefixed entries, e.g.
 * `deepseek/deepseek-v4-flash` (official), `nvidia/deepseek-ai/deepseek-v4-flash`
 * (mirror), or `opencode/deepseek-v4-flash-free` (gateway free tier).
 *
 * Matching rules (in order):
 *   1. Exact map-key or `id` equality wins.
 *   2. Otherwise the last path segment must equal the local ID exactly —
 *      case-sensitive `endsWith('/' + id)` — so near-misses like
 *      `baseten/.../DeepSeek-V4-Flash-0731` never match `deepseek-v4-flash`.
 *   3. Among candidates, prefer the shallowest provider path: official
 *      entries (`deepseek/…`) beat mirrors (`nvidia/deepseek-ai/…`). Ties keep
 *      models.dev provider order.
 */
export function findModelsDevEntry(
	snapshot: Map<string, ModelsDevModel>,
	id: string,
): ModelsDevModel | undefined {
	const exact = snapshot.get(id);
	if (exact) {
		return exact;
	}

	const suffix = `/${id}`;
	let best: ModelsDevModel | undefined;
	let bestDepth = Number.MAX_SAFE_INTEGER;
	for (const model of snapshot.values()) {
		if (model.id === id || model.id.endsWith(suffix)) {
			const depth = model.id.split('/').length;
			if (depth < bestDepth) {
				best = model;
				bestDepth = depth;
			}
		}
	}
	return best;
}
