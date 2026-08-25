import type { ApiProtocol, EndpointPreset } from './types';

// Hosts of the GLM/Z.ai platforms. No longer used as first-class endpoint
// presets, but still sniffed so users who point `baseUrl` at them manually
// get the right error mapping, request flags, and CNY pricing.
export const GLM_CN_API_HOST = 'open.bigmodel.cn';
export const GLM_CN_LEGACY_API_HOST = 'dev.bigmodel.cn';
export const GLM_INTERNATIONAL_API_HOST = 'api.z.ai';

// ---- OpenCode Go (https://opencode.ai/docs/go) ----
//
// OpenCode Go is a low-cost subscription that serves a curated set of open
// coding models behind a single API key. The OpenAI-compatible endpoint is
// reached at `…/v1/chat/completions` and the Anthropic-compatible endpoint at
// `…/v1/messages`. Because the client appends `/chat/completions` (OpenAI) or
// `/v1/messages` (Anthropic) to the base URL, the two presets use different
// base URLs so the final request URLs line up exactly with the docs.
export const OPENCODE_GO_API_HOST = 'opencode.ai';
export const OPENCODE_GO_OPENAI_BASE_URL = `https://${OPENCODE_GO_API_HOST}/zen/go/v1`;
export const OPENCODE_GO_ANTHROPIC_BASE_URL = `https://${OPENCODE_GO_API_HOST}/zen/go`;
export const OPENCODE_GO_API_KEY_URL = 'https://opencode.ai/auth';
/** OpenCode Go usage console (where subscribers track their Go quota). */
export const OPENCODE_GO_USAGE_CONSOLE_URL = 'https://opencode.ai/auth';

// ---- OpenCode Zen (https://opencode.ai/docs/zen) ----
//
// OpenCode Zen is a pay-as-you-go AI gateway that serves a curated set of
// coding models. The OpenAI-compatible endpoint is at `…/v1/chat/completions`
// and the Anthropic-compatible endpoint at `…/v1/messages`. Because the client
// appends `/chat/completions` (OpenAI) or `/v1/messages` (Anthropic), the two
// presets need different base URLs so the final request URLs line up exactly.
export const OPENCODE_ZEN_OPENAI_BASE_URL = `https://${OPENCODE_GO_API_HOST}/zen/v1`;
export const OPENCODE_ZEN_ANTHROPIC_BASE_URL = `https://${OPENCODE_GO_API_HOST}/zen`;
export const OPENCODE_ZEN_API_KEY_URL = 'https://opencode.ai/auth';

/**
 * Resolve the base URL for a single `endpoint` preset value.
 *
 * The preset encodes plan + protocol in one enum: the base URL plus the
 * client-appended `/chat/completions` (OpenAI) or `/v1/messages` (Anthropic)
 * must line up exactly with the OpenCode docs.
 */
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

/**
 * Resolve the "request an API key" landing page for a single preset value.
 */
export function resolveEndpointApiKeyUrl(preset: EndpointPreset): string {
	return preset === 'opencode-go' || preset === 'opencode-go-anthropic'
		? OPENCODE_GO_API_KEY_URL
		: OPENCODE_ZEN_API_KEY_URL;
}

/**
 * The wire protocol implied by a preset value.
 */
export function resolveEndpointProtocol(preset: EndpointPreset): ApiProtocol {
	return preset === 'opencode-go-anthropic' || preset === 'opencode-zen-anthropic'
		? 'anthropic'
		: 'openai';
}

/** The GLM/Z.ai platforms still recognized for manual `baseUrl` overrides. */
export type OfficialGLMPlatform = 'zhipu' | 'zai';

export function identifyOfficialGLMPlatform(baseUrl: string): OfficialGLMPlatform | undefined {
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		if (host === GLM_INTERNATIONAL_API_HOST) {
			return 'zai';
		}
		if (host === GLM_CN_API_HOST || host === GLM_CN_LEGACY_API_HOST) {
			return 'zhipu';
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export function isOfficialGLMBaseUrl(baseUrl: string): boolean {
	return identifyOfficialGLMPlatform(baseUrl) !== undefined;
}

/**
 * Whether a base URL points at the OpenCode Go subscription endpoint.
 *
 * OpenCode Go is intentionally NOT classified as an "official GLM" platform:
 * it does not accept GLM-specific request flags (e.g. `tool_stream`) and its
 * error model differs from the Zhipu/Z.ai business error codes. Pricing for
 * OpenCode Go is USD, resolved separately in `getPricingCurrencyForBaseUrl`.
 */
export function isOpencodeBaseUrl(baseUrl: string): boolean {
	try {
		return new URL(normalizeBaseUrl(baseUrl)).hostname.toLowerCase() === OPENCODE_GO_API_HOST;
	} catch {
		return false;
	}
}

/** The two OpenCode plans sharing one API key; the URL path picks billing. */
export type OpencodePlan = 'go' | 'zen';

/** Which OpenCode plan a base URL serves — `undefined` for non-OpenCode hosts. */
export function resolveOpencodePlanForBaseUrl(baseUrl: string): OpencodePlan | undefined {
	if (!isOpencodeBaseUrl(baseUrl)) {
		return undefined;
	}
	// Go endpoints live under `/zen/go` (OpenAI and Anthropic). Zen endpoints
	// use `/zen/v1` or `/zen`. Anchor the check so a Zen URL containing
	// `/zen/go` as a substring (e.g. `/zen/v1/models/zen/grok-x`) is not
	// misclassified as Go and billed on the wrong plan.
	try {
		const path = new URL(normalizeBaseUrl(baseUrl)).pathname;
		return path === '/zen/go' || path.startsWith('/zen/go/') ? 'go' : 'zen';
	} catch {
		return undefined;
	}
}

/** Endpoint preset used when nothing is explicitly configured. */
export function resolvePlanDefaultEndpoint(plan: OpencodePlan): EndpointPreset {
	return plan === 'zen' ? 'opencode-zen' : 'opencode-go';
}

export function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/u, '');
}
