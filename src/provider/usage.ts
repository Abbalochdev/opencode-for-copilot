/** OpenCode usage is tracked in the web console — no monitor API in this extension. */
export function supportsOpenCodeUsageConsole(baseUrl: string): boolean {
	return baseUrl.includes('opencode.ai');
}
