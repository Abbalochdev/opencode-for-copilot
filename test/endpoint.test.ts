import { describe, expect, it } from 'vitest';
import {
	isManagedEndpointBaseUrl,
	isOpencodeBaseUrl,
	normalizeBaseUrl,
	normalizeLegacyEndpointPreset,
	OPENCODE_GO_ANTHROPIC_BASE_URL,
	OPENCODE_GO_API_HOST,
	OPENCODE_GO_API_KEY_URL,
	OPENCODE_GO_OPENAI_BASE_URL,
	OPENCODE_ZEN_ANTHROPIC_BASE_URL,
	OPENCODE_ZEN_API_KEY_URL,
	OPENCODE_ZEN_OPENAI_BASE_URL,
	resolveEndpointApiKeyUrl,
	resolveEndpointBaseUrl,
	resolveEndpointProtocol,
	resolveOpencodePlanForBaseUrl,
	resolvePlanDefaultEndpoint,
} from '../src/endpoint';

describe('endpoint helpers', () => {
	it('normalizes trailing slashes and surrounding whitespace', () => {
		expect(normalizeBaseUrl(' https://opencode.ai/zen/go/v1/// ')).toBe(
			'https://opencode.ai/zen/go/v1',
		);
	});

	it('identifies OpenCode URLs', () => {
		expect(isOpencodeBaseUrl(OPENCODE_GO_OPENAI_BASE_URL)).toBe(true);
		expect(isOpencodeBaseUrl(OPENCODE_GO_ANTHROPIC_BASE_URL)).toBe(true);
		expect(isOpencodeBaseUrl(OPENCODE_ZEN_OPENAI_BASE_URL)).toBe(true);
		expect(isOpencodeBaseUrl(OPENCODE_ZEN_ANTHROPIC_BASE_URL)).toBe(true);
		expect(isOpencodeBaseUrl(`https://${OPENCODE_GO_API_HOST}/zen/go/v1/chat/completions`)).toBe(
			true,
		);
		expect(isOpencodeBaseUrl('https://proxy.example.com/v1')).toBe(false);
		expect(isOpencodeBaseUrl('not a url')).toBe(false);
	});

	it('treats managed endpoints as OpenCode hosts only', () => {
		expect(isManagedEndpointBaseUrl(OPENCODE_GO_OPENAI_BASE_URL)).toBe(true);
		expect(isManagedEndpointBaseUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(false);
	});

	it('resolves OpenCode plan from base URL path', () => {
		expect(resolveOpencodePlanForBaseUrl(OPENCODE_GO_OPENAI_BASE_URL)).toBe('go');
		expect(resolveOpencodePlanForBaseUrl(OPENCODE_ZEN_OPENAI_BASE_URL)).toBe('zen');
		expect(resolveOpencodePlanForBaseUrl('https://proxy.example.com/v1')).toBeUndefined();
	});

	it('maps plan to default endpoint preset', () => {
		expect(resolvePlanDefaultEndpoint('go')).toBe('opencode-go');
		expect(resolvePlanDefaultEndpoint('zen')).toBe('opencode-zen');
	});
});

describe('endpoint preset resolver', () => {
	it('resolves every OpenCode preset to its base URL', () => {
		expect(resolveEndpointBaseUrl('opencode-go')).toBe(OPENCODE_GO_OPENAI_BASE_URL);
		expect(resolveEndpointBaseUrl('opencode-go-anthropic')).toBe(OPENCODE_GO_ANTHROPIC_BASE_URL);
		expect(resolveEndpointBaseUrl('opencode-zen')).toBe(OPENCODE_ZEN_OPENAI_BASE_URL);
		expect(resolveEndpointBaseUrl('opencode-zen-anthropic')).toBe(OPENCODE_ZEN_ANTHROPIC_BASE_URL);
	});

	it('resolves every preset to the OpenCode API key page', () => {
		expect(resolveEndpointApiKeyUrl('opencode-go')).toBe(OPENCODE_GO_API_KEY_URL);
		expect(resolveEndpointApiKeyUrl('opencode-go-anthropic')).toBe(OPENCODE_GO_API_KEY_URL);
		expect(resolveEndpointApiKeyUrl('opencode-zen')).toBe(OPENCODE_ZEN_API_KEY_URL);
		expect(resolveEndpointApiKeyUrl('opencode-zen-anthropic')).toBe(OPENCODE_ZEN_API_KEY_URL);
	});

	it('maps each preset to its implied wire protocol', () => {
		expect(resolveEndpointProtocol('opencode-go')).toBe('openai');
		expect(resolveEndpointProtocol('opencode-go-anthropic')).toBe('anthropic');
		expect(resolveEndpointProtocol('opencode-zen')).toBe('openai');
		expect(resolveEndpointProtocol('opencode-zen-anthropic')).toBe('anthropic');
	});
});

describe('legacy endpoint preset migration', () => {
	it('maps legacy GLM preset strings onto OpenCode presets', () => {
		expect(normalizeLegacyEndpointPreset('china-coding')).toBe('opencode-go');
		expect(normalizeLegacyEndpointPreset('china-standard')).toBe('opencode-go');
		expect(normalizeLegacyEndpointPreset('china-anthropic')).toBe('opencode-go-anthropic');
		expect(normalizeLegacyEndpointPreset('international-coding')).toBe('opencode-zen');
		expect(normalizeLegacyEndpointPreset('international-standard')).toBe('opencode-zen');
		expect(normalizeLegacyEndpointPreset('international-anthropic')).toBe('opencode-zen-anthropic');
	});

	it('passes through current OpenCode preset strings', () => {
		expect(normalizeLegacyEndpointPreset('opencode-go')).toBe('opencode-go');
		expect(normalizeLegacyEndpointPreset('opencode-zen-anthropic')).toBe('opencode-zen-anthropic');
	});
});
