import { describe, expect, it } from 'vitest';
import {
    localDayKey,
    UsageCostTracker,
    type UsageCostStore,
} from '../../../src/provider/pricing/tracker';

const STORAGE_KEY = 'usageCostByDay.v1';

function createStore(seed?: unknown): {
	store: UsageCostStore;
	data: Record<string, unknown>;
} {
	const data: Record<string, unknown> = {};
	if (seed !== undefined) {
		data[STORAGE_KEY] = seed;
	}
	return {
		data,
		store: {
			get: (key) => data[key],
			update: (key, value) => {
				data[key] = value;
				return Promise.resolve();
			},
		},
	};
}

describe('UsageCostTracker', () => {
	it('accumulates costs into today’s bucket per currency', () => {
		const { store } = createStore();
		const tracker = new UsageCostTracker(store);

		tracker.record('USD', 0.25);
		tracker.record('USD', 0.1);

		expect(tracker.dayTotal('USD')).toBeCloseTo(0.35);
		expect(tracker.monthTotal('USD')).toBeCloseTo(0.35);
	});

	it('keeps currencies separate', () => {
		const { store } = createStore();
		const tracker = new UsageCostTracker(store);

		tracker.record('USD', 1);
		tracker.record('CNY', 3);

		expect(tracker.dayTotal('USD')).toBe(1);
		expect(tracker.dayTotal('CNY')).toBe(3);
	});

	it('sums the whole month for the given day key', () => {
		const { store } = createStore({
			'2026-08-01': { USD: 1 },
			'2026-08-31': { USD: 2 },
			'2026-07-31': { USD: 100 },
		});
		const tracker = new UsageCostTracker(store);

		expect(tracker.dayTotal('USD', '2026-08-01')).toBe(1);
		expect(tracker.monthTotal('USD', '2026-08-15')).toBe(3);
		expect(tracker.monthTotal('CNY', '2026-08-15')).toBe(0);
	});

	it('persists the updated day bucket to the store', async () => {
		const { store, data } = createStore({ '2026-08-01': { USD: 1 } });
		const tracker = new UsageCostTracker(store);

		tracker.record('USD', 0.5);

		await Promise.resolve();
		const stored = data[STORAGE_KEY] as Record<string, Record<string, number>>;
		expect(stored['2026-08-01']).toEqual({ USD: 1 });
		expect(stored[localDayKey()].USD).toBeCloseTo(0.5);
	});

	it('prunes entries older than 31 days on write', async () => {
		const { store, data } = createStore({
			'2020-01-01': { USD: 9 },
			'2020-01-02': { USD: 9 },
		});
		const tracker = new UsageCostTracker(store);

		tracker.record('USD', 1);

		await Promise.resolve();
		const stored = data[STORAGE_KEY] as Record<string, Record<string, number>>;
		expect(stored['2020-01-01']).toBeUndefined();
		expect(stored['2020-01-02']).toBeUndefined();
		expect(stored[localDayKey()].USD).toBe(1);
	});

	it('starts empty when the stored value is not a plain day map', () => {
		const { store } = createStore('junk');
		const tracker = new UsageCostTracker(store);

		expect(tracker.dayTotal('USD')).toBe(0);
		tracker.record('USD', 0.5);
		expect(tracker.dayTotal('USD')).toBeCloseTo(0.5);
	});
});
