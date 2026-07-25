/**
 * Dynamic model fetching from the OpenCode Go and Zen APIs.
 *
 * The APIs return only model IDs (no metadata). This module maintains a local
 * metadata overlay that maps each known model ID to its display name, context
 * windows, capabilities, wire protocol, and pricing. Unknown models that
 * appear in the API response get auto-generated defaults so they show up in
 * the picker immediately — even before a new extension release.
 *
 * Architecture:
 *   1. Fetch model IDs from `opencode.ai/zen/go/v1/models` (Go) and
 *      `opencode.ai/zen/v1/models` (Zen).
 *   2. For each ID, look up the overlay for full metadata.
 *   3. Unknown IDs → auto-generate a ModelDefinition with sensible defaults.
 *   4. Merge with user-supplied customModels from settings.
 *   5. Cache with a TTL; fall back to the static MODELS array on error.
 */

import {
    OPENCODE_GO_OPENAI_BASE_URL,
    OPENCODE_ZEN_OPENAI_BASE_URL,
} from '../endpoint';
import { logger } from '../logger';
import type { EndpointPreset, ModelDefinition, ModelPricing, PriceCategory, PricingCurrency } from '../types';
import { GLM_TOOLS_LIMIT } from './tools/consts';

// ---- API endpoints ----

const OPENCODE_GO_MODELS_URL = `${OPENCODE_GO_OPENAI_BASE_URL}/models`;
const OPENCODE_ZEN_MODELS_URL = `${OPENCODE_ZEN_OPENAI_BASE_URL}/models`;

// ---- Cache ----

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedModels: ModelDefinition[] | undefined;
let cacheTimestamp = 0;

// ---- Metadata overlay ----
//
// Every property that `ModelDefinition` requires except `id` (which is the key).
// Organized by provider family for readability. Pricing is USD per 1M tokens,
// sourced from the OpenCode Zen and Go docs.

interface ModelMeta {
	name: string;
	family: string;
	version: string;
	detail: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	capabilities: {
		toolCalling: boolean | number;
		/** Soft tool-count cap; tools are stably trimmed to this before the hard cap. */
		preferredToolLimit?: number;
		imageInput: boolean;
		thinking: boolean;
	};
	requiresThinkingParam: boolean;
	supportsReasoningEffort?: boolean;
	endpointPreset?: EndpointPreset;
	pricing?: Readonly<Partial<Record<PricingCurrency, ModelPricing>>>;
	priceCategory?: PriceCategory;
}

