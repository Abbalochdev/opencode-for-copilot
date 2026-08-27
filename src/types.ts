/**
 * Shared types for the OpenCode for Copilot extension.
 */

// ---- API request/response types ----

export interface GLMMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string;
	tool_call_id?: string;
	tool_calls?: GLMToolCall[];
	reasoning_content?: string;
}

export interface GLMToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
}

export interface GLMTool {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: Record<string, unknown>;
	};
}

export interface GLMUsage {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_cache_hit_tokens?: number;
	prompt_cache_miss_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
	};
}

export interface GLMRequest {
	model: string;
	messages: GLMMessage[];
	stream: boolean;
	stream_options?: { include_usage?: boolean };
	temperature?: number;
	top_p?: number;
	max_tokens?: number;
	tools?: GLMTool[];
	tool_choice?: 'none' | 'auto' | 'required';
	thinking?: { type: 'enabled' | 'disabled'; clear_thinking?: boolean };
	reasoning_effort?: 'high' | 'max';
	tool_stream?: boolean;
}

export interface GLMStreamChunk {
	id: string;
	object: string;
	created: number;
	model: string;
	choices: Array<{
		index: number;
		delta: {
			role?: string;
			content?: string;
			reasoning_content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				type?: string;
				function?: {
					name?: string;
					arguments?: string;
				};
			}>;
		};
		finish_reason: string | null;
	}>;
	usage?: GLMUsage;
}

// ---- Stream callbacks ----

export interface StreamCallbacks {
	onContent: (content: string) => void;
	onThinking: (text: string) => void;
	onToolCall: (toolCall: GLMToolCall) => void;
	onError: (error: Error) => void;
	onDone: () => void;
	onUsage?: (usage: GLMUsage) => void;
}

// ---- Configuration types ----

export type ApiProtocol = 'openai' | 'anthropic' | 'responses';

/**
 * OpenCode endpoint preset — each value resolves to one base URL + wire protocol.
 *
 * Go presets: https://opencode.ai/docs/go
 * Zen presets: https://opencode.ai/docs/zen
 */
export type EndpointPreset =
	| 'opencode-go'
	| 'opencode-go-anthropic'
	| 'opencode-go-responses'
	| 'opencode-zen'
	| 'opencode-zen-anthropic';

export type CustomModelConfigEntry = string | CustomModelConfig;

export interface CustomModelConfig {
	id?: string;
	name?: string;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	toolCalling?: boolean;
	thinking?: boolean;
}

// ---- Model definitions ----

export type PricingCurrency = 'USD' | 'CNY';

export type PriceCategory = 'low' | 'medium' | 'high' | 'very_high';

export interface ModelPricing {
	cacheHitInput: number;
	cacheMissInput: number;
	output: number;
	tiers?: readonly ModelPricingTier[];
}

export interface ModelPricingTier {
	label: string;
	minPromptTokens?: number;
	maxPromptTokens?: number;
	cacheHitInput: number;
	cacheMissInput: number;
	output: number;
}

export interface ModelDefinition {
	id: string;
	name: string;
	family: string;
	version: string;
	detail: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	capabilities: {
		toolCalling: boolean | number;
		/** Soft tool-count cap: tools are stably trimmed to this limit before
		 *  the hard `toolCalling` cap is enforced. Only applied for request
		 *  kinds in `REQUEST_KINDS_ELIGIBLE_FOR_TOOL_TRIMMING`. */
		preferredToolLimit?: number;
		imageInput: boolean;
		thinking: boolean;
	};
	requiresThinkingParam: boolean;
	supportsReasoningEffort?: boolean;
	/** models.dev marks retired/unavailable entries; these are hidden from the picker. */
	deprecated?: boolean;
	/**
	 * Optional endpoint preset that pins this model to a specific base URL and
	 * wire protocol, overriding the global `endpoint` setting.
	 *
	 * Used by OpenCode Go models that are only reachable through a specific
	 * protocol (e.g. MiniMax / Qwen are served via the Anthropic protocol while
	 * GLM / Kimi / DeepSeek / MiMo are served via the OpenAI protocol). Leaving
	 * this undefined makes the model follow the active endpoint preset.
	 */
	endpointPreset?: EndpointPreset;
	pricing?: Readonly<Partial<Record<PricingCurrency, ModelPricing>>>;
	priceCategory?: PriceCategory;
}
