import type { EndpointPreset } from './types';

// ---- OpenCode Go (https://opencode.ai/docs/go) ----
export const OPENCODE_GO_API_HOST = 'opencode.ai';
export const OPENCODE_GO_OPENAI_BASE_URL = `https://${OPENCODE_GO_API_HOST}/zen/go/v1`;
export const OPENCODE_GO_ANTHROPIC_BASE_URL = `https://${OPENCODE_GO_API_HOST}/zen/go`;
export const OPENCODE_GO_API_KEY_URL = 'https://opencode.ai/auth';
/** OpenCode Go usage console (where subscribers track their Go quota). */
export const OPENCODE_GO_USAGE_CONSOLE_URL = 'https://opencode.ai/auth';

// ---- OpenCode Zen (https://opencode.ai/docs/zen) ----
export const OPENCODE_ZEN_OPENAI_BASE_URL = `https://${OPENCODE_GO_API_HOST}/zen/v1`;
export const OPENCODE_ZEN_ANTHROPIC_BASE_URL = `https://${OPENCODE_GO_API_HOST}/zen`;
export const OPENCODE_ZEN_API_KEY_URL = 'https://opencode.ai/auth';

/** OpenCode plans with separate API keys and model catalogs. */
export type OpencodePlan = 'go' | 'zen';

const LEGACY_ENDPOINT_PRESETS: Readonly<Record<string, EndpointPreset>> = {
	'china-coding': 'opencode-go',
	'china-standard': 'opencode-go',
	'china-anthropic': 'opencode-go-anthropic',
	'international-coding': 'opencode-zen',
	'international-standard': 'opencode-zen',
	'international-anthropic': 'opencode-zen-anthropic',
};

export function resolveEndpointBaseUrl(preset: EndpointPreset): string {
	switch (preset) {
		case 'opencode-go':
			return OPENCODE_GO_OPENAI_BASE_URL;
		case 'opencode-go-anthropic':
			return OPENCODE_GO_ANTHROPIC_BASE_URL;
		case 'opencode-zen':
			return OPENCODE_ZEN_OPENAI_BASE_URL;
		case 'opencode-zen-anthropic':
			return OPENCODE_ZEN_ANTHROPIC_BASE_URL;
	}
}

export function resolveEndpointApiKeyUrl(preset: EndpointPreset): string {
	switch (preset) {
		case 'opencode-go':
		case 'opencode-go-anthropic':
			return OPENCODE_GO_API_KEY_URL;
		case 'opencode-zen':
		case 'opencode-zen-anthropic':
			return OPENCODE_ZEN_API_KEY_URL;
	}
}

export function resolveEndpointProtocol(preset: EndpointPreset): 'openai' | 'anthropic' {
	return preset === 'opencode-go-anthropic' || preset === 'opencode-zen-anthropic'
		? 'anthropic'
		: 'openai';
}

/** Map legacy GLM endpoint preset strings onto the nearest OpenCode preset. */
export function normalizeLegacyEndpointPreset(value: unknown): EndpointPreset | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	if (
		value === 'opencode-go' ||
		value === 'opencode-go-anthropic' ||
		value === 'opencode-zen' ||
		value === 'opencode-zen-anthropic'
	) {
		return value;
	}
	return LEGACY_ENDPOINT_PRESETS[value];
}

export function isOpencodeBaseUrl(baseUrl: string): boolean {
	try {
		return new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase() === OPENCODE_GO_API_HOST;
	} catch {
		return false;
	}
}

/** OpenCode-managed hosts where the extension may tune helper requests. */
export function isManagedEndpointBaseUrl(baseUrl: string): boolean {
	return isOpencodeBaseUrl(baseUrl);
}

export function resolveOpencodePlanForBaseUrl(baseUrl: string): OpencodePlan | undefined {
	if (!isOpencodeBaseUrl(baseUrl)) {
		return undefined;
	}
	return baseUrl.includes('/zen/go') ? 'go' : 'zen';
}

export function resolvePlanDefaultEndpoint(plan: OpencodePlan): EndpointPreset {
	return plan === 'zen' ? 'opencode-zen' : 'opencode-go';
}

export function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/u, '');
}
