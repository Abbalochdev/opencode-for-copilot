import { logger } from '../logger';

/**
 * Per-platform rate limit tracker.
 *
 * Parses `X-RateLimit-*` headers from successful responses and uses them to
 * pre-emptively delay before sending requests when quota is nearly exhausted.
 * Falls back to `Retry-After` for 429 errors (handled elsewhere).
 */

interface RateLimitState {
	remaining: number;
	limit: number;
	resetMs: number; // epoch ms when the window resets
}

const stateByHost = new Map<string, RateLimitState>();

/**
 * Parse rate-limit headers from a successful Response and update internal state.
 * Works with common patterns: X-RateLimit-Remaining, X-RateLimit-Limit,
 * X-RateLimit-Reset.
 */
export function trackRateLimitHeaders(baseUrl: string, headers: Headers): void {
	const remaining = parseHeaderInt(headers, 'x-ratelimit-remaining');
	const limit = parseHeaderInt(headers, 'x-ratelimit-limit');
	const reset = parseHeaderInt(headers, 'x-ratelimit-reset');

	if (remaining === undefined && reset === undefined) {
		return; // no rate limit headers — nothing to track
	}

	const host = extractHost(baseUrl);
	const now = Date.now();
	const resetMs = reset !== undefined
		? (reset < 1e12 ? reset * 1000 : reset) // seconds vs ms
		: now + 60_000; // conservative 60s fallback

	stateByHost.set(host, {
		remaining: remaining ?? Infinity,
		limit: limit ?? Infinity,
		resetMs,
	});

	if (remaining !== undefined && remaining <= 2) {
		logger.warn(`[rate-limit] ${host}: ${remaining}/${limit ?? '?'} remaining, resets at +${Math.max(0, resetMs - now)}ms`);
	}
}

/**
 * If we're about to exhaust the rate limit, wait until the window resets.
 * Returns immediately when there's headroom or no data.
 */
export async function waitIfRateLimited(baseUrl: string): Promise<void> {
	const host = extractHost(baseUrl);
	const state = stateByHost.get(host);
	if (!state || state.remaining > 0) {
		return;
	}

	const now = Date.now();
	if (now >= state.resetMs) {
		// Window expired — clear stale state.
		stateByHost.delete(host);
		return;
	}

	const delay = state.resetMs - now;
	if (delay > 0 && delay <= 30_000) {
		logger.info(`[rate-limit] ${host}: waiting ${delay}ms for rate limit window reset`);
		await sleep(delay);
		// After waiting, assume the window has refreshed.
		stateByHost.delete(host);
	}
}

function extractHost(baseUrl: string): string {
	try {
		return new URL(baseUrl).host;
	} catch {
		return baseUrl;
	}
}

function parseHeaderInt(headers: Headers, name: string): number | undefined {
	const raw = headers.get(name);
	if (raw === null || raw === '') {
		return undefined;
	}
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
