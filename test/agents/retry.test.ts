import { describe, expect, it, vi } from 'vitest';
import { isRetriableError, withModelFailover, withRetry } from '../../src/agents/retry';

describe('isRetriableError', () => {
	it('flags HTTP 429 and rate-limit messages', () => {
		expect(isRetriableError(new Error('429 Too Many Requests'))).toBe(true);
		expect(isRetriableError(new Error('Rate limit exceeded'))).toBe(true);
		expect(isRetriableError(new Error('rate-limit hit'))).toBe(true);
		expect(isRetriableError(new Error('Too many requests'))).toBe(true);
	});

	it('flags 5xx server errors', () => {
		expect(isRetriableError(new Error('502 Bad Gateway'))).toBe(true);
		expect(isRetriableError(new Error('503 Service Unavailable'))).toBe(true);
		expect(isRetriableError(new Error('504 Gateway Timeout'))).toBe(true);
	});

	it('flags Node network error codes', () => {
		expect(isRetriableError(new Error('ECONNRESET'))).toBe(true);
		expect(isRetriableError(new Error('ETIMEDOUT'))).toBe(true);
		expect(isRetriableError(new Error('EAI_AGAIN lookup failed'))).toBe(true);
		expect(isRetriableError(new Error('UND_ERR_SOCKET closed'))).toBe(true);
	});

	it('does not flag non-retriable errors', () => {
		expect(isRetriableError(new Error('400 Bad Request'))).toBe(false);
		expect(isRetriableError(new Error('Unauthorized'))).toBe(false);
		expect(isRetriableError(new Error('Not Found'))).toBe(false);
		expect(isRetriableError(new Error('invalid model id'))).toBe(false);
		expect(isRetriableError('just a string')).toBe(false);
	});
});

