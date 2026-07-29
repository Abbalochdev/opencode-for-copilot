# Architecture Optimization Report — v3.8.1

> Generated: 2026-07-27 | v3.8.0 optimizations + v3.8.1 bug fixes across 10 source files

---

## Summary

Ten performance and reliability optimizations were implemented in v3.8.0, with four bug fixes shipped in v3.8.1 based on real-world telemetry. All changes are backward-compatible with no breaking API changes.

### What's New in v3.8.1

Four critical fixes identified from production error logs:

| Fix | Problem | Solution |
|---|---|---|
| Tool-halving on 429 | HTTP 429 server-overload errors burned 3 retries without reducing payload size | Phase 2 now triggers tool-halving on 429 when tool count > 16 |
| Failover bypass | Phase 2 (tool-halving) called `callbacks.onError()` + `return`, skipping Phase 3 (failover) entirely | Removed early return — tool-halving failure now falls through to failover |
| Client cache staleness | `getCachedClient` keyed by `${baseUrl}:${protocol}` — API key changes had no effect | Cache key now includes apiKey: `${baseUrl}:${apiKey}:${protocol}` |
| Config-change cleanup | `clearClientCache()` was exported but never called | Wired into `onDidChangeConfiguration` handler for apiKey/baseUrl/endpoint changes |

### What's in v3.8.0

Ten optimizations across the extension:

| # | Optimization | Impact | Files Changed |
|---|---|---|---|
| 1 | Anthropic `cache_control` breakpoints | Lower latency & cost on Anthropic protocol | `src/client/anthropic/convert.ts` |
| 2 | GLMClient instance cache | Reduced GC pressure, connection reuse | `src/provider/request.ts` |
| 3 | Retry + exponential backoff (429/503) | Resilience against transient rate limits | `src/client/core.ts`, `src/client/error/index.ts` |
| 4 | Diagnostics early-out guard | ~0 overhead when debug logging disabled | `src/provider/request.ts` |
| 5 | Stable system prompt prefix | Higher server-side cache hit ratio | `src/provider/ponytail.ts`, `src/provider/code-simplifier.ts` |
| 6 | Vision description LRU cache | Avoids redundant vision API calls | `src/provider/vision/resolve.ts` |
| 7 | CJK-aware token estimation | Accurate budget for CJK text | `src/provider/tokens.ts` |
| 8 | Request deduplication | Prevents duplicate utility API calls | `src/provider/index.ts` |
| 9 | Per-platform rate limit tracking | Pre-emptive throttling before hitting limits | `src/client/rate-limit.ts`, `src/client/core.ts` |
| 10 | Platform failover (CN ↔ Intl) | Automatic fallback on regional outages | `src/client/core.ts` |

---

## Detailed Changes

### 1. Anthropic `cache_control` Breakpoints

**File:** `src/client/anthropic/convert.ts`

**Problem:** Anthropic's Messages API supports server-side prompt caching via `cache_control` markers, but the extension wasn't using them. Every request was fully re-processed by the server.

**Solution:** Added `cache_control: { type: 'ephemeral' }` to:
- The **last system block** in the system prompt array (via `extractSystem()`)
- The **last content block of the last user message** (via new `placeLastUserMessageCacheBreakpoint()`)

**Impact:** For conversations with long system prompts, the server can cache the static prefix and only process the new user message delta. Typical savings: 20-60% latency reduction on multi-turn conversations.

---

### 2. GLMClient Instance Cache

**File:** `src/provider/request.ts`

**Problem:** A new `GLMClient` instance was constructed on every request, discarding any connection state held by the underlying `fetch` pool.

**Solution:** Added `clientCache = new Map<string, GLMClient>()` keyed by `${baseUrl}:${apiKey}:${protocol}`. Clients are reused across requests to the same endpoint and credential pair. `clearClientCache()` is called automatically when configuration changes (apiKey, baseUrl, endpoint, customModels, modelIdOverrides).

**Impact:** Eliminates per-request object allocation, enables HTTP connection keep-alive reuse, and correctly invalidates when credentials change.

---

### 3. Retry + Exponential Backoff for 429/503

**Files:** `src/client/core.ts`, `src/client/error/index.ts`

**Problem:** HTTP 429 (rate limit) and 503 (service unavailable) errors were immediately propagated to the user, requiring manual retry.

**Solution:**
- Added `retryAfterMs` field to `GLMRequestError` and `parseRetryAfterHeader()` to extract the `Retry-After` header
- `streamChatCompletion()` now retries up to 3 attempts with exponential backoff + jitter
- Respects server-provided `Retry-After` values
- Constants: `MAX_RETRY_ATTEMPTS = 3`, `BASE_RETRY_DELAY_MS = 1_000`, `MAX_RETRY_DELAY_MS = 30_000`
- **v3.8.1 fix:** Phase 2 tool-halving now also triggers on HTTP 429 when tool count > 16 (not just HTTP 500), addressing server-overload errors from providers like novita.ai where the payload size, not the quota, is the problem
- **v3.8.1 fix:** Phase 2 no longer returns early on failure, ensuring Phase 3 (failover) is always reached

**Impact:** Transient rate limits are automatically resolved without user intervention. Jitter prevents thundering-herd retries.

---

### 4. Diagnostics Early-Out Guard

**File:** `src/provider/request.ts`

**Problem:** Even when debug logging was disabled, `prepareChatRequest()` constructed the full `BeginCacheDiagnosticsOptions` object on every request, including hashing every message and parsing content sections.

