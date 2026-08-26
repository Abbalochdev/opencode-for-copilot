# PR #6 Integration — Reviewer Report

**Date:** 2026-08-26
**Base:** `origin/main` @ `35f63ed` (in sync, 0 behind/ahead; nothing pushed)
**Goal:** Integrate PR #6 (wylasdasd) — "remove redundant GLM code, fix settings display error" — onto current `main`, rebranding to OpenCode without reintroducing old/deleted structure.
**Method:** PR #6 branched from an OLD `main` (pre-`ae70b4c`, where `usage.ts` was deleted and config/endpoint refactored). A literal merge was abandoned. Changes were applied as a clean, manually-reviewed set.

---

## Verdict

**APPROVE WITH NOTES** — All applied changes build clean and pass the full suite (237 tests, 28 files). One intentional behavioral nuance and a few cosmetic items are documented below. `resolvePinnedEndpoint` was **excluded** per decision.

---

## Change inventory (15 files)

| File | Change | Reviewer note |
|---|---|---|
| `src/consts.ts` | `EXTERNAL_URLS.glm` → `opencode` (drops topUp/codingPlan/fairUsePolicy) | Surgical only; full PR version rejected (imported deleted `getOverlayModels`). |
| `src/client/consts.ts` | GLM→opencode URLs; error deep-links removed | Rebrand. |
| `src/client/error/index.ts` | `isOfficialGLMBaseUrl`→`isOpencodeBaseUrl`, `'glm'`→`'opencode'` | Rebrand. Error *format* helpers (`GLM_BUSINESS_ERROR_CODES`, `formatGlmBusinessMessage`) intentionally kept — the API returns GLM-format errors. |
| `src/client/types.ts` | rebrand | — |
| `src/types.ts` | Removed dead `ApiMode`/`ApiRegion` + china/international preset values | No usages remained in main. **Cosmetic fix applied:** header comment "GLM Copilot"→"OpenCode for Copilot". |
| `src/provider/pricing/currency.ts` | Removed `identifyOfficialGLMPlatform` import/usage | Real cleanup. See behavioral note ⚠️ below. |
| `src/provider/vision/consts.ts` | `DEFAULT_GLM_VISION_MODEL_ID`→`DEFAULT_OPENCODE_VISION_MODEL_ID` (old kept as `@deprecated` alias) | Safe. |
| `src/provider/vision/service.ts` | Rebrand + `getApiKeyForEndpoint(config.url)` (was `getApiKey()`) + robust `resolveOpenCodeVisionBaseUrl()` | **Improvement:** multi-key aware; respects `baseUrlOverride` and Anthropic presets. |
| `src/provider/routing/classifier.ts` | Added `resolveRequestMaxTokens()` (caps "none-thinking" helper requests at 512) | Pure, tested logic. |
| `src/provider/routing/index.ts` | Exported `resolveRequestMaxTokens` | — |
| `src/provider/request.ts` | Import + wire `resolveRequestMaxTokens(requestKind, getMaxTokens())` at line 127 | `requestKind` in scope (compile-verified). Routing logic now lives in one place (`config.ts` + this wire). |
| `src/runtime/diagnostics.ts` | Added `- OpenCode plan: ${getOpencodePlan()}` | Uses existing `config.getOpencodePlan`. |
| `test/client/error.test.ts` | Updated to rebranded error handling | Matches applied code. |
| `package.nls.json` | Rebrand + unified `command.setApiKey` (split `setGoApiKey`/`setZenApiKey` removed) + added EN `config.opencodePlan.description` | All 76 `%key%` references resolve (0 missing). |
| `package.nls.zh-cn.json` | Same rebrand + unified setApiKey, fixed plan-description links | — |

---

## Behavioral notes (intentional, flagged)

⚠️ **`currency.ts` now returns `undefined` for manual Zhipu (`bigmodel.cn`) base URLs** (previously `CNY`). OpenCode base URLs still return `USD`. Rationale: the model picker is OpenCode-focused; non-OpenCode hosts no longer get a currency hint. If Zhipu CNY pricing display is still desired for self-hosted BigModel endpoints, this needs a follow-up.

✅ **`vision/service.ts` now uses `authManager.getApiKeyForEndpoint(url)`** instead of the single `getApiKey()`. This is correct for the dual-key system (PR #3) and resolves the right secret per endpoint. Confirmed `getApiKeyForEndpoint` exists and compiles.

---

## Excluded (by design — NOT applied)

| File | Reason |
|---|---|
| `src/config.ts` | PR #6 re-adds `getOpencodePlan`/`hasExplicitLegacyApiProtocol`/`normalizeLegacyEndpointPreset` + legacy `apiProtocol` plan migration — all removed in main's refactor. |
| `src/endpoint.ts` | PR #6 re-adds `LEGACY_ENDPOINT_PRESETS` (china-*/international-* → opencode) — dead shim for presets the UI no longer offers. |
| `src/provider/usage.ts` | **Deleted in main** (`ae70b4c`); PR #6 still contains it. |
| `src/provider/request.ts` (PR #6 version) | Couples to rejected config/endpoint; conflicts with main's `request.ts`. Only the `resolveRequestMaxTokens` wiring was taken. |
| `src/provider/index.ts` | Removes `usage` imports — main already did; diff is against deleted `usage.ts`, so applying conflicts. |
| `src/client/core.ts` | Only meaningful delta is **failover removal** (behavioral) — excluded per instruction. |
| `resolvePinnedEndpoint` / `getOpencodePlan` in `request.ts` | PR #6 re-pins utility models to the active plan at request time. Main already routes utility models via `config.ts:64` (`resolvePlanDefaultEndpoint(getOpencodePlan())`). Edge-case billing nuance; **excluded** — confirmed absent from working tree. |
| Legacy tests (`config.test.ts`, `endpoint.test.ts`, `commands.test.ts`) | Assert PR #6's legacy behavior; not imported (would fail against main). |

---

## Residual references to "GLM/BigModel/Z.ai" (verified intentional — NOT branding of our extension)

- `src/consts.ts:44-48` — `API_KEY_SECRET = 'glm-copilot.apiKey'` (+ `.go`/`.zen`). **Secret storage keys — MUST NOT change** or existing users lose stored keys (preserved from PR #3).
- `src/endpoint.ts` — `GLM_CN_API_HOST`, `GLM_INTERNATIONAL_API_HOST`, `OfficialGLMPlatform 'zhipu'|'zai'`. Recognizes **manual `baseUrl` overrides** to BigModel/Z.ai hosts (backward-compat feature, not our branding). Kept.
- `src/i18n.ts` — GLM business error-code doc references (`docs.bigmodel.cn`). Technical reference for error-format mapping; kept.
- `src/client/consts.ts:32` — error-code doc URL comment. Reference only; kept.

---

## Validation performed

- `pnpm run compile` → **Build complete** (no `MISSING_EXPORT` / type errors).
- `pnpm run test` → **237 passed / 28 files** (post all edits, incl. `types.ts` comment fix).
- `git grep resolvePinnedEndpoint` → **0 matches** (exclusion confirmed).
- `Select-String getOpencodePlan` in `request.ts` → **0 matches** (exclusion confirmed).
- nls key resolution → **76 referenced, 0 missing** (unified `setApiKey` retained; split keys removed with no dangling `package.json` references).

---

## Remaining manual decisions (not blocking)

1. **Version bump + CHANGELOG** — pending (main currently `3.11.12`; the earlier "3.11.1" was a stale release-commit message + zero git tags).
2. **`currency.ts` Zhipu CNY** — decide whether self-hosted BigModel endpoints still need a currency hint.

Nothing committed or pushed.
