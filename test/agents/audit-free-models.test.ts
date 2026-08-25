import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    auditFreeModels,
    auditOneFreeModel,
    DEFAULT_AUDIT_PROBE_MS,
    formatAuditReport,
    rankAuditedModels,
} from '../../src/agents/audit-free-models';
import type { FreeModelAuditEntry, ModelRef } from '../../src/agents/types';

/**
 * Real `pickModel` (imported by audit-free-models) calls
 * `vscode.lm.selectChatModels(...)`. The default `vscode` test mock does NOT
 * expose `lm`, so a bare import would crash the probe with a TypeError
 * instead of producing the production "No model found" error the classifier
 * keys on. Registering an empty-registry `lm` here routes the test through
 * the real `pickModel` "no model found" branch — and the mocks maintain a
 * tiny registry so a probe that *should* succeed can be expressed by
 * calling `__registerChatModel` in a specific test.
 */
vi.mock('vscode', async (importOriginal) => {
	const original = (await importOriginal()) as typeof import('../support/vscode.mock');
	const { LanguageModelChatMessageRole, LanguageModelTextPart } = original;

	class LanguageModelChatMessage {
		constructor(readonly role: number, readonly content: readonly unknown[]) {}
		static User(content: string | readonly unknown[]): LanguageModelChatMessage {
			return new LanguageModelChatMessage(
				LanguageModelChatMessageRole.User,
				typeof content === 'string' ? [new LanguageModelTextPart(content)] : content,
			);
		}
	}

	const registered: Array<{
		vendor: string;
		family: string;
		id?: string;
		sendRequest(): { stream: AsyncIterable<unknown> };
	}> = [];

	return {
		...original,
		LanguageModelChatMessage,
		lm: {
			async selectChatModels(filter?: { vendor?: string; family?: string; id?: string }) {
				return registered.filter(
					(m) =>
						(!filter?.vendor || m.vendor === filter.vendor) &&
						(!filter?.family || m.family === filter.family) &&
						(!filter?.id || m.id === filter.id),
				);
			},
		},
		__registerChatModel(m: (typeof registered)[number]) {
			registered.push(m);
		},
		__resetLm() {
			registered.length = 0;
		},
	};
});

// ---- Pure helpers (no vscode surface needed) ----

const REF = { vendor: 'glm', family: 'f', id: 'free-model-x' } satisfies ModelRef;

describe('rankAuditedModels', () => {
	it('returns the `ok` entries sorted ascending by latencyMs', () => {
		const entries: FreeModelAuditEntry[] = [
			{ ref: REF, ok: false, errorClass: 'no model found' },
			{ ref: { ...REF, id: 'mid' }, ok: true, latencyMs: 1500 },
			{ ref: { ...REF, id: 'fast' }, ok: true, latencyMs: 700 },
			{ ref: { ...REF, id: 'slow' }, ok: true, latencyMs: 2500 },
			{ ref: REF, ok: false, errorClass: 'timeout' },
		];
		expect(rankAuditedModels(entries).map((r) => r.id)).toEqual([
			'fast',
			'mid',
			'slow',
		]);
	});

	it('drops entries where `ok` is true but latencyMs is missing', () => {
		const entries: FreeModelAuditEntry[] = [
			{ ref: { ...REF, id: 'a' }, ok: true }, // no latencyMs — exclude
			{ ref: { ...REF, id: 'b' }, ok: true, latencyMs: 1000 },
		];
		expect(rankAuditedModels(entries).map((r) => r.id)).toEqual(['b']);
	});

	it('stable-sorts by latency → preserves original order for equal-latency ties', () => {
		// Catalogue order: a, b, c — all the same latency → original order preserved.
		const entries: FreeModelAuditEntry[] = [
			{ ref: { ...REF, id: 'a' }, ok: true, latencyMs: 1000 },
			{ ref: { ...REF, id: 'b' }, ok: true, latencyMs: 1000 },
			{ ref: { ...REF, id: 'c' }, ok: true, latencyMs: 1000 },
		];
		expect(rankAuditedModels(entries).map((r) => r.id)).toEqual(['a', 'b', 'c']);
	});

	it('returns an empty array when no entry is `ok`', () => {
		const entries: FreeModelAuditEntry[] = [
			{ ref: REF, ok: false, errorClass: 'transient' },
			{ ref: REF, ok: false, errorClass: 'no model found' },
		];
		expect(rankAuditedModels(entries)).toEqual([]);
	});

	it('returns an empty array for an empty input list', () => {
		expect(rankAuditedModels([])).toEqual([]);
	});
});