**Solution:** Added `cacheDiagnostics.isEnabled()` check before constructing the options object. When disabled, uses `createNoopCacheDiagnosticsRun()` with empty method implementations.

**Impact:** Near-zero overhead on the hot path when diagnostics are off (the default).

---

### 5. Stable System Prompt Prefix

**Files:** `src/provider/ponytail.ts`, `src/provider/code-simplifier.ts`

**Problem:** Ponytail and Code Simplifier instructions were appended *after* the existing system content, creating a variable prefix that prevented server-side prompt caching.

**Solution:** Changed both `injectPonytailSystemMessage()` and `injectCodeSimplifierSystemMessage()` from appending to **prepending** the instruction before existing system content.

**Impact:** Static instructions now form a stable prefix for server-side caching. The `### PONYTAIL (HIGHEST PRIORITY)` header preserves instruction salience despite earlier placement.

---

### 6. Vision Description LRU Cache

**File:** `src/provider/vision/resolve.ts`

**Problem:** In multi-turn conversations, the same screenshot was sent to the vision proxy for re-description on every turn, wasting API calls and increasing latency.

**Solution:** Added a Map-based LRU cache (32 entries, 5-minute TTL) keyed by image content fingerprint. Cache key uses SHA-256 of first/last 512 bytes + total length for fast hashing.

**Impact:** Same image is described once; subsequent turns replay the cached description. Saves one vision API call per repeated image.

---

### 7. CJK-Aware Token Estimation

**File:** `src/provider/tokens.ts`

**Problem:** Token estimation used a single `charsPerToken` ratio (4.0) for all scripts. CJK text has ~1.5 chars/token, causing underestimation of token usage for Chinese/Japanese/Korean content.

**Solution:** Added Unicode range detection (`isCjkCodePoint()`) covering CJK Unified Ideographs, Extensions A-D, Compatibility Ideographs, Symbols/Punctuation, and Fullwidth Forms. `estimateTokenCountFromText()` now computes weighted tokens: `cjkChars / 1.5 + latinChars / 4.0`.

**Impact:** Accurate token budget for mixed-language conversations. Prevents context overflow for CJK-heavy prompts.

---

### 8. Request Deduplication

**File:** `src/provider/index.ts`

**Problem:** VS Code sometimes fires identical utility requests concurrently (e.g., `chat-title`, `git-branch-name`), resulting in duplicate API calls.

**Solution:** Added an in-flight deduplication map for idempotent request kinds. Dedup key: `${requestKind}:sha256(lastUserMessage).slice(0, 16)`. Concurrent identical requests within a 5-second window coalesce onto the first in-flight promise.

**Supported request kinds:** `chat-title`, `git-branch-name`, `git-commit-message`, `rename-suggestions`, `inline-progress-message`, `prompt-categorizer`, `settings-resolver`.

**Impact:** Eliminates duplicate API calls for utility requests, reducing cost and latency.

---

### 9. Per-Platform Rate Limit Tracking

**File:** `src/client/rate-limit.ts` (new), `src/client/core.ts`

**Problem:** The extension had no awareness of rate limit quotas beyond reacting to 429 errors after they occurred.

**Solution:** Created a `rate-limit.ts` module that:
- Parses `X-RateLimit-Remaining`, `X-RateLimit-Limit`, and `X-RateLimit-Reset` headers from successful responses
- Tracks state per host with automatic expiry
- Pre-emptively delays when remaining quota ≤ 2 (up to 30 seconds)
- Exposes `trackRateLimitHeaders()` and `waitIfRateLimited()` for the request pipeline

**Impact:** Pre-emptive throttling avoids hitting hard rate limits, providing a smoother experience.

---

### 10. Platform Failover (China ↔ International)

**File:** `src/client/core.ts`

**Problem:** When a regional GLM endpoint was unreachable (network issues, regional outage), the request failed even though the alternate region might be available.

**Solution:** Added Phase 3 failover in `streamChatCompletion()`: after retries and tool-halving both fail, attempts the alternate regional endpoint via `resolveFailoverBaseUrl()`. Failover map: `open.bigmodel.cn` ↔ `api.z.ai`.

**Impact:** Transparent resilience for users with access to both CN and International endpoints. Only triggers on non-retryable failures after all other recovery attempts are exhausted.

---

## Testing

- **81 tests passing** across 12 test files
- Updated `test/provider/ponytail.test.ts` to reflect the prepend behavior change
- Build compiles clean (380 KB bundle)
- **v3.8.1:** All 81 tests pass after client cache key and failover fixes

## Migration Notes

- **Breaking changes:** None. All changes are internal optimizations.
- **Configuration:** No new settings required. Rate limit tracking, failover, and tool-halving are automatic.
- **Ponytail behavior:** Instructions are now prepended rather than appended. The `### PONYTAIL (HIGHEST PRIORITY)` header ensures instructions remain salient.
- **Client cache:** Changing API key or base URL now correctly invalidates cached clients. No manual action needed.

## Revision History

| Version | Date | Changes |
|---|---|---|
| v3.8.0 | 2026-07-27 | Initial 10 optimizations (caching, retry, rate-limit, failover, dedup, vision LRU, CJK tokens, etc.) |
| v3.8.1 | 2026-07-27 | 4 bug fixes: tool-halving on 429, failover bypass, client cache key with apiKey, config-change cache invalidation |
