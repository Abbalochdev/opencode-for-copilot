import { getFallbackModels } from './provider/opencode-models';
import type { ModelDefinition } from './types';

/**
 * Compile-time constants shared across the extension.
 *
 * These do NOT depend on the VS Code runtime (no workspace configuration,
 * no secrets API). For run-time settings reads see `config.ts`.
 */

/** VS Code configuration section prefix for all extension settings. */
export const CONFIG_SECTION = 'opencode-for-copilot';

/**
 * Pre-3.11 settings section, shared with the upstream GLM extension this
 * fork originated from. Only read once during `migrateLegacySettings` —
 * never at runtime — so both extensions can be installed side by side with
 * fully independent settings.
 */
export const LEGACY_CONFIG_SECTION = 'glm-copilot';

export const EXTERNAL_URLS = {
	opencode: {
		apiKeys: 'https://opencode.ai/auth',
		usage: 'https://opencode.ai/auth',
	},
} as const;

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

/** SecretStorage keys for the OpenCode Go / Zen plan API keys. */
export const API_KEY_GO_SECRET = 'glm-copilot.apiKey.go';
export const API_KEY_ZEN_SECRET = 'glm-copilot.apiKey.zen';

/** memento key tracking whether the welcome walkthrough has been shown. */
export const WELCOME_SHOWN_KEY = 'glm-copilot.welcomeShown';

// ---- Walkthrough ----

/** Walkthrough contribution ID. */
export const WALKTHROUGH_ID = 'abbalochdev.opencode-for-copilot#glmGettingStarted';

// ---- Model registry ----
//
// Live source of truth: the OpenCode catalogs fetched at runtime
// (`provider/opencode-models.ts`), merged with user custom models. The static
// list below is only a minimal offline baseline (before the first fetch
// completes, or if both catalog endpoints become unreachable) — it covers
// every billing path and wire protocol with four models.

/** Available models exposed through the language model provider. */
export const MODELS: ModelDefinition[] = [...getFallbackModels()];
