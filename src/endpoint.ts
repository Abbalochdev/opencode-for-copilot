import type { ApiMode, ApiRegion, EndpointPreset } from './types';

export const GLM_CN_API_HOST = 'open.bigmodel.cn';
export const GLM_CN_LEGACY_API_HOST = 'dev.bigmodel.cn';
export const GLM_INTERNATIONAL_API_HOST = 'api.z.ai';

export const GLM_CN_CODING_BASE_URL = `https://${GLM_CN_API_HOST}/api/coding/paas/v4`;
export const GLM_CN_GENERAL_BASE_URL = `https://${GLM_CN_API_HOST}/api/paas/v4`;
export const GLM_CN_ANTHROPIC_BASE_URL = `https://${GLM_CN_API_HOST}/api/anthropic`;
export const GLM_INTERNATIONAL_CODING_BASE_URL = `https://${GLM_INTERNATIONAL_API_HOST}/api/coding/paas/v4`;
export const GLM_INTERNATIONAL_GENERAL_BASE_URL = `https://${GLM_INTERNATIONAL_API_HOST}/api/paas/v4`;
export const GLM_INTERNATIONAL_ANTHROPIC_BASE_URL = `https://${GLM_INTERNATIONAL_API_HOST}/api/anthropic`;
export const DEFAULT_GLM_BASE_URL = GLM_CN_CODING_BASE_URL;

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
 * Default endpoint preset — domestic Coding Plan over the OpenAI protocol.
 *
 * Kept in sync with `DEFAULT_GLM_BASE_URL` so that the legacy single-setting
 * fallback and the new enum-based selection resolve to the same URL.
 */
export const DEFAULT_ENDPOINT_PRESET: EndpointPreset = 'china-coding';

export const GLM_CN_CODING_API_KEY_URL = 'https://bigmodel.cn/coding-plan/personal/overview';
export const GLM_CN_GENERAL_API_KEY_URL = 'https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys';
export const GLM_INTERNATIONAL_CODING_API_KEY_URL = 'https://z.ai/manage-apikey/subscription';
export const GLM_INTERNATIONAL_GENERAL_API_KEY_URL = 'https://z.ai/manage-apikey/apikey-list';

export type OfficialGLMPlatform = 'zhipu' | 'zai';

export function resolvePresetBaseUrl(apiMode: ApiMode, region: ApiRegion): string {
	if (region === 'international') {
		return apiMode === 'standard'
			? GLM_INTERNATIONAL_GENERAL_BASE_URL
			: GLM_INTERNATIONAL_CODING_BASE_URL;
	}
	return apiMode === 'standard' ? GLM_CN_GENERAL_BASE_URL : GLM_CN_CODING_BASE_URL;
}

export function resolveAnthropicBaseUrl(region: ApiRegion): string {
	// Both the CN (open.bigmodel.cn) and international (api.z.ai) platforms
	// expose an Anthropic-compatible `/api/anthropic` endpoint for Coding Plan.
	return region === 'international'
		? GLM_INTERNATIONAL_ANTHROPIC_BASE_URL
		: GLM_CN_ANTHROPIC_BASE_URL;
}

/**
 * Resolve the base URL for a single `endpoint` preset value.
 *
 * The preset encodes region + mode + protocol in one enum, removing the
 * combinatorial confusion of the legacy region/apiMode/apiProtocol trio.
 * The legacy resolver helpers above remain for backward compatibility.
 */
export function resolveEndpointBaseUrl(preset: EndpointPreset): string {
	switch (preset) {
		case 'china-coding':
			return GLM_CN_CODING_BASE_URL;
		case 'china-standard':
			return GLM_CN_GENERAL_BASE_URL;
		case 'china-anthropic':
			return GLM_CN_ANTHROPIC_BASE_URL;
		case 'international-coding':
			return GLM_INTERNATIONAL_CODING_BASE_URL;
		case 'international-standard':
			return GLM_INTERNATIONAL_GENERAL_BASE_URL;
		case 'international-anthropic':
			return GLM_INTERNATIONAL_ANTHROPIC_BASE_URL;
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
	switch (preset) {
		case 'china-coding':
			return GLM_CN_CODING_API_KEY_URL;
		case 'china-standard':
			return GLM_CN_GENERAL_API_KEY_URL;
		case 'china-anthropic':
			return GLM_CN_CODING_API_KEY_URL;
		case 'international-coding':
			return GLM_INTERNATIONAL_CODING_API_KEY_URL;
		case 'international-standard':
			return GLM_INTERNATIONAL_GENERAL_API_KEY_URL;
		case 'international-anthropic':
			return GLM_INTERNATIONAL_CODING_API_KEY_URL;
		case 'opencode-go':
		case 'opencode-go-anthropic':
			return OPENCODE_GO_API_KEY_URL;
		case 'opencode-zen':
		case 'opencode-zen-anthropic':
			return OPENCODE_ZEN_API_KEY_URL;
	}
}

/**
 * The wire protocol implied by a preset value.
 */
export function resolveEndpointProtocol(preset: EndpointPreset): 'openai' | 'anthropic' {
	return preset === 'china-anthropic' ||
		preset === 'international-anthropic' ||
		preset === 'opencode-go-anthropic' ||
		preset === 'opencode-zen-anthropic'
		? 'anthropic'
		: 'openai';
}

/**
 * Map the legacy (region, apiMode, apiProtocol) tuple onto the closest
 * `endpoint` preset. Used to migrate existing user settings transparently.
 *
 * `apiProtocol === "anthropic"` wins over `apiMode` because the protocol
 * uniquely implies the Anthropic endpoint path, while `apiMode` only varies
 * the OpenAI-style path.
 */
export function deriveEndpointPreset(
	region: ApiRegion,
	apiMode: ApiMode,
	apiProtocol: 'openai' | 'anthropic',
): EndpointPreset {
	if (apiProtocol === 'anthropic') {
		return region === 'international' ? 'international-anthropic' : 'china-anthropic';
	}
	if (region === 'international') {
		return apiMode === 'standard' ? 'international-standard' : 'international-coding';
	}
	return apiMode === 'standard' ? 'china-standard' : 'china-coding';
}

export function resolveApiKeyUrl(apiMode: ApiMode, region: ApiRegion): string {
	if (region === 'international') {
		return apiMode === 'standard'
			? GLM_INTERNATIONAL_GENERAL_API_KEY_URL
			: GLM_INTERNATIONAL_CODING_API_KEY_URL;
	}
	return apiMode === 'standard' ? GLM_CN_GENERAL_API_KEY_URL : GLM_CN_CODING_API_KEY_URL;
}

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

export function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/u, '');
}
