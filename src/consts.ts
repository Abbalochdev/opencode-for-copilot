import { DEFAULT_GLM_BASE_URL } from './endpoint';
import { GLM_TOOLS_LIMIT } from './provider/tools/consts';
import type { ModelDefinition } from './types';

/**
 * Compile-time constants shared across the extension.
 *
 * These do NOT depend on the VS Code runtime (no workspace configuration,
 * no secrets API). For run-time settings reads see `config.ts`.
 */

/** VS Code configuration section prefix for all extension settings. */
export const CONFIG_SECTION = 'glm-copilot';

export const EXTERNAL_URLS = {
	glm: {
		apiKeys: 'https://www.bigmodel.cn/usercenter/proj-mgmt/apikeys',
		usage: 'https://www.bigmodel.cn/usercenter/resourcepack',
		status: 'https://docs.bigmodel.cn/cn/api/status-code/status-code-v4',
		// 1113 账户欠费、402 余额不足 等场景的充值入口。
		topUp: 'https://www.bigmodel.cn/usercenter/proj-mgmt/resourcepack',
		// 1309 GLM Coding Plan 套餐到期、1311 套餐未包含模型 等场景的续订入口。
		codingPlan: 'https://bigmodel.cn/claude-code',
		// 1313 公平使用策略被限制时的解除入口（个人中心-编程套餐总览）。
		fairUsePolicy: 'https://www.bigmodel.cn/usercenter/valuepack',
	},
} as const;

export { DEFAULT_GLM_BASE_URL };

/** URI path handled by this extension to reveal the output log. */
export const SHOW_LOGS_URI_PATH = '/showLogs';

/** URI path handled by this extension to open API key configuration. */
export const CONFIGURE_API_KEY_URI_PATH = '/setApiKey';

/** URI path handled by this extension to open vision model configuration. */
export const SET_VISION_MODEL_URI_PATH = '/setVisionModel';

// VS Code's internal LanguageModelChatMessageRole.System is not exposed in @types/vscode.
export const LANGUAGE_MODEL_CHAT_SYSTEM_ROLE = 3;

// ---- Secret keys ----

/** SecretStorage key for the GLM API key. */
export const API_KEY_SECRET = 'glm-copilot.apiKey';

/** memento key tracking whether the welcome walkthrough has been shown. */
export const WELCOME_SHOWN_KEY = 'glm-copilot.welcomeShown';

// ---- Walkthrough ----

/** Walkthrough contribution ID. */
export const WALKTHROUGH_ID = 'abbalochdev.opencode-for-copilot#glmGettingStarted';

// ---- Model registry ----

/**
 * Available models exposed through the language model provider.
 *
 * The default lineup is the OpenCode Go subscription
 * (https://opencode.ai/docs/go), which serves a curated set of open coding
 * models behind a single API key from `https://opencode.ai/auth`. GLM-5.2 is
 * left unpinned so it keeps working on the official Zhipu/Z.ai endpoints too;
 * every other model is pinned to its required OpenCode Go preset because Go
 * splits the catalogue across two wire protocols:
 *   - OpenAI `/chat/completions`: GLM, Kimi, DeepSeek, MiMo
 *   - Anthropic `/v1/messages`:   MiniMax, Qwen
 *
 * Pricing is USD per 1M tokens, sourced from the OpenCode Go docs. The legacy
 * Zhipu/Z.ai endpoints are still selectable via the `endpoint` setting.
 */
