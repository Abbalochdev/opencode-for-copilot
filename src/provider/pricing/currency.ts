import { identifyOfficialGLMPlatform, isOpencodeBaseUrl, normalizeBaseUrl } from '../../endpoint';
import type { PricingCurrency } from '../../types';

/**
 * The GLM domestic and international endpoints expose different currencies.
 * There is no stable balance endpoint in the OpenAI-compatible API path, so
 * model-picker pricing uses the endpoint host instead of probing account state.
 *
 * OpenCode Go (https://opencode.ai/docs/go) is billed in USD regardless of the
 * user's region, so it always resolves to USD.
 */
export function getPricingCurrencyForBaseUrl(baseUrl: string): PricingCurrency | undefined {
	const normalized = normalizeBaseUrl(baseUrl);
	if (isOpencodeBaseUrl(normalized)) {
		return 'USD';
	}
	const platform = identifyOfficialGLMPlatform(normalized);
	if (platform === 'zhipu') {
		return 'CNY';
	}
	if (platform === 'zai') {
		return 'USD';
	}
	return undefined;
}
