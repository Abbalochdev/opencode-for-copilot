// Conservative tools cap used by Copilot Chat and OpenAI-compatible GLM requests.
export const GLM_TOOLS_LIMIT = 128;

// Request kinds eligible for tier-1/2 soft tool trimming. Utility kinds
// (todo-tracker, chat-title, etc.) already carry ≤1 tool by construction
// and must stay untouched.
export const REQUEST_KINDS_ELIGIBLE_FOR_TOOL_TRIMMING = new Set<string>([
	'main-agent',
	'background',
]);

export const ACTIVATE_TOOL_PREFIX = 'activate_';
export const PREFLIGHT_ACTIVATE_CALL_ID_PREFIX = 'glm_preflight_activate_';
export const MAX_PREFLIGHT_ROUNDS_PER_USER_REQUEST = 3;

export const TOOL_DRIFT_NOTICE_START = '[glm-copilot-tool-drift-notice-start]: #';
export const TOOL_DRIFT_NOTICE_END = '[glm-copilot-tool-drift-notice-end]: #';
export const VISION_PROXY_NOTICE_START = '[glm-copilot-vision-proxy-notice-start]: #';
export const VISION_PROXY_NOTICE_END = '[glm-copilot-vision-proxy-notice-end]: #';
