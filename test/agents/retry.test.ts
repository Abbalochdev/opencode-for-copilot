import { describe, expect, it, vi } from 'vitest';
import { isRetriableError, withRetry } from '../../src/agents/retry';

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