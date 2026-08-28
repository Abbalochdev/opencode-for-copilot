import { describe, expect, it } from 'vitest';
import {
    GLM_CN_API_HOST,
    GLM_CN_LEGACY_API_HOST,
    GLM_INTERNATIONAL_API_HOST,
    OPENCODE_GO_ANTHROPIC_BASE_URL,
    OPENCODE_GO_API_HOST,
    OPENCODE_GO_API_KEY_URL,
    OPENCODE_GO_OPENAI_BASE_URL,
    OPENCODE_ZEN_ANTHROPIC_BASE_URL,
    OPENCODE_ZEN_API_KEY_URL,
    OPENCODE_ZEN_OPENAI_BASE_URL,
    identifyOfficialGLMPlatform,
    isOfficialGLMBaseUrl,
    isOpencodeBaseUrl,
    normalizeBaseUrl,
    resolveEndpointApiKeyUrl,
    resolveEndpointBaseUrl,
    resolveEndpointProtocol,
    resolveOpencodePlanForBaseUrl,
} from '../src/endpoint';

describe('endpoint helpers', () => {
	it('normalizes trailing slashes and surrounding whitespace', () => {
		expect(normalizeBaseUrl(' https://open.bigmodel.cn/api/paas/v4/// ')).toBe(
			'https://open.bigmodel.cn/api/paas/v4',
		);
	});

	it('identifies official GLM platforms by host', () => {
		expect(identifyOfficialGLMPlatform(`https://${GLM_INTERNATIONAL_API_HOST}/api/paas/v4`)).toBe(
			'zai',
		);
		expect(identifyOfficialGLMPlatform(`https://${GLM_CN_API_HOST}/api/paas/v4`)).toBe('zhipu');
		expect(identifyOfficialGLMPlatform(`https://${GLM_CN_LEGACY_API_HOST}/api/paas/v4`)).toBe(
			'zhipu',
		);
	});

	it('does not classify custom or invalid URLs as official', () => {
		expect(identifyOfficialGLMPlatform('https://proxy.example.com/v1')).toBeUndefined();
		expect(identifyOfficialGLMPlatform('not a url')).toBeUndefined();
		expect(isOfficialGLMBaseUrl('https://proxy.example.com/v1')).toBe(false);
	});

	it('identifies OpenCode URLs without treating them as official GLM', () => {
		expect(isOpencodeBaseUrl(OPENCODE_GO_OPENAI_BASE_URL)).toBe(true);
		expect(isOpencodeBaseUrl(OPENCODE_GO_ANTHROPIC_BASE_URL)).toBe(true);
		expect(isOpencodeBaseUrl(OPENCODE_ZEN_OPENAI_BASE_URL)).toBe(true);
		expect(isOpencodeBaseUrl(OPENCODE_ZEN_ANTHROPIC_BASE_URL)).toBe(true);
		expect(isOpencodeBaseUrl(`https://${OPENCODE_GO_API_HOST}/zen/go/v1/chat/completions`)).toBe(
			true,
		);
		// OpenCode is a separate platform — it must NOT be classified as official
		// GLM (no tool_stream, no GLM business error codes, no Zhipu/Z.ai links).
		expect(identifyOfficialGLMPlatform(OPENCODE_GO_OPENAI_BASE_URL)).toBeUndefined();
		expect(isOfficialGLMBaseUrl(OPENCODE_GO_OPENAI_BASE_URL)).toBe(false);
		expect(identifyOfficialGLMPlatform(OPENCODE_ZEN_OPENAI_BASE_URL)).toBeUndefined();
		expect(isOfficialGLMBaseUrl(OPENCODE_ZEN_OPENAI_BASE_URL)).toBe(false);
		expect(isOpencodeBaseUrl('https://api.z.ai/api/paas/v4')).toBe(false);
		expect(isOpencodeBaseUrl('not a url')).toBe(false);
	});
});

describe('resolveOpencodePlanForBaseUrl', () => {
	it('classifies Go endpoint paths as the Go plan', () => {
		expect(resolveOpencodePlanForBaseUrl(OPENCODE_GO_OPENAI_BASE_URL)).toBe('go');
		expect(resolveOpencodePlanForBaseUrl(OPENCODE_GO_ANTHROPIC_BASE_URL)).toBe('go');
		expect(
			resolveOpencodePlanForBaseUrl(`https://${OPENCODE_GO_API_HOST}/zen/go/v1/chat/completions`),
		).toBe('go');
	});

	it('classifies Zen endpoint paths as the Zen plan', () => {
		expect(resolveOpencodePlanForBaseUrl(OPENCODE_ZEN_OPENAI_BASE_URL)).toBe('zen');
		expect(resolveOpencodePlanForBaseUrl(OPENCODE_ZEN_ANTHROPIC_BASE_URL)).toBe('zen');
	});

	it('returns undefined for non-OpenCode hosts', () => {
		expect(resolveOpencodePlanForBaseUrl('https://api.z.ai/api/paas/v4')).toBeUndefined();
		expect(resolveOpencodePlanForBaseUrl('not a url')).toBeUndefined();
	});

	it('does not misclassify a Zen URL containing "/zen/go" as a substring', () => {
		// Regression: a Zen model ID or path segment like `/zen/grok-x` must not
		// match the Go prefix and route the request to the wrong key.
		const zenWithSubstring = `https://${OPENCODE_GO_API_HOST}/zen/v1/models/zen/grok-4.5`;
		expect(
			resolveOpencodePlanForBaseUrl(zenWithSubstring),
		).toBe('zen');
	});
});

describe('endpoint preset resolver', () => {
	it('resolves every preset to its official base URL', () => {
		expect(resolveEndpointBaseUrl('opencode-go')).toBe(OPENCODE_GO_OPENAI_BASE_URL);
		expect(resolveEndpointBaseUrl('opencode-go-anthropic')).toBe(OPENCODE_GO_ANTHROPIC_BASE_URL);
		expect(resolveEndpointBaseUrl('opencode-go-responses')).toBe(OPENCODE_GO_OPENAI_BASE_URL);
		expect(resolveEndpointBaseUrl('opencode-zen')).toBe(OPENCODE_ZEN_OPENAI_BASE_URL);
		expect(resolveEndpointBaseUrl('opencode-zen-anthropic')).toBe(OPENCODE_ZEN_ANTHROPIC_BASE_URL);
	});

	it('resolves every preset to its API key management page', () => {
		expect(resolveEndpointApiKeyUrl('opencode-go')).toBe(OPENCODE_GO_API_KEY_URL);
		expect(resolveEndpointApiKeyUrl('opencode-go-anthropic')).toBe(OPENCODE_GO_API_KEY_URL);
		expect(resolveEndpointApiKeyUrl('opencode-zen')).toBe(OPENCODE_ZEN_API_KEY_URL);
		expect(resolveEndpointApiKeyUrl('opencode-zen-anthropic')).toBe(OPENCODE_ZEN_API_KEY_URL);
	});

	it('maps each preset to its implied wire protocol', () => {
		expect(resolveEndpointProtocol('opencode-go')).toBe('openai');
		expect(resolveEndpointProtocol('opencode-go-anthropic')).toBe('anthropic');
		expect(resolveEndpointProtocol('opencode-go-responses')).toBe('responses');
		expect(resolveEndpointProtocol('opencode-zen')).toBe('openai');
		expect(resolveEndpointProtocol('opencode-zen-anthropic')).toBe('anthropic');
	});
});
