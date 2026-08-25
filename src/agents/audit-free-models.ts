import * as vscode from 'vscode';
import { FREE_MODEL_REFS } from '../provider/opencode-models';
import { pickModel } from './modelSelect';
import type { FreeModelAuditEntry, ModelRef } from './types';

/**
 * Runtime audit of OpenCode's free-tier models.
 *
 * Problem being solved:
 *   The swarm's historical defaults (Big Pickle research, Big Pickle review,
 *   DeepSeek V4 Flash Free implementer-fallback) are hardcoded. When one of
 *   them is down — provider outage, daily quota exhausted, regional routing
 *   issue — the swarm silently sends research areas to a model that 429/5xxs,
 *   producing empty findings or sinking the review stage. Users had no way to
 *   know *which* free model was working *right now*.
 *
 * Fix:
 *   Before each swarm run (when the user has NOT pinned `agentRoles.*`), fan
 *   out a tiny probe to every free-tier model in parallel. Each probe
 *   resolves the model (catches "no model found" outright) and fires one
 *   short sendRequest (catches quota/outage during a real call). Successful
 *   probes report their response latency; failures report an error class.
 *   The caller then selects the fastest responders and routes the swarm
 *   through them — Big Pickle being down no longer silently degrades
 *   research because MiMo Free / Nemotron Free / Ling Free pick up the slack.
 *
 * `lazy:` ceiling — probes are best-effort. A model that passes probe and
 * fails mid-run still surfaces via the existing retry/backoff in `withRetry`,
 * which keeps responsibility for *transient* errors there. The audit's job
 * is only to triage *permanent-unavailability* (no model registered) and
 * *initial-request* failures (outright quota exhausted, regional outage).
 * Mixing retry into audit would burn through every model on every 429.
 */

/** Default probe timeout per model (configurable via `opencode-for-copilot.auditFreeModelProbeMs`). */
export const DEFAULT_AUDIT_PROBE_MS = 6_000;

/** Tiny probe prompt — minimizes tokens spent on the audit itself. */
const PROBE_USER_PROMPT = 'Reply with the single word "ok".';

/**
 * Probe one free model. Returns a {@link FreeModelAuditEntry}. Never throws —
 * all failures are caught and translated into `ok: false` entries so the
 * parallel {@link Promise.allSettled}-shaped caller can rank without
 * try/catch noise.
 *
 * Failure classification rules:
 *   - `No model found …`         → "no model found"   (model not registered)
 *   - retriable patterns (429/5xx/network) → "transient" (quota / outage)
 *   - timeout                    → "timeout"
 *   - anything else              → "other"
 *
 * "transient" failures are reported but the model is still marked NOT ok —
 * we don't want the swarm to route through a model that 429s on its probe,
 * because the actual research call would 429 too. The user can look at the
 * report and either retry or pick a different model manually.
 */
export async function auditOneFreeModel(
	ref: ModelRef,
	probeTimeoutMs: number,
	token?: vscode.CancellationToken,
): Promise<FreeModelAuditEntry> {
	if (token?.isCancellationRequested) {
		return { ref, ok: false, errorClass: 'cancelled', errorMessage: 'Cancelled before probe' };
	}
	let model: vscode.LanguageModelChat;
	try {
		model = await pickModel(ref);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ref,
			ok: false,
			errorClass: 'no model found',
			errorMessage: message,
		};
	}
	if (token?.isCancellationRequested) {
		return { ref, ok: false, errorClass: 'cancelled', errorMessage: 'Cancelled after lookup' };
	}
	const start = Date.now();
	try {
		// Race the sendRequest against a timeout — VS Code's sendRequest isn't
		// directly timeout-aware, so we abort via a manual Promise.race.
		const messages: vscode.LanguageModelChatMessage[] = [
			vscode.LanguageModelChatMessage.User(PROBE_USER_PROMPT),
		];
		const response = await model.sendRequest(messages, {}, token);
		await Promise.race([
			// Drain the response's stream to actually trigger the network
			// round-trip — break after the first part, we only want first-byte
			// latency, not the full completion.
			(async () => {
				for await (const _part of response.stream) {
					break;
				}
			})(),
			new Promise<never>((_resolve, reject) =>
				setTimeout(() => reject(new Error('probe timed out')), probeTimeoutMs),
			),
		]);
		return { ref, ok: true, latencyMs: Date.now() - start };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			ref,
			ok: false,
			errorClass: classifyProbeError(message),
			errorMessage: message,
		};
	}
}

