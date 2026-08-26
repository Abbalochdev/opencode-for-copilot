import { isOpencodeBaseUrl, normalizeBaseUrl } from '../../endpoint';
import type { PricingCurrency } from '../../types';

/** OpenCode Go and Zen expose USD pricing in the model picker. */
export function getPricingCurrencyForBaseUrl(baseUrl: string): PricingCurrency | undefined {
	return isOpencodeBaseUrl(normalizeBaseUrl(baseUrl)) ? 'USD' : undefined;
}