const METADATA_OVERLAY: ReadonlyMap<string, ModelMeta> = new Map([
	// ========================================================================
	// OpenCode Go subscription models
	// (https://opencode.ai/docs/go)
	//
	// OpenAI-compatible wire protocol: GLM, Kimi, DeepSeek, MiMo, Grok
	// Anthropic wire protocol: MiniMax, Qwen
	// ========================================================================

	// -- GLM family (OpenAI protocol) --

	[
		'glm-5.2',
		{
			name: 'GLM-5.2',
			family: 'glm',
			version: '5.2',
			detail: 'Flagship coding and reasoning model',
			maxInputTokens: 1_000_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			// GLM-5.2 works on both Zhipu and OpenCode endpoints
			pricing: {
				USD: { cacheHitInput: 0.26, cacheMissInput: 1.4, output: 4.4 },
				CNY: { cacheHitInput: 2, cacheMissInput: 8, output: 28 },
			},
			priceCategory: 'high',
		},
	],
	[
		'glm-5.1',
		{
			name: 'GLM-5.1',
			family: 'glm',
			version: '5.1',
			detail: 'Flagship coding and reasoning model',
			maxInputTokens: 1_000_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.26, cacheMissInput: 1.4, output: 4.4 } },
			priceCategory: 'high',
		},
	],
	[
		'glm-5',
		{
			name: 'GLM-5',
			family: 'glm',
			version: '5',
			detail: 'Coding and reasoning model',
			maxInputTokens: 1_000_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.2, cacheMissInput: 1.0, output: 3.2 } },
			priceCategory: 'medium',
		},
	],

	// -- Grok family (OpenAI protocol) --

	[
		'grok-4.5',
		{
			name: 'Grok 4.5',
			family: 'grok',
			version: '4.5',
			detail: 'Frontier reasoning model from xAI',
			maxInputTokens: 256_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.5, cacheMissInput: 2.0, output: 6.0 } },
			priceCategory: 'high',
		},
	],

	// -- Kimi family (OpenAI protocol) --

	[
		'kimi-k3',
		{
			name: 'Kimi K3',
			family: 'kimi',
			version: 'k3',
			detail: 'Frontier reasoning model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.3, cacheMissInput: 3.0, output: 15.0 } },
			priceCategory: 'very_high',
		},
	],
	[
		'kimi-k2.7-code',
		{
			name: 'Kimi K2.7 Code',
			family: 'kimi',
			version: 'k2.7',
			detail: 'Coding-tuned reasoning model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.19, cacheMissInput: 0.95, output: 4.0 } },
			priceCategory: 'medium',
		},
	],
	[
		'kimi-k2.6',
		{
			name: 'Kimi K2.6',
			family: 'kimi',
			version: 'k2.6',
			detail: 'Reasoning model for general coding',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.16, cacheMissInput: 0.95, output: 4.0 } },
			priceCategory: 'medium',
		},
	],
	[
		'kimi-k2.5',
		{
			name: 'Kimi K2.5',
			family: 'kimi',
			version: 'k2.5',
			detail: 'Coding model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.1, cacheMissInput: 0.6, output: 3.0 } },
			priceCategory: 'low',
		},
	],

	// -- DeepSeek family (OpenAI protocol) --

	[
		'deepseek-v4-pro',
		{
			name: 'DeepSeek V4 Pro',
			family: 'deepseek',
			version: 'v4-pro',
			detail: 'High-quality reasoning model',
			maxInputTokens: 128_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.0145, cacheMissInput: 1.74, output: 3.48 } },
			priceCategory: 'medium',
		},
	],
	[
		'deepseek-v4-flash',
		{
			name: 'DeepSeek V4 Flash',
			family: 'deepseek',
			version: 'v4-flash',
			detail: 'Fast and economical coding model',
			maxInputTokens: 128_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 } },
			priceCategory: 'low',
		},
	],

	// -- MiMo family (OpenAI protocol) --

	[
		'mimo-v2.5',
		{
			name: 'MiMo V2.5',
			family: 'mimo',
			version: 'v2.5',
			detail: 'Fast and economical coding model',
			maxInputTokens: 128_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 } },
			priceCategory: 'low',
		},
	],
	[
		'mimo-v2.5-pro',
		{
			name: 'MiMo V2.5 Pro',
			family: 'mimo',
			version: 'v2.5-pro',
			detail: 'High-quality reasoning model',
			maxInputTokens: 128_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.0145, cacheMissInput: 1.74, output: 3.48 } },
			priceCategory: 'medium',
		},
	],

	// -- MiniMax family (Anthropic protocol on Go) --

	[
		'minimax-m3',
		{
			name: 'MiniMax M3',
			family: 'minimax',
			version: 'm3',
			detail: 'Coding model (Anthropic protocol)',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go-anthropic',
			pricing: { USD: { cacheHitInput: 0.06, cacheMissInput: 0.3, output: 1.2 } },
			priceCategory: 'low',
		},
	],
	[
		'minimax-m2.7',
		{
			name: 'MiniMax M2.7',
			family: 'minimax',
			version: 'm2.7',
			detail: 'Coding model (Anthropic protocol)',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go-anthropic',
			pricing: { USD: { cacheHitInput: 0.06, cacheMissInput: 0.3, output: 1.2 } },
			priceCategory: 'low',
		},
	],
	[
		'minimax-m2.5',
		{
			name: 'MiniMax M2.5',
			family: 'minimax',
			version: 'm2.5',
			detail: 'Coding model (Anthropic protocol)',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go-anthropic',
			pricing: { USD: { cacheHitInput: 0.06, cacheMissInput: 0.3, output: 1.2 } },
			priceCategory: 'low',
		},
	],

	// -- Qwen family (Anthropic protocol on Go) --

	[
		'qwen3.7-max',
		{
			name: 'Qwen3.7 Max',
			family: 'qwen',
			version: '3.7-max',
			detail: 'Top-tier reasoning model (Anthropic protocol)',
			maxInputTokens: 256_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go-anthropic',
			pricing: { USD: { cacheHitInput: 0.5, cacheMissInput: 2.5, output: 7.5 } },
			priceCategory: 'high',
		},
	],
	[
		'qwen3.7-plus',
		{
			name: 'Qwen3.7 Plus',
			family: 'qwen',
			version: '3.7-plus',
			detail: 'Cost-effective reasoning model (Anthropic protocol)',
			maxInputTokens: 1_000_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go-anthropic',
			pricing: {
				USD: {
					cacheHitInput: 0.04,
					cacheMissInput: 0.4,
					output: 1.6,
					tiers: [
						{ label: 'prompt <= 256K', maxPromptTokens: 256_000, cacheHitInput: 0.04, cacheMissInput: 0.4, output: 1.6 },
						{ label: 'prompt > 256K', minPromptTokens: 256_000, cacheHitInput: 0.12, cacheMissInput: 1.2, output: 4.8 },
					],
				},
			},
			priceCategory: 'medium',
		},
	],
	[
		'qwen3.6-plus',
		{
			name: 'Qwen3.6 Plus',
			family: 'qwen',
			version: '3.6-plus',
			detail: 'Cost-effective reasoning model (Anthropic protocol)',
			maxInputTokens: 256_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go-anthropic',
			pricing: {
				USD: {
					cacheHitInput: 0.05,
					cacheMissInput: 0.5,
					output: 3.0,
					tiers: [
						{ label: 'prompt <= 256K', maxPromptTokens: 256_000, cacheHitInput: 0.05, cacheMissInput: 0.5, output: 3.0 },
						{ label: 'prompt > 256K', minPromptTokens: 256_000, cacheHitInput: 0.2, cacheMissInput: 2.0, output: 6.0 },
					],
				},
			},
			priceCategory: 'medium',
		},
	],

	// ========================================================================
	// OpenCode Zen models (https://opencode.ai/docs/zen)
	//
	// Pay-as-you-go gateway. Same wire protocol split:
	//   - OpenAI-compatible: GLM, Kimi, DeepSeek, Grok, MiMo, free models
	//   - Anthropic-compatible: Claude, Qwen
	// ========================================================================

	// -- Free models (OpenAI protocol) --

	[
		'big-pickle',
		{
			name: 'Big Pickle',
			family: 'pickle',
			version: '1',
			detail: 'Free stealth coding model',
			maxInputTokens: 128_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, preferredToolLimit: 32, imageInput: false, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-zen',
			priceCategory: 'low',
		},
	],
	[
		'deepseek-v4-flash-free',
		{
			name: 'DeepSeek V4 Flash Free',
			family: 'deepseek',
			version: 'v4-flash-free',
			detail: 'Free fast coding model (limited time)',
			maxInputTokens: 128_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, preferredToolLimit: 32, imageInput: false, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-zen',
			priceCategory: 'low',
		},
	],
	[
		'mimo-v2.5-free',
		{
			name: 'MiMo V2.5 Free',
			family: 'mimo',
			version: 'v2.5-free',
			detail: 'Free fast coding model (limited time)',
			maxInputTokens: 128_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, preferredToolLimit: 32, imageInput: false, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-zen',
			priceCategory: 'low',
		},
	],
	[
		'north-mini-code-free',
		{
			name: 'North Mini Code Free',
			family: 'north',
			version: 'mini-code-free',
			detail: 'Free coding model (limited time)',
			maxInputTokens: 128_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, preferredToolLimit: 32, imageInput: false, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-zen',
			priceCategory: 'low',
		},
	],
	[
		'nemotron-3-ultra-free',
		{
			name: 'Nemotron 3 Ultra Free',
			family: 'nemotron',
			version: '3-ultra-free',
			detail: 'Free coding model (NVIDIA trial — limited time)',
			maxInputTokens: 128_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, preferredToolLimit: 32, imageInput: false, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-zen',
			priceCategory: 'low',
		},
	],
	[
		'laguna-s-2.1-free',
		{
			name: 'Laguna S 2.1 Free',
			family: 'laguna',
			version: 's-2.1-free',
			detail: 'Free coding model (limited time)',
			maxInputTokens: 128_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, preferredToolLimit: 32, imageInput: false, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-zen',
			priceCategory: 'low',
		},
	],
	[
		'ling-3.0-flash-free',
		{
			name: 'Ling 3.0 Flash Free',
			family: 'ling',
			version: '3.0-flash-free',
			detail: 'Free coding model (limited time)',
			maxInputTokens: 128_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, preferredToolLimit: 32, imageInput: false, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-zen',
			priceCategory: 'low',
		},
	],

	// -- Paid models (OpenAI protocol on Zen) --

	[
		'grok-build-0.1',
		{
			name: 'Grok Build 0.1',
			family: 'grok',
			version: 'build-0.1',
			detail: 'xAI coding-tuned reasoning model',
			maxInputTokens: 256_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-zen',
			pricing: { USD: { cacheHitInput: 0.2, cacheMissInput: 1.0, output: 2.0 } },
			priceCategory: 'medium',
		},
	],

	// -- Paid models (Anthropic protocol on Zen) --

	[
		'claude-fable-5',
		{
			name: 'Claude Fable 5',
			family: 'claude',
			version: 'fable-5',
			detail: 'Anthropic frontier reasoning model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			endpointPreset: 'opencode-zen-anthropic',
			pricing: { USD: { cacheHitInput: 1.0, cacheMissInput: 10.0, output: 50.0 } },
			priceCategory: 'very_high',
		},
	],
	[
		'claude-opus-5',
		{
			name: 'Claude Opus 5',
			family: 'claude',
			version: 'opus-5',
			detail: 'Anthropic high-quality reasoning model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			endpointPreset: 'opencode-zen-anthropic',
			pricing: { USD: { cacheHitInput: 0.5, cacheMissInput: 5.0, output: 25.0 } },
			priceCategory: 'very_high',
		},
	],
	[
		'claude-opus-4-8',
		{
			name: 'Claude Opus 4.8',
			family: 'claude',
			version: 'opus-4.8',
			detail: 'Anthropic high-quality reasoning model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			endpointPreset: 'opencode-zen-anthropic',
			pricing: { USD: { cacheHitInput: 0.5, cacheMissInput: 5.0, output: 25.0 } },
			priceCategory: 'very_high',
		},
	],
	[
		'claude-opus-4-7',
		{
			name: 'Claude Opus 4.7',
			family: 'claude',
			version: 'opus-4.7',
			detail: 'Anthropic high-quality reasoning model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			endpointPreset: 'opencode-zen-anthropic',
			pricing: { USD: { cacheHitInput: 0.5, cacheMissInput: 5.0, output: 25.0 } },
			priceCategory: 'very_high',
		},
	],
	[
		'claude-opus-4-6',
		{
			name: 'Claude Opus 4.6',
			family: 'claude',
			version: 'opus-4.6',
			detail: 'Anthropic high-quality reasoning model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			endpointPreset: 'opencode-zen-anthropic',
			pricing: { USD: { cacheHitInput: 0.5, cacheMissInput: 5.0, output: 25.0 } },
			priceCategory: 'very_high',
		},
	],
	[
		'claude-opus-4-5',
		{
			name: 'Claude Opus 4.5',
			family: 'claude',
			version: 'opus-4.5',
			detail: 'Anthropic high-quality reasoning model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			endpointPreset: 'opencode-zen-anthropic',
			pricing: { USD: { cacheHitInput: 0.5, cacheMissInput: 5.0, output: 25.0 } },
			priceCategory: 'very_high',
		},
	],
	[
		'claude-sonnet-5',
		{
			name: 'Claude Sonnet 5',
			family: 'claude',
			version: 'sonnet-5',
			detail: 'Anthropic balanced reasoning model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			endpointPreset: 'opencode-zen-anthropic',
			pricing: { USD: { cacheHitInput: 0.2, cacheMissInput: 2.0, output: 10.0 } },
			priceCategory: 'high',
		},
	],
	[
		'claude-sonnet-4-6',
		{
			name: 'Claude Sonnet 4.6',
			family: 'claude',
			version: 'sonnet-4.6',
			detail: 'Anthropic balanced reasoning model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			endpointPreset: 'opencode-zen-anthropic',
			pricing: { USD: { cacheHitInput: 0.3, cacheMissInput: 3.0, output: 15.0 } },
			priceCategory: 'high',
		},
	],
	[
		'claude-sonnet-4-5',
		{
			name: 'Claude Sonnet 4.5',
			family: 'claude',
			version: 'sonnet-4.5',
			detail: 'Anthropic balanced reasoning model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: true },
			requiresThinkingParam: true,
			supportsReasoningEffort: true,
			endpointPreset: 'opencode-zen-anthropic',
			pricing: { USD: { cacheHitInput: 0.3, cacheMissInput: 3.0, output: 15.0 } },
			priceCategory: 'high',
		},
	],
	[
		'claude-haiku-4-5',
		{
			name: 'Claude Haiku 4.5',
			family: 'claude',
			version: 'haiku-4.5',
			detail: 'Anthropic fast economical model',
			maxInputTokens: 200_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-zen-anthropic',
			pricing: { USD: { cacheHitInput: 0.1, cacheMissInput: 1.0, output: 5.0 } },
			priceCategory: 'medium',
		},
	],
	[
		'qwen3.5-plus',
		{
			name: 'Qwen3.5 Plus',
			family: 'qwen',
			version: '3.5-plus',
			detail: 'Cost-effective reasoning model (Anthropic protocol)',
			maxInputTokens: 256_000,
			maxOutputTokens: 131_072,
			capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: true, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-zen-anthropic',
			pricing: { USD: { cacheHitInput: 0.02, cacheMissInput: 0.2, output: 1.2 } },
			priceCategory: 'low',
		},
	],

	// ========================================================================
	// Copilot Chat utility models
	// (aliases — resolved via modelIdOverrides at request time)
	// ========================================================================

	[
		'copilot-utility',
		{
			name: 'OpenCode Utility',
			family: 'glm',
			version: '1',
			detail: 'Utility model for quick chat tasks',
			maxInputTokens: 128_000,
			maxOutputTokens: 4096,
			capabilities: { toolCalling: false, imageInput: false, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 } },
			priceCategory: 'low',
		},
	],
	[
		'copilot-utility-small',
		{
			name: 'OpenCode Utility Small',
			family: 'glm',
			version: '1',
			detail: 'Small utility model for quick chat tasks',
			maxInputTokens: 128_000,
			maxOutputTokens: 2048,
			capabilities: { toolCalling: false, imageInput: false, thinking: false },
			requiresThinkingParam: false,
			endpointPreset: 'opencode-go',
			pricing: { USD: { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 } },
			priceCategory: 'low',
		},
	],
]);