describe('formatAuditReport', () => {
	it('returns an empty string for an empty entry list', () => {
		expect(formatAuditReport([])).toBe('');
	});

	it('renders ✓ + seconds (one decimal) for ok entries, ✗ + errorClass for failed', () => {
		const entries: FreeModelAuditEntry[] = [
			{ ref: { ...REF, id: 'mimo-v2.5-free' }, ok: true, latencyMs: 1234 },
			{ ref: { ...REF, id: 'big-pickle' }, ok: false, errorClass: 'transient' },
		];
		const out = formatAuditReport(entries);
		expect(out).toBe(
			'Audit (free models):\n' +
				`  \u2713 ${'mimo-v2.5-free'.padEnd(24)} 1.2s\n` +
				`  \u2717 ${'big-pickle'.padEnd(24)} transient`,
		);
	});

	it('aligns ✓ rows with the name pad for single-name ids', () => {
		const out = formatAuditReport([
			{ ref: { ...REF, id: 'a' }, ok: true, latencyMs: 500 },
		]);
		expect(out).toContain(`  \u2713 ${'a'.padEnd(24)} 0.5s`);
	});

	it('shows "unknown" when an ok=false entry has no errorClass', () => {
		const out = formatAuditReport([{ ref: REF, ok: false }]);
		expect(out).toContain(`\u2717 ${'free-model-x'.padEnd(24)} unknown`);
	});
});

// ---- Runtime probe behaviour ----
//
// `auditOneFreeModel` / `auditFreeModels` call `pickModel` from the same
// module. With `lm` mocked (empty by default), an unregistered ModelRef
// trips the "No model found" branch; a registered model via
// `__registerChatModel` exercises the success path.

import { __registerChatModel, __resetLm } from 'vscode';

const token = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
} as const;

describe('auditOneFreeModel', () => {
	beforeEach(() => {
		__resetLm();
	});

	it('marks the entry `ok:false, errorClass:"no model found"` when pickModel throws', async () => {
		const out = await auditOneFreeModel(
			{ vendor: 'glm', family: 'never-registered', id: 'never-registered' },
			DEFAULT_AUDIT_PROBE_MS,
			token as any,
		);
		expect(out.ok).toBe(false);
		expect(out.errorClass).toBe('no model found');
		expect(out.errorMessage).toMatch(/No model found/);
	});

	it('marks the entry "cancelled" before lookup when the token is already cancelled', async () => {
		const cancelled = {
			isCancellationRequested: true,
			onCancellationRequested: () => ({ dispose() {} }),
		};
		const out = await auditOneFreeModel(REF, DEFAULT_AUDIT_PROBE_MS, cancelled as any);
		expect(out.ok).toBe(false);
		expect(out.errorClass).toBe('cancelled');
	});

	it('marks the entry `ok:true` with a numeric latencyMs when the probe succeeds', async () => {
		__registerChatModel({
			vendor: 'glm',
			family: 'f',
			id: 'free-model-x',
			async sendRequest() {
				return {
					stream: (async function* () {
						yield null; // first-byte latency only — drain loop breaks after one part
					})(),
				};
			},
		});
		const out = await auditOneFreeModel(REF, DEFAULT_AUDIT_PROBE_MS, token as any);
		expect(out.ok).toBe(true);
		expect(typeof out.latencyMs).toBe('number');
		expect(out.latencyMs! >= 0).toBe(true);
	});

	it('marks a probe error as "timeout" when sendRequest rejects with a "probe timed out"-ish message', async () => {
		__registerChatModel({
			vendor: 'glm',
			family: 'f',
			id: 'flaky',
			async sendRequest() {
				throw new Error('server timeout');
			},
		});
		const out = await auditOneFreeModel(
			{ ...REF, id: 'flaky' },
			DEFAULT_AUDIT_PROBE_MS,
			token as any,
		);
		expect(out.ok).toBe(false);
		expect(out.errorClass).toBe('timeout'); // "server timeout" matches the timeout classifier
	});
});

describe('auditFreeModels', () => {
	beforeEach(() => {
		__resetLm();
	});

	it('returns one entry per input ref, never throws, even when every ref is unavailable', async () => {
		const refs = [
			{ vendor: 'glm', family: 'a', id: 'a-free' },
			{ vendor: 'glm', family: 'b', id: 'b-free' },
		];
		const out = await auditFreeModels(refs, DEFAULT_AUDIT_PROBE_MS, token as any);
		expect(out).toHaveLength(2);
		expect(out.every((e) => !e.ok)).toBe(true);
		expect(out.every((e) => e.errorClass === 'no model found')).toBe(true);
	});

	it('uses the default probe timeout when none is supplied', async () => {
		const out = await auditFreeModels(
			[{ vendor: 'glm', family: 'q', id: 'q-free' }],
			undefined as any,
			token as any,
		);
		expect(out).toHaveLength(1);
		expect(out[0].ok).toBe(false);
	});

	it('returns a mix of ok and not-ok entries when some probes succeed', async () => {
		__registerChatModel({
			vendor: 'glm',
			family: 'ok',
			id: 'ok-free',
			async sendRequest() {
				return { stream: (async function* () { yield null; })() };
			},
		});
		const out = await auditFreeModels(
			[
				{ vendor: 'glm', family: 'ok', id: 'ok-free' },
				{ vendor: 'glm', family: 'no', id: 'no-free' },
			],
			DEFAULT_AUDIT_PROBE_MS,
			token as any,
		);
		expect(out).toHaveLength(2);
		expect(out.find((e) => e.ref.id === 'ok-free')?.ok).toBe(true);
		expect(out.find((e) => e.ref.id === 'no-free')?.ok).toBe(false);
	});
});