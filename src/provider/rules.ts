/**
 * User-defined rules — verbatim instructions added to the system message for
 * every coding request. Inspired by Continue's `rules:` block, modelled after
 * the existing Ponytail / Code Simplifier injectors (prepended for a stable
 * prompt-cache prefix; see {@link injectPonytailSystemMessage}).
 *
 * Rules sit ABOVE Ponytail / Code Simplifier in priority ordering (read-only
 * customisations go first, the higher-priority runtime defaults follow), but
 * because Ponytail and Code Simplifier default to higher salience in their own
 * headers, the practical relationship is: rules set policy defaults, Ponytail
 * sets coding-discipline posture, Code Simplifier sets refinement posture. They
 * compose without conflict.
 *
 * Rules are NOT injected into utility requests (chat-title, git-commit-message,
 * etc.) — only real coding chats, the same gate Ponytail / Code Simplifier use.
 * This keeps the stable prompt prefix shared with utility requests intact and
 * avoids changing the shape of every nondescript background call.
 */

import type { GLMMessage } from '../types';

/**
 * Join user rules into one instruction block.
 *
 * Returns `undefined` when there are zero rules so {@link injectRulesSystemMessage}
 * can short-circuit without touching the message array. Empty/whitespace-only
 * entries are dropped; a single trailing newline is trimmed so the block ends
 * cleanly before Ponytail's header is prepended on top of it.
 */
export function formatRulesInstruction(rules: readonly string[]): string | undefined {
	const cleaned = rules.map((r) => r.trim()).filter((r) => r.length > 0);
	if (cleaned.length === 0) {
		return undefined;
	}
	return `### USER RULES\n\n${cleaned.map((r) => `- ${r}`).join('\n')}`;
}

/**
 * Prepend the user-rules instruction to existing system messages.
 *
 * Static rules are placed BEFORE Copilot's dynamic system content and BEFORE
 * Ponytail / Code Simplifier to keep the stable prefix long (better
 * server-side cache hit ratio). When no system message exists yet, one is
 * created with just the rules block.
 *
 * No-op when `rules` is empty or all whitespace — the message array is
 * returned untouched, preserving the original instruction ordering.
 */
export function injectRulesSystemMessage(
	messages: GLMMessage[],
	rules: readonly string[],
): GLMMessage[] {
	const instruction = formatRulesInstruction(rules);
	if (!instruction) {
		return messages;
	}

	const firstSystemIndex = messages.findIndex((message) => message.role === 'system');
	if (firstSystemIndex >= 0) {
		const updated = [...messages];
		updated[firstSystemIndex] = {
			...updated[firstSystemIndex],
			// Prepend BEFORE existing system content for cache-stable ordering.
			content: `${instruction}\n\n${updated[firstSystemIndex].content}`.trim(),
		};
		return updated;
	}

	return [{ role: 'system', content: instruction }, ...messages];
}
