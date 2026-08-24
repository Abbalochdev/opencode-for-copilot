# Fork Porting Roadmap: opencode-copilot-chat → GLM-for-copilot

> **Date:** 2026-08-12  
> **Source:** [ltmoerdani/opencode-copilot-chat](https://github.com/ltmoerdani/opencode-copilot-chat) (v0.5.2)  
> **Target:** GLM-for-copilot v3.9.0  
> **Approach:** Cherry-pick proven patterns, adapt to existing architecture. No regressions.

---

## Revalidation Verdict (2026-08-12)

Every feature was re-checked against the live codebase before implementation. Final status:

| # | Feature | Status | Evidence |
|---|---------|--------|----------|
| 1 | Context overflow auto-retry | ✅ **Implemented** | `src/client/error/overflow-retry.ts` (new); wired into `core.ts` between tool-halving and failover |
| 3 | Token estimation with tool schemas | 🔄 **Implemented (revised)** | `provideTokenCount` (VS Code API) cannot receive tools, so `countMessageChars()` now counts tool schemas instead — the API counts them in `prompt_tokens`, keeping the chars-per-token calibration honest |
| 5 | Transient 5xx classification | ✅ **Implemented** | `core.ts`: 502/504 added to `RETRYABLE_STATUSES`; other 5xx retried only when the body reports `RouterUnavailable` |
| 6 | Usage cost tracking | ✅ **Done** (standalone) | `globalState` day buckets, no SQLite |

**Tests:** `test/client/overflow-retry.test.ts` (new, 4 cases) + tools-weight case in `test/provider/convert.test.ts`. Full suite: 108 passing.

---

## Executive Summary

After deep analysis of 15+ source files in the fork, I identified **4 features worth porting**. The local extension already has strong foundations (vision cache, think-tag filter, tool-halving retry, CJK-aware token estimation, failover). The gap is in **resilience** (context overflow recovery) and **user experience** (token estimation including tools, cost tracking).

Prioritised by `(impact × feasibility) / risk`:

| # | Feature | Effort | Impact | Risk |
|---|---------|--------|--------|------|
| 1 | Context overflow auto-retry | Medium | 🔥 High | Low |
| 3 | Token estimation with tool schemas | Small | 🟡 Medium | Low |
| 5 | Transient 5xx classification | Small | 🟡 Medium | Low |
| 6 | Usage cost tracking (status bar) | Medium | 🟢 Nice-to-have | Medium |

---

## 1. Context Overflow Auto-Retry

> **Status: ✅ DONE** — implemented as `analyzeContextOverflow(errorMessage, currentMaxTokens)` in `src/client/error/overflow-retry.ts`, wired as retry **Phase 2.5** in `core.ts` (HTTP 400 → reduced `max_tokens` → one retry → fall through to failover). Tests: `test/client/overflow-retry.test.ts` (4 cases).

**Source:** Fork `retry.ts` → `patchContextOverflow()` + `analyzeHttp400ForRetry()`

**Problem:** When a request exceeds the model's context window, the API returns a `400` with a message like:
> *"maximum context length is 200,000 tokens, you requested 247,000 tokens, with 47,000 in the completion"*

Currently, this surfaces as a hard error to the user. The fork **automatically retries** by reducing `max_output_tokens` using the authoritative counts from the error message.

**What to port:**
- A pure function `analyzeContextOverflowError(errorMessage: string, request: GLMRequest)` that:
  1. Extracts `maximum context length` from error message
  2. Extracts `you requested N tokens` from error message  
  3. Computes overflow = requested - contextWindow
  4. Reduces `max_tokens` by overflow + safety margin (10% of context window, min 1024 tokens)
  5. Returns a patched `GLMRequest` if retry is viable, `undefined` otherwise
- Integrate into `GLMClient.streamChatCompletion()` as a **new retry phase** between the existing Phase 2 (tool-halving) and Phase 3 (failover)

**Where it lives:** New file `src/client/error/overflow-retry.ts`

**Key differences from fork:**
- Fork patches `max_tokens` / `max_output_tokens` / `max_completion_tokens` — we only use `max_tokens`
- Fork runs as part of an HTTP-400 handler; we should run it before the failover phase
- Safety margin: use `Math.max(1024, Math.floor(contextWindow * 0.10))` like the fork

**Implementation sketch:**
```typescript
// src/client/error/overflow-retry.ts
interface OverflowPatch {
  max_tokens: number;
  description: string;
}

export function analyzeContextOverflow(
  errorMessage: string,
  body: { max_tokens?: number; messages?: unknown[]; tools?: unknown[] },
): OverflowPatch | undefined {
  const contextWindow = parseTokenCount(
    errorMessage.match(/maximum context (?:length|window) is\s*([\d,]+)\s*tokens?/i)?.[1],
  );
  const requestedTokens = parseTokenCount(
    errorMessage.match(/you (?:requested|tried to send)\s*([\d,]+)\s*tokens?/i)?.[1],
  );
  if (!contextWindow || !requestedTokens) return undefined;
  
  const currentOutput = body.max_tokens ?? 4096;
  const overflow = requestedTokens - contextWindow;
  if (overflow <= 0) return undefined;
  
  const safetyMargin = Math.max(1024, Math.floor(contextWindow * 0.10));
  const nextOutput = Math.floor(currentOutput - overflow - safetyMargin);
  if (nextOutput < 1 || nextOutput >= currentOutput) return undefined;
  
  return {
    max_tokens: nextOutput,
    description: `reduced max_tokens from ${currentOutput} to ${nextOutput} (overflow: ${overflow}, context: ${contextWindow})`,
  };
}
```

**Integration point:** `src/client/core.ts` — after Phase 2 (tool-halving) fails, before Phase 3 (failover):
```typescript
// In streamChatCompletion(), after the tool-halving block:
if (error instanceof GLMRequestError && error.status === 400) {
  const patch = analyzeContextOverflow(error.serverMessage ?? error.message, request);
  if (patch) {
    logger.warn(`[overflow-retry] ${patch.description}`);
    const patchedRequest = { ...request, max_tokens: patch.max_tokens };
    try {
      await dispatch(patchedRequest);
      return;
    } catch { /* fall through to failover */ }
  }
}
```

**Test:** Unit test in `test/client/overflow-retry.test.ts` with real error message samples.

---

## 3. Token Estimation with Tool Schemas

> **Status: ✅ DONE (revised location).** `provideTokenCount` (the VS Code token-count API) cannot receive tool definitions, so the fix went into the calibration path instead: `countMessageChars(messages, tools?)` in `src/provider/convert.ts` now counts tool name + description + serialized schema, and `request.ts` passes `tools`. This keeps the chars-per-token ratio (used at `stream.ts:332` to calibrate from actual `prompt_tokens`) honest. Test case added to `test/provider/convert.test.ts`. **Note:** `src/provider/tokens.ts` was intentionally left untouched.

**Source:** Fork `tokenEstimate.ts` → `estimatePromptTokenCount()`

**Problem:** The current token estimator (`src/provider/tokens.ts`) estimates message content tokens but does **not** include tool definitions in the estimate. When the model has 20+ tools with large JSON schemas, the actual prompt is significantly larger than estimated, leading to unexpected context pressure.

**What to port:**
- Extend `estimatePromptTokenCount` to include serialized tool definitions in the character count.

**Where it lives:** `src/provider/tokens.ts` (existing file, small addition)

**Implementation:**
```typescript
// Add to existing estimatePromptTokenCount function in tokens.ts:
export function estimatePromptTokenCount(
  parts: unknown[],
  tools?: readonly Array<{ name: string; description?: string; inputSchema?: unknown }>,
): number {
  let chars = 0;
  for (const part of parts) {
    chars += estimatePartChars(part);
  }
  // Include tool definitions — their JSON schemas add significant token weight
  if (tools && tools.length > 0) {
    chars += JSON.stringify(tools).length;
  }
  return estimateTokenCountFromChars(chars);
}
```

**Impact:** More accurate output budget calculation → fewer context overflow errors (pairs with feature #1).

---

## 5. Transient 5xx Classification

> **Status: ✅ DONE.** `core.ts`: `RETRYABLE_STATUSES` extended to `{429, 502, 503, 504}`; new `isRetryableHttpError()` treats other 5xx as transient only when the body reports `RouterUnavailable` (whitespace-insensitive match on `serverMessage`/`message`).

**Source:** Fork `retry.ts` → `isTransientServerError()`

**Problem:** The current retry logic retries on 429 and 503 uniformly. The fork has more nuanced classification:
- 502/503/504 → always transient (gateway churn, upstream down)
- Other 5xx → transient only if error body contains `Router.Unavailable`
- This avoids wasting retry budget on permanent 500 errors

**What to port:**
- Extend the existing `RETRYABLE_STATUSES` check in `src/client/core.ts` to include 502 and 504
- Add body-content inspection for other 5xx

**Where it lives:** `src/client/core.ts` (modify existing retry logic)

**Implementation:**
```typescript
// In src/client/core.ts, update the retryable check:
function isRetryableError(error: GLMRequestError): boolean {
  const status = error.status;
  if (status === 429) return true;                              // Rate limit
  if (status === 502 || status === 503 || status === 504) return true; // Gateway churn
  if (status && status >= 500) {
    // Other 5xx: only retry if gateway reports router unavailability
    const msg = (error.serverMessage ?? error.message ?? '').toLowerCase();
    return msg.includes('router.unavailable') || msg.includes('router unavailable');
  }
  return false;
}
```

**Impact:** Reduces wasted retry attempts on permanent 500 errors, speeds up failover for genuine transient issues.

---

## 6. Usage Cost Tracking (Status Bar)

> **Status: ✅ DONE — standalone build, not a fork port (implemented per the recommendation below).**

**Source:** Fork `goUsageTracker.ts` + `usage.ts`

**Problem:** The local extension shows usage cost in the status bar after each request but doesn't persist a session history. The fork tracks per-request costs across sessions with rolling windows (5h session, weekly, monthly).

**Verdict:** ✅ **Implemented standalone** — the fork's tracker is tied to OpenCode's SQLite database (`opencode.db`) and billing tiers ($12/5h, $30/week, $60/month) that don't match GLM/Zhipu. Instead of porting, the extension got a simpler `globalState`-keyed tracker (see implementation note below).

**Recommendation:** If you want cost tracking, build a simpler version that:
1. Persists request costs to `globalState` keyed by day
2. Shows rolling 24h and monthly totals
3. No SQLite dependency
4. Status bar shows: `$(graph) GLM: $0.42 today · $3.21 month`

This is a standalone feature, not a fork port.

**Implementation (2026-08-12):** `UsageCostTracker` (`src/provider/pricing/tracker.ts`) persists per-day per-currency cost buckets to `globalState` (key `usageCostByDay.v1`, 31-day pruning, shape-guarded load, no SQLite). `UsageCostStatus` now shows `$(graph) GLM: $0.42 today · $3.21 month`, restores totals across restarts, and keeps per-turn/session/model detail in the tooltip. Tested in `test/provider/pricing/tracker.test.ts`.

---

## 7. Live Model List Fetching — checked, already at parity

> **Status: ✅ Already implemented** (shipped before this roadmap — not a port candidate).

Verified against the fork's `extension.ts` spec:

| Fork | Local (already has) |
|------|---------------------|
| Fetch `opencode.ai/zen/go/v1/models` on startup | `refreshDynamicModels()` fetches **Go + Zen** endpoints on startup, fire-and-forget (`provider/index.ts:120`) |
| 15s hard timeout | 10s `AbortSignal.timeout` (`opencode-models.ts:803`) — tighter |
| 3 retries + backoff on catalog fetch | No catalog-fetch retry — 5-min cache + static fallback make fetch failures invisible to the user; the request path already has the 3-attempt backoff retry |
| `globalState` cache, 1h TTL | models.dev snapshot persisted to `globalState` (30-min TTL, stale-while-revalidate, ETag) — `models-dev.ts`, wired at `provider/index.ts:113` |
| Bundled fallback list on failure | Static `MODELS` array fallback (`getDynamicModels`, `opencode-models.ts:932`) |
| Retry classification 408/429/5xx | Same pattern on the request path: `429/502/503/504` + `RouterUnavailable`-only 5xx (`core.ts`) |
| New models need extension release | Unknown IDs auto-generate sensible defaults — appear in the picker with no release (`opencode-models.ts`) |

**Verdict:** ✅ Already at parity — the extension is already evergreen for model additions. No work needed.

---

## 8. Runtime Diagnostics Command

> **Status: ✅ DONE** — ported from fork `runtimeDiagnostics.ts`, adapted to our config surface.

**Source:** Fork `runtimeDiagnostics.ts` (`runtimeDiagnosticsLines()`)

**Problem:** Bug reports rarely include the environment (extension version, VS Code version, endpoint preset, debug mode, Windows elevation). A one-command report makes triage instant.

**What was ported:**
- `buildRuntimeDiagnosticsReport(context)` in `src/runtime/diagnostics.ts` — privacy-safe markdown report:
  - **Environment:** extension + VS Code versions, app host, remote, UI kind, extension mode, workspace trust, platform/arch, Node version, Windows integrity level (`whoami.exe /groups`)
  - **Configuration:** endpoint preset, resolved base URL, API mode/protocol, debug mode, ponytail mode, code-simplifier state, model count in overlay
  - Never includes the API key or prompt content
- `opencode-for-copilot.showDiagnostics` command opens the report as an untitled markdown document (`commands.ts`)

**Test:** Manual (command opens the report). Thin VS Code glue over a string builder — no unit test.

---

## 9. Fork Priority Ports (Round 2)

> **Status: ✅ DONE** — the four small, low-risk candidates from the Appendix.

### #2 Deprecated model filtering

- `models.dev` entries carrying `deprecated: true` are marked on the merged `ModelDefinition` (`models-dev.ts`)
- Deprecated models are hidden from the picker (`isUserSelectable: false`) and show a warning icon + "Deprecated by the provider" note when already in a chat (`models.ts`); existing chats keep working
- Custom models (user-defined) never carry the flag, so they are unaffected

### #3 Provider-prefix toggle

- New setting `glm-copilot.showProviderPrefix` (default `false`): prefixes picker names with the provider label (e.g. `Kimi · Kimi K3`) so models stay identifiable in narrow picker rows
- Family→label map lives in `models.ts` (`providerLabel()`), exported for tests

### #4 E2E mock-server retry test

- New `test/client/mock-server-retry.test.ts`: a real `node:http` server drives `GLMClient` through the actual retry phases without any API key:
  - transient 502 → backoff → success on attempt 2
  - context-overflow 400 → retry with reduced `max_tokens` (`floor(131072 × 0.1) = 13107`)
  - HTTP 500 with 10 tools → tool-halving retry with 5 tools

### #5 Reasoning-history echo (family-aware)

- Verified the local path already echoes reasoning; improved it to match the fork's intent: `shouldEchoThinkingHistory()` echoes `reasoning_content` for **DeepSeek** (required for multi-turn) and skips it for GLM/Kimi/etc. (optional per vendor docs — saves tokens)
- Unknown/custom models keep the conservative default (echo). `convert.ts` + `request.ts` pass the model ID through.

---

## Implementation Status (actual)

```
Done this session:
├── #5  Transient 5xx classification        ✅  core.ts
├── #3  Tool-schema token estimation        ✅  convert.ts + request.ts
├── #1  Context overflow auto-retry         ✅  overflow-retry.ts + core.ts (Phase 2.5)
├── #8  Runtime diagnostics command         ✅  diagnostics.ts + commands.ts
├── Round-2 #2 Deprecated model filtering   ✅  models-dev.ts + models.ts
├── Round-2 #3 Provider-prefix toggle       ✅  models.ts + config.ts
├── Round-2 #4 E2E mock-server retry test   ✅  mock-server-retry.test.ts
├── Round-2 #5 Reasoning-history echo       ✅  convert.ts + request.ts
└── #6  Usage cost tracking                 ✅  pricing/tracker.ts + status.ts
```

All changes verified: **122/122 tests passing**.

---

## Risk Mitigation

1. **Each feature is opt-in or transparent** — no behavior changes for existing users
2. **Unit tests first** — overflow-retry is a pure function, easy to test
3. **Feature flags** — context overflow retry can be gated behind a `glm-copilot.resilientRetry` setting
4. **Logging** — all new retry paths log to the existing output channel for diagnostics

> **Post-implementation note:** overflow-retry and 5xx classification are transparent (no new setting added); they only trigger on errors that previously surfaced as hard failures. If a regression appears, the retry paths are the first place to look (`core.ts` Phases 1 / 2.5).

---

## Files Changed (final)

| File | Action | Feature | Status |
|------|--------|---------|--------|
| `src/client/error/overflow-retry.ts` | **Create** | #1 | ✅ |
| `src/client/core.ts` | Modify (retry phases) | #1, #5 | ✅ |
| `src/provider/convert.ts` | Modify (tool weight in `countMessageChars`) | #3 | ✅ |
| `src/provider/request.ts` | Modify (pass `tools`) | #3 | ✅ |
| `test/client/overflow-retry.test.ts` | **Create** | #1 | ✅ |
| `test/provider/convert.test.ts` | Modify (tools-weight case) | #3 | ✅ |
| `src/runtime/diagnostics.ts` | Modify (report builder) | #8 | ✅ |
| `src/runtime/commands.ts` | Modify (`showDiagnostics` command) | #8 | ✅ |
| `src/types.ts` | Modify (`deprecated` flag) | R2-#2 | ✅ |
| `src/provider/models-dev.ts` | Modify (deprecated merge) | R2-#2 | ✅ |
| `src/provider/models.ts` | Modify (picker filter + prefix) | R2-#2/#3 | ✅ |
| `src/config.ts` | Modify (`showProviderPrefix` getter) | R2-#3 | ✅ |
| `src/provider/convert.ts` | Modify (`shouldEchoThinkingHistory`) | R2-#5 | ✅ |
| `src/provider/request.ts` | Modify (pass model ID) | R2-#5 | ✅ |
| `test/client/mock-server-retry.test.ts` | New (E2E retry phases) | R2-#4 | ✅ |
| `src/provider/pricing/tracker.ts` | **Create** (day/month cost tracker) | #6 | ✅ |
| `src/provider/pricing/status.ts` | Modify (today/month totals) | #6 | ✅ |
| `src/provider/index.ts` | Modify (inject `globalState` store) | #6 | ✅ |
| `test/provider/pricing/tracker.test.ts` | **Create** | #6 | ✅ |
| `src/client/error/index.ts` | re-export | #1 | Not needed (direct import) |
| `src/provider/tokens.ts` | tool estimation | #3 | Not changed (revised) |

## What Remains

**Nothing remains.** Every roadmap item — #1, #3, #5, #6, #8, and Round-2 #2–#5 — is implemented and verified. #6 was built as the standalone tracker recommended in section 6 (no SQLite, no OpenCode billing tiers).

---

*Generated from deep source analysis of ltmoerdani/opencode-copilot-chat (15+ files, ~5000 LOC)*

---

## Appendix: Fork Feature Comparison (2026-08-12)

Re-checked against the fork's current `main` (138 source files, v0.5.2 era).

### Feature matrix

| Fork feature | Local status | Verdict |
|---|---|---|
| Vision image input | ✅ has (`src/provider/vision/`) | parity |
| Per-model thinking controls | ✅ has (thinking-effort schema) | parity |
| Go usage tracker / status bar | ✅ done (#6 — standalone `globalState` tracker) | standalone |
| Usage webview panel (SVG dashboard) | ❌ missing | medium port |
| Manual usage targets + live pricing | ❌ missing | medium port |
| Session-level cost tracking | ❌ missing | medium port |
| Model validation + 400/5xx retry | ✅ has (#1, #5) | ported |
| Live model list fetching | ✅ has — Go+Zen + models.dev + auto-defaults (section 7) | parity, exceeds |
| Vision proxy for text-only models | ✅ has | parity |
| Image normalization | ⚠️ partial (image→text; no size guard) | low port |
| Model picker enhancements (prefix toggle, context selector) | ❌ missing | low port |
| Deprecated/unavailable model filtering | ❌ missing | low port |
| Runtime diagnostics command | ✅ has (#8) | ported |
| Reasoning-history echo (DeepSeek V4) | ❓ unverified | needs check |
| MCP tool-result image support | ⚠️ partial | medium port |

### Fork pros

- Docs discipline: 14 feature docs + 60 issue writeups with PR/issue links and release tags
- `CONTRIBUTING.md` with explicit AI-agent automation rules ("never push without permission")
- Clean pure helpers (`metadata.ts`, `thinking.ts`, `usage.ts`) unit-tested without `vscode`
- Validation scripts reusing production logic (`validate-models`, `test-retry-e2e`)

### Fork cons

- `extension.ts` is a 4531-line monolith
- No CI workflow — relies on local husky/lint-staged
- npm + native `@silvia-odwyer/photon-node` dep vs our pnpm + zero runtime deps
- 60 issue docs is a maintenance tax (process notes, not user docs)

### Local advantages

- pnpm + vite-plus + vitest; CI in `.github/workflows/ci.yml`; 108 passing tests
- Modular `src/client|provider|runtime` split vs the fork monolith
- Richer error taxonomy (`serverMessage`, network classification)
- Multi-agent pipeline chat participant — the fork has nothing equivalent

### Ranked port candidates (lazy-senior bar)

1. ✅ Runtime diagnostics command — done (#8)
2. ✅ Deprecated/unavailable model filtering — done (Round-2 #2)
3. ✅ Provider-prefix toggle (`showProviderPrefix`) — done (Round-2 #3)
4. ✅ E2E mock-server retry test — done (Round-2 #4)
5. ✅ Reasoning-history echo check — done (Round-2 #5: DeepSeek-only echo)
