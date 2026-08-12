import type { PricingCurrency } from '../../types';

/**
 * Minimal persistence surface — VS Code's `globalState` Memento satisfies it.
 * Kept as an interface so the tracker stays testable without vscode.
 */
export interface UsageCostStore {
	get(key: string): unknown;
	update(key: string, value: unknown): Thenable<void>;
}

const STORAGE_KEY = 'usageCostByDay.v1';
/** Entries older than this many days are pruned on write. */
const MAX_DAYS_KEPT = 31;

type DayBuckets = Partial<Record<PricingCurrency, number>>;
type StoredData = Record<string, DayBuckets>;

/** Local-timezone `YYYY-MM-DD` key for a date (defaults to now). */
export function localDayKey(date: Date = new Date()): string {
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Rolling per-day cost totals persisted to `globalState`.
 *
 * This is the standalone version of the fork's usage tracker: no SQLite, no
 * OpenCode billing tiers — just day buckets per currency that survive restarts.
 */
export class UsageCostTracker {
	private readonly byDay: StoredData;

	constructor(private readonly store: UsageCostStore) {
		this.byDay = loadStoredData(store.get(STORAGE_KEY));
	}

	record(currency: PricingCurrency, totalCost: number): void {
		const day = localDayKey();
		const buckets = this.byDay[day] ?? {};
		buckets[currency] = (buckets[currency] ?? 0) + totalCost;
		this.byDay[day] = buckets;
		this.persist();
	}

	dayTotal(currency: PricingCurrency, day: string = localDayKey()): number {
		return this.byDay[day]?.[currency] ?? 0;
	}

	monthTotal(currency: PricingCurrency, day: string = localDayKey()): number {
		const prefix = day.slice(0, 7);
		let total = 0;
		for (const [key, buckets] of Object.entries(this.byDay)) {
			if (key.startsWith(prefix)) {
				total += buckets[currency] ?? 0;
			}
		}
		return total;
	}

	private persist(): void {
		const cutoff = localDayKey(new Date(Date.now() - MAX_DAYS_KEPT * 86_400_000));
		for (const key of Object.keys(this.byDay)) {
			if (key < cutoff) {
				delete this.byDay[key];
			}
		}
		void this.store.update(STORAGE_KEY, this.byDay);
	}
}

function loadStoredData(raw: unknown): StoredData {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return {};
	}
	const data: StoredData = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (/^\d{4}-\d{2}-\d{2}$/.test(key) && isBuckets(value)) {
			data[key] = value;
		}
	}
	return data;
}

function isBuckets(value: unknown): value is DayBuckets {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	return Object.values(value).every((v) => typeof v === 'number');
}