// ---- API response types ----

interface OpenCodeModelEntry {
	id: string;
	object: string;
	created: number;
	owned_by: string;
}

interface OpenCodeModelListResponse {
	object: string;
	data: OpenCodeModelEntry[];
}

// ---- Fetching ----

/**
 * Fetch model IDs from one OpenCode API endpoint.
 * Returns an empty set on error so the caller can fall back gracefully.
 */
async function fetchModelIdsFromEndpoint(url: string): Promise<ReadonlySet<string>> {
	try {
		const response = await fetch(url, {
			headers: { Accept: 'application/json' },
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			logger.warn(`OpenCode model list fetch failed (${response.status}): ${url}`);
			return new Set();
		}
		const body = (await response.json()) as OpenCodeModelListResponse;
		if (!Array.isArray(body.data)) {
			return new Set();
		}
		return new Set(body.data.map((m) => m.id));
	} catch (error) {
		logger.warn(`OpenCode model list fetch error: ${url}`, error);
		return new Set();
	}
}

/**
 * Fetch model IDs from both the Go and Zen API endpoints.
 * Returns a combined set of all available model IDs.
 */
export async function fetchAllOpenCodeModelIds(): Promise<ReadonlySet<string>> {
	const [goIds, zenIds] = await Promise.all([
		fetchModelIdsFromEndpoint(OPENCODE_GO_MODELS_URL),
		fetchModelIdsFromEndpoint(OPENCODE_ZEN_MODELS_URL),
	]);
	const allIds = new Set([...goIds, ...zenIds]);
	logger.info(`Fetched ${allIds.size} models from OpenCode API (Go: ${goIds.size}, Zen: ${zenIds.size})`);
	return allIds;
}

// ---- Auto-generation for unknown models ----

/** Derive a human-readable display name from a raw model ID. */
function displayNameFromId(id: string): string {
	return id
		.split('-')
		.map((part) => {
			// Uppercase pure数字 segments (e.g. "5" → "5", "4" → "4")
			if (/^\d+$/.test(part)) {
				return part;
			}
			// Title-case words but keep known acronyms uppercase
			const acronyms = new Set(['ai', 'glm', 'gpt', 'qwen', 'claude', 'mimo']);
			if (acronyms.has(part.toLowerCase())) {
				return part.toUpperCase();
			}
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(' ');
}

/** Derive a family name from a raw model ID. */
function familyFromId(id: string): string {
	const firstSegment = id.split('-')[0];
	return firstSegment.toLowerCase();
}

/** Build a ModelDefinition for an unknown model not in the overlay. */
function generateDefaultModel(id: string): ModelDefinition {
	return {
		id,
		name: displayNameFromId(id),
		family: familyFromId(id),
		version: id,
		detail: 'OpenCode model (auto-detected)',
		maxInputTokens: 128_000,
		maxOutputTokens: 32_768,
		capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: false, thinking: false },
		requiresThinkingParam: false,
		endpointPreset: 'opencode-zen',
	};
}

// ---- Model list construction ----

/** Utility model IDs that should always be included regardless of API response. */
const UTILITY_MODEL_IDS = new Set(['copilot-utility', 'copilot-utility-small']);

/**
 * Build the dynamic model list from fetched IDs + metadata overlay.
 *
 * For each fetched ID:
 *   - If in overlay → use overlay metadata
 *   - If not in overlay → auto-generate with sensible defaults
 *
 * Utility models and user-supplied custom models are always merged in.
 */
export function buildDynamicModels(
	fetchedIds: ReadonlySet<string>,
	customModels: readonly ModelDefinition[],
): ModelDefinition[] {
	const byId = new Map<string, ModelDefinition>();

	// 1. Models from the API response
	for (const id of fetchedIds) {
		const meta = METADATA_OVERLAY.get(id);
		if (meta) {
			byId.set(id, { id, ...meta });
		} else {
			byId.set(id, generateDefaultModel(id));
		}
	}

	// 2. Always include utility models (may not appear in API)
	for (const id of UTILITY_MODEL_IDS) {
		if (!byId.has(id)) {
			const meta = METADATA_OVERLAY.get(id);
			if (meta) {
				byId.set(id, { id, ...meta });
			}
		}
	}

	// 3. Merge user-supplied custom models (highest priority)
	for (const model of customModels) {
		byId.set(model.id, model);
	}

	return [...byId.values()];
}

/**
 * Get the dynamic model list with caching.
 *
 * On the first call (or after cache expiry), fetches from the OpenCode API.
 * On network failure, falls back to the static MODELS array from consts.ts
 * so the extension remains functional offline.
 */
export async function getDynamicModels(
	customModels: readonly ModelDefinition[],
	fallbackModels: readonly ModelDefinition[],
): Promise<readonly ModelDefinition[]> {
	const now = Date.now();
	if (cachedModels && now - cacheTimestamp < CACHE_TTL_MS) {
		return cachedModels;
	}

	const fetchedIds = await fetchAllOpenCodeModelIds();

	// If the API returned zero models (likely a network issue), use fallback
	if (fetchedIds.size === 0) {
		logger.warn('OpenCode API returned no models — falling back to static model list');
		const byId = new Map(fallbackModels.map((m) => [m.id, m]));
		for (const model of customModels) {
			byId.set(model.id, model);
		}
		cachedModels = [...byId.values()];
		cacheTimestamp = now;
		return cachedModels;
	}

	cachedModels = buildDynamicModels(fetchedIds, customModels);
	cacheTimestamp = now;
	return cachedModels;
}

/**
 * Invalidate the cache so the next call to `getDynamicModels` re-fetches.
 */
export function invalidateModelCache(): void {
	cachedModels = undefined;
	cacheTimestamp = 0;
}

/**
 * Synchronous accessor for the overlay — useful for tests and cases where
 * async fetching isn't practical (e.g. module-level initialization).
 * Returns all models from the overlay regardless of API availability.
 */
export function getOverlayModels(): readonly ModelDefinition[] {
	return [...METADATA_OVERLAY.entries()].map(([id, meta]) => ({ id, ...meta }));
}

/**
 * Check whether a model ID is known in the overlay.
 */
export function isKnownModel(id: string): boolean {
	return METADATA_OVERLAY.has(id);
}
