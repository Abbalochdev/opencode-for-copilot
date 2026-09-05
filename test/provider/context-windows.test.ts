import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearLearnedContextWindows,
    effectiveContextWindow,
    recordObservedContextWindow,
    setContextWindowStore,
    setOnContextWindowLearned,
    type ContextWindowStore,
} from '../../src/provider/context-windows';

function createMockStore(): ContextWindowStore & { data: Map<string, unknown> } {
	const data = new Map<string, unknown>();
	return {
		data,
		get: (key) => data.get(key),
		update: async (key, value) => {
			data.set(key, value);
		},
	};
}

describe('learned context windows', () => {
	beforeEach(() => {
		clearLearnedContextWindows();
		setOnContextWindowLearned(undefined);
		setContextWindowStore(undefined);
	});

	describe('recordObservedContextWindow', () => {
		it('records a new observation and persists it', () => {
			const store = createMockStore();
			setContextWindowStore(store);

			recordObservedContextWindow('glm-5.3-flash', 260_144);

			expect(store.data.get('learnedContextWindows.v1')).toStrictEqual({
				'glm-5.3-flash': 260_144,
			});
		});

		it('keeps the smallest window when the gateway reports multiple limits', () => {
			recordObservedContextWindow('glm-x', 400_000);
			recordObservedContextWindow('glm-x', 260_144);
			expect(effectiveContextWindow('glm-x', 1_000_000)).toBe(260_144);

			// A larger report must not replace the smaller (safer) observation.
			recordObservedContextWindow('glm-x', 500_000);
			expect(effectiveContextWindow('glm-x', 1_000_000)).toBe(260_144);
		});

		it('ignores invalid input', () => {
			recordObservedContextWindow('', 100_000);
			recordObservedContextWindow('glm-x', 0);
			recordObservedContextWindow('glm-x', -5);
			recordObservedContextWindow('glm-x', Number.NaN);
			expect(effectiveContextWindow('glm-x', 1_000_000)).toBeUndefined();
		});
	});

	describe('effectiveContextWindow', () => {
		it('returns undefined when nothing was learned', () => {
			expect(effectiveContextWindow('glm-5.3-flash', 1_000_000)).toBeUndefined();
		});

		it('returns undefined when the observation is not smaller than the catalog spec', () => {
			recordObservedContextWindow('glm-a', 1_000_000);
			expect(effectiveContextWindow('glm-a', 1_000_000)).toBeUndefined();
			// Observation larger than the spec — nothing to clamp.
			recordObservedContextWindow('glm-b', 900_000);
			expect(effectiveContextWindow('glm-b', 400_000)).toBeUndefined();
		});

		it('clamps the catalog spec to the learned window', () => {
			recordObservedContextWindow('glm-5.3-flash', 260_144);
			expect(effectiveContextWindow('glm-5.3-flash', 1_000_000)).toBe(260_144);
		});
	});

	describe('persistence', () => {
		it('restores learned windows across restarts', () => {
			const store = createMockStore();
			setContextWindowStore(store);
			recordObservedContextWindow('glm-5.3-flash', 260_144);

			// Simulate a restart: fresh module state re-loads from the store.
			setContextWindowStore(store);
			expect(effectiveContextWindow('glm-5.3-flash', 1_000_000)).toBe(260_144);
		});

		it('ignores corrupt stored data', () => {
			const store = createMockStore();
			store.data.set('learnedContextWindows.v1', { 'glm-x': 'not-a-number', 'glm-y': -1, 'glm-z': 260_144 });
			setContextWindowStore(store);
			expect(effectiveContextWindow('glm-x', 1_000_000)).toBeUndefined();
			expect(effectiveContextWindow('glm-y', 1_000_000)).toBeUndefined();
			expect(effectiveContextWindow('glm-z', 1_000_000)).toBe(260_144);
		});

		it('works without a store (in-memory only)', () => {
			recordObservedContextWindow('glm-5.3-flash', 260_144);
			expect(effectiveContextWindow('glm-5.3-flash', 1_000_000)).toBe(260_144);
		});
	});

	describe('onLearned callback', () => {
		it('fires only when the window actually changes', () => {
			const onLearned = vi.fn();
			setOnContextWindowLearned(onLearned);

			recordObservedContextWindow('glm-x', 400_000);
			recordObservedContextWindow('glm-x', 500_000); // larger → ignored
			expect(onLearned).toHaveBeenCalledOnce();
			expect(onLearned).toHaveBeenCalledWith('glm-x', 400_000);

			recordObservedContextWindow('glm-x', 260_144); // smaller → new
			expect(onLearned).toHaveBeenCalledTimes(2);
			expect(onLearned).toHaveBeenLastCalledWith('glm-x', 260_144);
		});
	});
});