/** Classify a probe error into a short, stable category string for reporting. */
function classifyProbeError(message: string): string {
	const lower = message.toLowerCase();
	if (lower.includes('probe timed out') || lower.includes('timeout')) return 'timeout';
	if (/\b(429|rate[ -]?limit|too many requests)\b/.test(lower)) return 'transient';
	if (/\b50[237]\b|(bad gateway|service unavailable|gateway timeout)/.test(lower)) return 'transient';
	if (/(econnreset|econnrefused|etimedout|enotfound|eai_again|und_err_)/.test(lower)) return 'transient';
	if (/(network|fetch|socket).*(failed|error|reset)/.test(lower)) return 'transient';
	return 'other';
}

/**
 * Fan out probes to every free model in parallel and return results.
 * Never throws — each entry's `ok` field carries the outcome. Respects
 * cancellation: an aborted audit returns the entries resolved so far (with
 * `ok: false` for unprobed models labelled "cancelled").
 */
export async function auditFreeModels(
	refs: readonly ModelRef[] = FREE_MODEL_REFS,
	probeTimeoutMs: number = DEFAULT_AUDIT_PROBE_MS,
	token?: vscode.CancellationToken,
): Promise<FreeModelAuditEntry[]> {
	const probes = refs.map((ref) => auditOneFreeModel(ref, probeTimeoutMs, token));
	return Promise.all(probes);
}

/**
 * Filter audit results to OK entries, stable-sort them by latency ascending
 * (fastest responder first), and return just the `ModelRef`s. Used by the
 * pipeline to build the rotation sets for research / review and the fallback
 * chain for the implementer. Sort is stable to keep the determinism of
 * {@link FREE_MODEL_REFS}'s natural ordering for equal-latency ties.
 */
export function rankAuditedModels(entries: readonly FreeModelAuditEntry[]): ModelRef[] {
	const ok = entries.filter((e) => e.ok && typeof e.latencyMs === 'number');
	// Stable sort: pair each entry with its index, sort, then unpair.
	const indexed = ok.map((e, i) => [e, i] as const);
	indexed.sort((a, b) => (a[0].latencyMs! - b[0].latencyMs!) || (a[1] - b[1]));
	return indexed.map(([e]) => e.ref);
}

/**
 * Format the audit report for the @swarm final report. One line per model,
 * aligned. Example:
 *
 *   Audit (free models):
 *     ✓ MiMo V2.5 Free        1.2s
 *     ✓ Nemotron 3 Ultra Free 2.0s
 *     ✗ Big Pickle             no model found
 *     ✗ DeepSeek V4 Flash Free transient
 *
 * Returns an empty string when there are no entries (e.g. user pinned
 * `agentRoles` — audit was skipped). Keeps the @swarm report quiet when the
 * audit wasn't run, since high-signal rows beat a "no audit run" banner.
 */
export function formatAuditReport(entries: readonly FreeModelAuditEntry[]): string {
	if (entries.length === 0) {
		return '';
	}
	const lines = ['Audit (free models):'];
	for (const e of entries) {
		const name = e.ref.id ?? e.ref.family;
		if (e.ok) {
			const secs = ((e.latencyMs ?? 0) / 1000).toFixed(1);
			lines.push(`  ✓ ${name.padEnd(24)} ${secs}s`);
		} else {
			lines.push(`  ✗ ${name.padEnd(24)} ${e.errorClass ?? 'unknown'}`);
		}
	}
	return lines.join('\n');
}