describe('withRetry', () => {
	it('returns the result on the first successful call', async () => {
		const fn = vi.fn().mockResolvedValue('ok');
		const result = await withRetry(fn);
		expect(result).toBe('ok');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('retries on a retriable error then succeeds', async () => {
		const fn = vi.fn()
			.mockRejectedValueOnce(new Error('429 Too Many Requests'))
			.mockRejectedValueOnce(new Error('503 Service Unavailable'))
			.mockResolvedValueOnce('recovered');
		const result = await withRetry(fn, undefined, 3);
		expect(result).toBe('recovered');
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it('does not retry on a non-retriable error', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('400 Bad Request'));
		await expect(withRetry(fn)).rejects.toThrow('400 Bad Request');
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it('throws the last error after exhausting all attempts', async () => {
		const fn = vi.fn().mockRejectedValue(new Error('429 rate limit'));
		await expect(withRetry(fn, undefined, 2)).rejects.toThrow('429 rate limit');
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it('respects cancellation — bails before retrying when cancelled', async () => {
		vi.useFakeTimers();
		// fn throws 429 on the first attempt and flips the cancel flag; the
		// backoff sleeps, and before the second attempt withRetry sees the
		// cancellation and throws "Cancelled".
		let cancelled = false;
		const fn = vi.fn().mockImplementation(() => {
			cancelled = true;
			return Promise.reject(new Error('429'));
		});
		const token = { get isCancellationRequested() { return cancelled; } } as const;

		let rejection: unknown;
		const promise = withRetry(fn, token, 3).catch((e: unknown) => {
			rejection = e;
		});
		await vi.advanceTimersByTimeAsync(2_000);
		await promise;
		expect(rejection).toBeInstanceOf(Error);
		expect((rejection as Error).message).toBe('Cancelled');
		// fn was called once (the first attempt), not retried.
		expect(fn).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});
});

describe('withModelFailover', () => {
	// Fake models — objects with a `name` we can read in assertions. The helper
	// is generic over the model type (`M`), so any shape works; we don't need
	// a real `vscode.LanguageModelChat` here.
	type FakeModel = { name: string };
	const mk = (name: string): FakeModel => ({ name });
	const refs = [
		{ vendor: 'glm', family: 'a', id: 'fallback-a' },
		{ vendor: 'glm', family: 'b', id: 'fallback-b' },
	];

	it('returns the primary result and reports `usedFallback:false` when the primary succeeds — no fallback pick called', async () => {
		const primary = mk('primary');
		const send = vi.fn().mockResolvedValue('ok');
		const pick = vi.fn();
		const out = await withModelFailover(primary, refs, pick, send);
		expect(out).toEqual({ result: 'ok', usedRef: undefined, usedFallback: false });
		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith(primary);
		expect(pick).not.toHaveBeenCalled();
	});

	it('swaps to the first fallback after the primary exhausts retries on a retriable error', async () => {
		vi.useFakeTimers();
		try {
			const primary = mk('primary');
			const send = vi.fn()
				.mockRejectedValueOnce(new Error('429'))
				.mockRejectedValueOnce(new Error('429'))
				.mockRejectedValueOnce(new Error('429')) // primary: 3 attempts, all 429
				.mockResolvedValueOnce('fb-a-ok');      // fallback-a: 1 attempt, ok
			const pick = vi.fn().mockResolvedValue(mk('fallback-a'));
			const promise = withModelFailover(primary, refs, pick, send, undefined);
			// Primary's 3 attempts fire 2 backoffs (1s + 2s) before swap.
			await vi.advanceTimersByTimeAsync(4_000);
			const out = await promise;
			expect(out.result).toBe('fb-a-ok');
			expect(out.usedFallback).toBe(true);
			expect(out.usedRef).toEqual(refs[0]);
			expect(pick).toHaveBeenCalledTimes(1); // only fallback-a (lazy)
			expect(pick).toHaveBeenCalledWith(refs[0]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('proceeds to the next fallback when the first fallback also exhausts retries', async () => {
		vi.useFakeTimers();
		try {
			const primary = mk('primary');
			const send = vi.fn();
			// Primary: 3×429.
			send.mockRejectedValueOnce(new Error('429'));
			send.mockRejectedValueOnce(new Error('429'));
			send.mockRejectedValueOnce(new Error('429'));
			// fallback-a: 3×503.
			send.mockRejectedValueOnce(new Error('503'));
			send.mockRejectedValueOnce(new Error('503'));
			send.mockRejectedValueOnce(new Error('503'));
			// fallback-b: ok.
			send.mockResolvedValueOnce('fb-b-ok');
			const pick = vi.fn()
				.mockResolvedValueOnce(mk('fallback-a'))
				.mockResolvedValueOnce(mk('fallback-b'));
			const promise = withModelFailover(primary, refs, pick, send, undefined);
			// primary (2 backoffs: 1+2s) + fallback-a (2 backoffs: 1+2s) before
			// fallback-b succeeds on its first attempt.
			await vi.advanceTimersByTimeAsync(8_000);
			const out = await promise;
			expect(out.result).toBe('fb-b-ok');
			expect(out.usedRef).toEqual(refs[1]);
			expect(out.usedFallback).toBe(true);
			expect(pick).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rethrows immediately on a non-retriable error — does NOT try a fallback', async () => {
		const primary = mk('primary');
		const send = vi.fn().mockRejectedValue(new Error('400 Bad Request'));
		const pick = vi.fn();
		await expect(withModelFailover(primary, refs, pick, send)).rejects.toThrow('400 Bad Request');
		expect(send).toHaveBeenCalledTimes(1);
		expect(pick).not.toHaveBeenCalled();
	});

	it('throws the last error when every model in the chain exhausts retries', async () => {
		vi.useFakeTimers();
		try {
			const primary = mk('primary');
			const send = vi.fn().mockRejectedValue(new Error('429 rate limit'));
			const pick = vi.fn()
				.mockResolvedValueOnce(mk('fallback-a'))
				.mockResolvedValueOnce(mk('fallback-b'));
			const promise = withModelFailover(primary, refs, pick, send, undefined).catch((e: unknown) => e);
			// 3 models × 2 backoffs each (1+2+4s capped at 8s) → flush plenty.
			await vi.advanceTimersByTimeAsync(40_000);
			const rejection = await promise;
			expect(rejection).toBeInstanceOf(Error);
			expect((rejection as Error).message).toBe('429 rate limit');
			// 3 attempts × (primary + 2 fallbacks) = 9 calls.
			expect(send).toHaveBeenCalledTimes(9);
			expect(pick).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('skips a fallback whose `pick` rejects (model unregistered) and tries the next', async () => {
		vi.useFakeTimers();
		try {
			const primary = mk('primary');
			const send = vi.fn();
			send.mockRejectedValueOnce(new Error('429'));
			send.mockRejectedValueOnce(new Error('429'));
			send.mockRejectedValueOnce(new Error('429'));
			send.mockResolvedValueOnce('fb-b-ok');
			const pick = vi.fn()
				.mockRejectedValueOnce(new Error('No model found for fallback-a'))
				.mockResolvedValueOnce(mk('fallback-b'));
			const promise = withModelFailover(primary, refs, pick, send, undefined);
			// Primary's 2 backoffs (1+2s) before the failed pick + fallback-b ok.
			await vi.advanceTimersByTimeAsync(4_000);
			const out = await promise;
			expect(out.result).toBe('fb-b-ok');
			// The rejected fallback isn't counted as `usedFallback` — fallback-b
			// is, because it actually handled the turn. Note: the helper records
			// the fallback by index in `refs`, so when pick for fallback-a throws,
			// `i` still advances past it and `usedRef` is `refs[1]` (fallback-b).
			expect(out.usedRef).toEqual(refs[1]);
			expect(out.usedFallback).toBe(true);
			expect(pick).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not attempt fallbacks when `fallbackRefs` is empty — just runs primary with withRetry', async () => {
		const primary = mk('primary');
		const send = vi.fn().mockResolvedValue('primary-ok');
		const pick = vi.fn();
		const out = await withModelFailover(primary, [], pick, send);
		expect(out).toEqual({ result: 'primary-ok', usedRef: undefined, usedFallback: false });
		expect(pick).not.toHaveBeenCalled();
		expect(send).toHaveBeenCalledTimes(1);
	});
});