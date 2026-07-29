/**
 * models.dev metadata integration.
 *
 * Fetches model metadata from https://models.dev/api.json and merges it with
 * the local overlay. The overlay remains the source of truth for
 * endpoint-preset pinning and CNY pricing; models.dev provides accurate
 * context windows, output limits, capabilities, reasoning options, and USD
 * pricing — eliminating the need to manually update these per release.
 *
 * The merged result is cached with a TTL. On network failure, the overlay-only
 * fallback is used so the extension remains functional offline.
 */

import { logger } from '../logger';
import type {
    ModelDefinition,
    ModelPricing,
    PricingCurrency
} from '../types';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const FETCH_TIMEOUT_MS = 10_000;

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

interface ModelsDevModel {
	id: string;
	name?: string;
	description?: string;
	family?: string;
	attachment?: boolean;
	reasoning?: boolean;
	reasoning_options?: ModelsDevReasoningOption[];
	tool_call?: boolean;
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

/**
 * Fetch and index models.dev metadata by model ID.
 * Returns an empty map on failure so callers fall back to the overlay.
 */
export async function fetchModelsDevSnapshot(): Promise<Map<string, ModelsDevModel>> {
	const now = Date.now();
	if (cachedSnapshot && now - cacheTimestamp < CACHE_TTL_MS) {
		return cachedSnapshot;
	}

	try {
		const response = await fetch(MODELS_DEV_URL, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!response.ok) {
			logger.warn(`models.dev fetch failed (${response.status})`);
			return cachedSnapshot ?? new Map();
		}
		const body = (await response.json()) as ModelsDevResponse;

		const index = new Map<string, ModelsDevModel>();
		for (const provider of Object.values(body)) {
			if (!provider?.models) continue;
			for (const model of Object.values(provider.models)) {
				if (model?.id) {
					// First occurrence wins — opencode-go and opencode (Zen) may
					// both list the same model ID; the Go entry is typically
					// listed first and is the one we care about for Go models.
					if (!index.has(model.id)) {
						index.set(model.id, model);
					}
				}
			}
		}

		cachedSnapshot = index;
		cacheTimestamp = now;
		logger.info(`models.dev: indexed ${index.size} models`);
		return index;
	} catch (error) {
		logger.warn('models.dev fetch error:', error);
		return cachedSnapshot ?? new Map();
	}
}

/** Invalidate the cache so the next call re-fetches. */
export function invalidateModelsDevCache(): void {
	cachedSnapshot = undefined;
	cacheTimestamp = 0;
}

// ---- Merge logic ----

/**
 * Merge models.dev metadata into a model definition.
 *
 * The overlay wins for: endpointPreset, requiresThinkingParam,
 * supportsReasoningEffort, priceCategory, CNY pricing, preferredToolLimit.
 * models.dev wins for: maxInputTokens, maxOutputTokens, imageInput,
 * toolCalling, thinking, USD pricing, name, detail.
 */
export function mergeWithModelsDev(
	base: ModelDefinition,
	devModel: ModelsDevModel | undefined,
): ModelDefinition {
	if (!devModel) {
		return base;
	}

	const merged: ModelDefinition = { ...base };

	// Display name and description
	if (devModel.name) {
		merged.name = devModel.name;
	}
	if (devModel.description) {
		merged.detail = devModel.description;
	}

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

	// Reasoning effort support
	if (devModel.reasoning_options) {
		const hasEffort = devModel.reasoning_options.some((opt) => opt.type === 'effort');
		if (hasEffort) {
			merged.supportsReasoningEffort = true;
		}
	}

	// USD pricing — only set if models.dev provides cost data and the overlay
	// doesn't already have USD pricing (overlay CNY pricing is preserved).
	if (devModel.cost && !base.pricing?.USD) {
		const usdPricing = extractPricing(devModel.cost, 'USD');
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

function extractPricing(
	cost: ModelsDevCost,
	currency: PricingCurrency,
): ModelPricing | undefined {
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
		const devModel = snapshot.get(model.id);
		return devModel ? mergeWithModelsDev(model, devModel) : model;
	});
}
