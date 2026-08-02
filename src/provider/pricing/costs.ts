import type { ModelDefinition, PriceCategory, PricingCurrency } from '../../types';

/**
 * VS Code's proposed cost fields are numeric credits per 1M tokens — the
 * Copilot model picker renders the numbers itself (own units, own currency
 * symbol). Formatted strings like "$0.95" in these fields parse as NaN in
 * current UI builds and render as "Unknown", so pass raw numbers.
 *
 * Mapping:
 * - inputCost  <- cacheMissInput, the representative non-cached input price.
 * - cacheCost  <- cacheHitInput, shown separately as the cached-input tier.
 * - outputCost <- output.
 *
 * priceCategory is emitted only together with concrete official pricing; incomplete
 * pricing intentionally suppresses all cost metadata.
 */
export interface ModelCostInformation {
	readonly inputCost?: number;
	readonly outputCost?: number;
	readonly cacheCost?: number;
	readonly priceCategory?: PriceCategory;
}

export function toModelCostInfo(
	model: ModelDefinition,
	currency?: PricingCurrency,
): ModelCostInformation {
	if (!currency) {
		return {};
	}

	const pricing = model.pricing?.[currency];
	if (!pricing) {
		return {};
	}

	return {
		...(model.priceCategory ? { priceCategory: model.priceCategory } : {}),
		inputCost: pricing.cacheMissInput,
		outputCost: pricing.output,
		cacheCost: pricing.cacheHitInput,
	};
}
