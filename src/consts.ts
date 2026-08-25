import { getOverlayModels } from './provider/opencode-models';
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
// Single source of truth: the metadata overlay in `provider/opencode-models.ts`.
// `getOverlayModels()` returns the full static catalogue that acts as both the
// initial fallback (before the async API fetch completes) and the metadata
// source for all known models.

/** Available models exposed through the language model provider. */
export const MODELS: ModelDefinition[] = [...getOverlayModels()];