export const MODELS: ModelDefinition[] = [
	{
		id: 'glm-5.2',
		name: 'GLM-5.2',
		family: 'glm',
		version: '5.2',
		detail: 'Flagship coding and reasoning model',
		maxInputTokens: 1_000_000,
		maxOutputTokens: 131_072,
		capabilities: {
			toolCalling: GLM_TOOLS_LIMIT,
			// The extension accepts images for this model through the transparent
			// vision proxy before sending text to GLM-5.2.
			imageInput: true,
			thinking: true,
		},
		requiresThinkingParam: true,
		supportsReasoningEffort: true,
		pricing: {
			CNY: { cacheHitInput: 2, cacheMissInput: 8, output: 28 },
			USD: { cacheHitInput: 0.26, cacheMissInput: 1.4, output: 4.4 },
		},
		priceCategory: 'high',
	},
	{
		id: 'glm-5.1',
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
	{
		id: 'grok-4.5',
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
	{
		id: 'kimi-k3',
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
	{
		id: 'kimi-k2.7-code',
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
	{
		id: 'kimi-k2.6',
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
	{
		id: 'deepseek-v4-pro',
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
	{
		id: 'deepseek-v4-flash',
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
	{
		id: 'mimo-v2.5',
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
	{
		id: 'mimo-v2.5-pro',
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
	{
		id: 'minimax-m3',
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
	{
		id: 'minimax-m2.7',
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
	{
		id: 'minimax-m2.5',
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
	{
		id: 'qwen3.7-max',
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
	{
		id: 'qwen3.7-plus',
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
					{
						label: 'prompt <= 256K',
						maxPromptTokens: 256_000,
						cacheHitInput: 0.04,
						cacheMissInput: 0.4,
						output: 1.6,
					},
					{
						label: 'prompt > 256K',
						minPromptTokens: 256_000,
						cacheHitInput: 0.12,
						cacheMissInput: 1.2,
						output: 4.8,
					},
				],
			},
		},
		priceCategory: 'medium',
	},
	{
		id: 'qwen3.6-plus',
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
					{
						label: 'prompt <= 256K',
						maxPromptTokens: 256_000,
						cacheHitInput: 0.05,
						cacheMissInput: 0.5,
						output: 3.0,
					},
					{
						label: 'prompt > 256K',
						minPromptTokens: 256_000,
						cacheHitInput: 0.2,
						cacheMissInput: 2.0,
						output: 6.0,
					},
				],
			},
		},
		priceCategory: 'medium',
	},

	// ---- OpenCode Zen models (https://opencode.ai/docs/zen) ----
	//
	// OpenCode Zen is a pay-as-you-go AI gateway. Models are split across
	// two wire protocols:
	//   - OpenAI `/chat/completions`: GLM, Kimi, DeepSeek, Grok, MiMo, free models
	//   - Anthropic `/v1/messages`:   Claude, Qwen
	//
	// Free models are available for a limited time and may collect data to
	// improve the model. See https://opencode.ai/docs/zen#pricing for details.

	// -- Free models (OpenAI protocol) --

	{
		id: 'big-pickle',
		name: 'Big Pickle',
		family: 'pickle',
		version: '1',
		detail: 'Free stealth coding model',
		maxInputTokens: 128_000,
		maxOutputTokens: 131_072,
		capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: false, thinking: false },
		requiresThinkingParam: false,
		endpointPreset: 'opencode-zen',
		priceCategory: 'low',
	},
	{
		id: 'deepseek-v4-flash-free',
		name: 'DeepSeek V4 Flash Free',
		family: 'deepseek',
		version: 'v4-flash-free',
		detail: 'Free fast coding model (limited time)',
		maxInputTokens: 128_000,
		maxOutputTokens: 131_072,
		capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: false, thinking: false },
		requiresThinkingParam: false,
		endpointPreset: 'opencode-zen',
		priceCategory: 'low',
	},
	{
		id: 'mimo-v2.5-free',
		name: 'MiMo V2.5 Free',
		family: 'mimo',
		version: 'v2.5-free',
		detail: 'Free fast coding model (limited time)',
		maxInputTokens: 128_000,
		maxOutputTokens: 131_072,
		capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: false, thinking: false },
		requiresThinkingParam: false,
		endpointPreset: 'opencode-zen',
		priceCategory: 'low',
	},
	{
		id: 'north-mini-code-free',
		name: 'North Mini Code Free',
		family: 'north',
		version: 'mini-code-free',
		detail: 'Free coding model (limited time)',
		maxInputTokens: 128_000,
		maxOutputTokens: 131_072,
		capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: false, thinking: false },
		requiresThinkingParam: false,
		endpointPreset: 'opencode-zen',
		priceCategory: 'low',
	},
	{
		id: 'nemotron-3-ultra-free',
		name: 'Nemotron 3 Ultra Free',
		family: 'nemotron',
		version: '3-ultra-free',
		detail: 'Free coding model (NVIDIA trial — limited time)',
		maxInputTokens: 128_000,
		maxOutputTokens: 131_072,
		capabilities: { toolCalling: GLM_TOOLS_LIMIT, imageInput: false, thinking: false },
		requiresThinkingParam: false,
		endpointPreset: 'opencode-zen',
		priceCategory: 'low',
	},

	// -- Paid models (OpenAI protocol) --

	{
		id: 'grok-build-0.1',
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

	// -- Paid models (Anthropic protocol) --

	{
		id: 'claude-fable-5',
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
	{
		id: 'claude-opus-4-8',
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
	{
		id: 'claude-opus-4-7',
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
	{
		id: 'claude-opus-4-6',
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
	{
		id: 'claude-opus-4-5',
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
	{
		id: 'claude-sonnet-5',
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
	{
		id: 'claude-sonnet-4-6',
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
	{
		id: 'claude-sonnet-4-5',
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
	{
		id: 'claude-haiku-4-5',
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
	{
		id: 'qwen3.5-plus',
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

	// ---- Copilot Chat utility models ----
	//
	// VS Code's Copilot Chat expects BYOK providers to expose two utility
	// model IDs for quick/small chat tasks (inline suggestions, simple
	// completions, etc.). These alias the cheapest available model so
	// utility requests don't waste the user's quota on a premium model.
	//
	// If you need different utility models, add overrides in the
	// `glm-copilot.modelIdOverrides` setting, for example:
	//   "glm-copilot.modelIdOverrides": {
	//     "copilot-utility": "mimo-v2.5",
	//     "copilot-utility-small": "mimo-v2.5"
	//   }

	{
		id: 'copilot-utility',
		name: 'OpenCode Utility',
		family: 'glm',
		version: '1',
		detail: 'Utility model for quick chat tasks',
		maxInputTokens: 128_000,
		maxOutputTokens: 4096,
		capabilities: { toolCalling: false, imageInput: false, thinking: false },
		requiresThinkingParam: false,
		endpointPreset: 'opencode-go',
		pricing: {
			USD: { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 },
		},
		priceCategory: 'low',
	},
	{
		id: 'copilot-utility-small',
		name: 'OpenCode Utility Small',
		family: 'glm',
		version: '1',
		detail: 'Small utility model for quick chat tasks',
		maxInputTokens: 128_000,
		maxOutputTokens: 2048,
		capabilities: { toolCalling: false, imageInput: false, thinking: false },
		requiresThinkingParam: false,
		endpointPreset: 'opencode-go',
		pricing: {
			USD: { cacheHitInput: 0.0028, cacheMissInput: 0.14, output: 0.28 },
		},
		priceCategory: 'low',
	},
];
