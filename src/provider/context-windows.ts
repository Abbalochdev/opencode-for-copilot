/**
 * Learned per-model context windows.
 *
 * models.dev lists the *upstream* model spec, but OpenCode's gateway enforces
 * its own (sometimes much smaller) effective context per model. When a request
 * overflows, the gateway's error message carries the authoritative window —
 * `analyzeContextOverflow()` already parses it — so record it and clamp the
 * advertised `maxInputTokens` on the next picker refresh. Self-correcting:
 * each model learns its real limit from its first rejection, and Copilot Chat
 * (which compacts against the advertised window) compacts *before* the wall
 * instead of after a hard API error.
 */

import { logger } from '../logger';

/**
 * Minimal persistence surface — VS Code's `globalState` Memento satisfies it.
 * Kept as an interface so the store stays testable without vscode.
 */
export interface ContextWindowStore {
	get(key: string): unknown;
	update(key: string, value: unknown): Thenable<void>;
}

const STORAGE_KEY = 'learnedContextWindows.v1';
/** Cap on stored entries — the catalog is bounded, so this is generous. */
const MAX_ENTRIES = 500;

type StoredData = Record<string, number>;

let store: ContextWindowStore | undefined;
let observedByModelId: StoredData = {};

/** Wire up persistence (call once at activation with `context.globalState`). */
export function setContextWindowStore(storage: ContextWindowStore | undefined): void {
	store = storage;
	observedByModelId = loadStoredData(storage?.get(STORAGE_KEY));
}

/**
 * Called the first time a model's learned window changes — the provider fires
 * its picker-refresh event so the advertised limit updates immediately
 * instead of waiting for the next catalog TTL.
 */
let onLearned: ((modelId: string, contextWindow: number) => void) | undefined;

export function setOnContextWindowLearned(
	callback: ((modelId: string, contextWindow: number) => void) | undefined,
): void {
	onLearned = callback;
}

/**
 * Record the effective context window a gateway reported for a model.
 * Keeps the smallest observed window — the gateway may serve different
 * backends with different limits, and the lower bound is the safe one.
 */
export function recordObservedContextWindow(modelId: string, contextWindow: number): void {
	if (!modelId || !Number.isFinite(contextWindow) || contextWindow <= 0) {
		return;
	}
	const existing = observedByModelId[modelId];
	if (existing !== undefined && existing <= contextWindow) {
		return;
	}
	observedByModelId[modelId] = contextWindow;
	persist(modelId, contextWindow);
	onLearned?.(modelId, contextWindow);
}

/**
 * The effective input window to advertise for a model: the smallest of the
 * observed gateway window (if learned) and the catalog spec. `undefined` when
 * no observation exists (callers fall through to the spec).
 */
export function effectiveContextWindow(
	modelId: string,
	catalogMaxInputTokens: number,
): number | undefined {
	const observed = observedByModelId[modelId];
	if (observed === undefined || observed >= catalogMaxInputTokens) {
		return undefined;
	}
	return observed;
}

/** Test helper — forget everything (including persisted state). */
export function clearLearnedContextWindows(): void {
	observedByModelId = {};
	store?.update(STORAGE_KEY, observedByModelId);
}

function persist(changedModelId: string, contextWindow: number): void {
	if (!store) {
		return;
	}
	// Bound the stored map: drop the entry we are about to overwrite-check
	// last so an overfull store evicts least-recently-updated models first.
	const keys = Object.keys(observedByModelId);
	if (keys.length > MAX_ENTRIES) {
		delete observedByModelId[keys[0]];
	}
	void store.update(STORAGE_KEY, observedByModelId).then(undefined, (error) => {
		logger.warn(`Failed to persist learned context window for ${changedModelId}:`, error);
	});
}

function loadStoredData(raw: unknown): StoredData {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		return {};
	}
	const data: StoredData = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
			data[key] = value;
		}
	}
	return data;
}
