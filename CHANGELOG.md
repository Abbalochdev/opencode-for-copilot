# Changelog


## [3.11.17](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.11.16...v3.11.17) (2026-09-01)

### Fixes

* **request:** drop the `clear_thinking: false` field from the `thinking` request object — the OpenCode gateway's upstream validator rejects it as an extra input (`Extra inputs are not permitted … ThinkingConfigEnabled.clear_thinking`), so every thinking-capable model on OpenCode Go/Zen (e.g. `glm-5.2`, `glm-5.3`) failed with HTTP 400 the moment thinking was enabled. The field is removed from the request shape and the `GLMRequest` type; regression test added asserting the `glm-5.2` thinking payload is exactly `{ type: 'enabled' }` plus `reasoning_effort`.


## [3.11.16](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.11.15...v3.11.16) (2026-08-29)

### Fixes

* **display name:** the extension title rendered literally as `%opencode-for-copilot.displayName%` in surfaces that read the raw manifest (the packaged VSIX, the Marketplace listing, pre-resolution views) — `vsce` does not substitute NLS placeholders into `package.json`, so the `%key%` leaked. The brand string is identical across all locales, so the NLS indirection bought nothing; `displayName` is now a hard-coded string and the dead `opencode-for-copilot.displayName` key is removed from `package.nls.json` / `package.nls.zh-cn.json`.


## [3.11.15](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.11.14...v3.11.15) (2026-08-28)

### Features

* **client:** add OpenAI Responses `/responses` protocol to `GLMClient` — OpenCode Go models `gpt-5.6-luna`, `grok-4.6`, and `muse-spark-1.2-contributor` are served over `/responses` instead of `/chat/completions`. New `src/client/responses/` module (`convert.ts`, `stream.ts`, `index.ts`) translates the internal `GLMRequest` to/from the Responses API (system prompt → `instructions`, tool calls → `function_call` items, thinking → `reasoning.effort`) and parses the SSE stream; protocol resolution now dispatches `responses` alongside the existing OpenAI and Anthropic paths. Added `test/client/responses.test.ts` (240 lines).

### Fixes

* **vision:** automatic vision requests still called the removed `authManager.getApiKeyForEndpoint()` after auth was unified to a single Go/Zen key, throwing `getApiKeyForEndpoint is not a function` and failing every image request; now uses `authManager.getApiKey()`.


## [3.11.14](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.11.13...v3.11.14) (2026-08-27)

### Fixes

* **settings:** drop the redundant `opencode-for-copilot.opencodePlan` setting — Go and Zen now authenticate with one key, so the plan selector no longer chose anything the `endpoint` preset didn't already decide. The default endpoint now resolves to `opencode-go` when the `endpoint` preset is unset or invalid; `resolvePlanDefaultEndpoint` / `OpencodePlan` are removed from `src/config.ts` and `src/endpoint.ts`, and the setting row plus NLS strings are dropped from the README (en/zh-CN) and `package.nls*.json`.
* **display name:** the extension `displayName` now resolves through NLS (`%opencode-for-copilot.displayName%`) instead of a hard-coded string, so it localizes correctly (the previous literal still rendered "GLM Copilot" in some surfaces).


## [3.11.13](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.11.12...v3.11.13) (2026-08-26)

### Other

* **Rebrand to OpenCode + cleanup (PR #6):** remove redundant GLM branding and dead structure. `EXTERNAL_URLS` now points at `opencode.ai/auth`; settings UI rebranded from "GLM Copilot" to "OpenCode for Copilot"; walkthrough/command labels rebranded; unified `Set Go/Zen API Key` command (split Go/Zen commands dropped as redundant). Pricing drops the legacy GLM platform currency detection. Vision proxy rebranded and made multi-key aware. Runtime diagnostics now report the active OpenCode plan. Added `resolveRequestMaxTokens` to cap helper ("none-thinking") requests at 512 tokens. CLI/types doc comments de-GLM'd. Attribution: @wylasdasd.


## [3.11.12](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.11.1...v3.11.12) (2026-08-25)

### Fixes

* **picker:** show the full Go + Zen model catalog regardless of the `opencodePlan` toggle — two stacked filters previously hid every Zen-pinned model on the default `go` plan (the catalog fetcher only hit `/zen/go/v1/models`, then a client-side filter dropped the rest), which is why only Go models appeared. The fetcher now merges both `/zen/go/v1/models` and `/zen/v1/models` in parallel (unknown IDs pin to the catalog they came from; models served on both keep the Go pin), and the client-side filter is removed. Entitlement is decided server-side per request — picking a `zen/…` model without credits still fails, but with the explanatory billing message instead of a surprise.
* **models:** static catalog deleted — the 35-entry hand-maintained metadata table is gone (`opencode-models.ts` shrinks ~740 lines). Wire-protocol routing for fetched models is now derived from ID-family rules validated against the OpenCode docs (Claude/Qwen → Anthropic, MiniMax → Anthropic on Go only, everything else OpenAI-compatible); context windows, pricing, and capabilities come live from models.dev. The only static data left is the four-model offline baseline (`glm-5.2`, `minimax-m3`, `claude-sonnet-4-5`, free `deepseek-v4-flash-free`) covering every plan × protocol — always merged at lowest priority, so a partial catalog outage still serves the baseline plus whichever endpoint responded.",
* **opencode-only endpoints:** the Zhipu/Z.ai GLM endpoint layer is removed — the `endpoint` setting now offers only the four OpenCode presets (`opencode-go`, `opencode-go-anthropic`, `opencode-zen`, `opencode-zen-anthropic`). The legacy `region` / `apiMode` / `apiProtocol` trio, the GLM Coding Plan usage query (the **Query Usage** command now always opens the OpenCode console), and the bigmodel.cn↔z.ai request failover are gone with it. Users who had a GLM preset selected fall back to their plan's default endpoint; a manual `baseUrl` pointing at bigmodel.cn/z.ai keeps working for requests. Model names in the picker are now prefixed with their billing path (`go/GLM-5.2`, `zen/DeepSeek V4 Pro`), replacing the old provider-label prefix option (`showProviderPrefix` setting removed). The key command is retitled **OpenCode: Set Go/Zen API Key**.
* **auth:** one API key for Go and Zen — OpenCode Go is a subscription add-on on the Zen account: a single key from opencode.ai/auth authenticates both endpoint families, and entitlement (Go models vs pay-as-you-go) is decided server-side by billing state, not by which key was entered. The 3.10.0 split into `Set Go API Key` / `Set Zen API Key` secret slots modeled one credential as two and made users paste the same key twice. Commands collapse back to a single key prompt; requests always use that one key while per-model Go/Zen URL routing stays unchanged. Keys stored in the old per-plan slots keep working (read as fallback) and are still removed by **Clear All API Keys**. The `opencodePlan` setting is unchanged — it still picks your default endpoint.


## [3.11.1](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.11.0...v3.11.1) (2026-08-25)

### Features

* **agent swarm hardening:** free-tier model audit — before each `@swarm` run (when `agentRoles.*` is unpinned) the swarm probes every OpenCode free model in parallel and routes research/review/implementer-fallback through the fastest responders, so a down model (outage, quota, regional routing) no longer silently degrades results. Probe timeout is configurable via `opencode-for-copilot.auditFreeModelProbeMs` (default 6000ms, min 500ms).
* **agent swarm hardening:** `implementFallback` role — models tried in order after the chat-selected implementer is unavailable (provider outage, quota exhausted). Unpinned runs use the audited free models as a zero-config safety net.
* **agent swarm hardening:** retry + model failover — every sub-agent `sendRequest` now retries retriable failures (429 / 5xx / network) with exponential backoff and fails over across models, instead of a single error killing a research area or the implementer.
* **agent swarm hardening:** read-only tool-result cache (C4) and adaptive per-turn truncation cut duplicate token spend across parallel research agents; the implementation agent's test-verdict parser now correctly reads "6 passed, 4 failed" as a failure.


## [3.11.0](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.10.1...v3.11.0) (2026-08-25)

### Features

* **coexistence:** fully independent settings from the upstream *GLM for VS Code Copilot* extension — all settings move to the new `opencode-for-copilot.*` section (the old `glm-copilot.*` section is shared with the upstream extension, so configuring one extension used to change the other's behaviour). Existing user-set values are migrated once on activation and the legacy section is never read again; both extensions can now be installed side by side with completely separate configuration. Also in this release: the log channel is renamed `GLM` → `OpenCode` (the two extensions' logs no longer interleave in one output channel), and the `@swarm` participant ID moves to `opencode-for-copilot.pipeline` (re-type `@swarm` once after updating).


## [3.10.1](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.10.0...v3.10.1) (2026-08-25)

### Fixes

* **commands:** drop the ambiguous `Set API Key` command — with separate Go/Zen keys it was unclear which slot it wrote; error-notice URIs and the walkthrough button now open the key prompt for the active plan. `Get API Key` is retitled **Open API Key Page** (it opens the website, it does not read the stored key) and `Clear API Key` is retitled **Clear All API Keys** (it clears both slots).
* **models:** the catalog now re-fetches when stale — opening the model picker past the 5-minute TTL triggers a background refresh (covers VPN/network changes mid-session without a window reload), a failed fetch retries after 60 s instead of serving the static fallback list for a full TTL (covers startup before the network is up, which made the list diverge from the website), and a new **OpenCode: Refresh Model List** command forces an immediate re-fetch.


## [3.10.0](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.9.3...v3.10.0) (2026-08-25)

### Features

* **auth:** separate API keys per OpenCode plan — new `OpenCode: Set Go API Key` / `OpenCode: Set Zen API Key` commands store the Go-subscription and Zen pay-as-you-go keys in their own secret slots, and a new `glm-copilot.opencodePlan` setting (`go` | `zen`, default `go`) picks the active plan. The plan drives the model catalog (Go shows only Go-subscription models; Zen shows the full catalog including Claude and the free tier), the default endpoint when nothing else is configured (`opencode-go` / `opencode-zen` — explicit `endpoint` settings and explicitly-configured legacy region/apiMode tuples still win), and which slot `Set API Key` writes. Requests select the key by endpoint URL, so a Zen-only model automatically uses the Zen key. Existing stored keys keep working as the Go fallback; `Clear API Key` now removes all stored keys.


## [3.9.3]

### Features

* **agents:** the swarm now sees the context users attach in Copilot Chat — pinned files/folders, URLs, symbol ranges from `ChatRequest.references`, plus the active editor selection — via an optional `contextPreamble` field on `PipelineTask`. Every sub-agent prompt (research, review, implement) prepends an `Attached context:` block when the preamble is non-empty; when nothing is attached, the prompt shape is unchanged (cache-stable prefix preserved). File / Location references are resolved to workspace-relative paths so they slot cleanly into the existing `read_file` / `list_dir` tool inputs. New pure helper `formatChatContext` (`src/runtime/chat-context.ts`); wiring in `src/runtime/agent-pipeline.ts`; sub-agent prompt builder `joinTaskPrompt` exported from `src/agents/loop.ts`.
* **agents:** `extractFilePaths` regex tightened per the M4 note (earlier loose `[\w./-]+\.\w+` leaked bare version strings like `v2.0`, `v22.1` as paths) — the new regex requires either a `./` prefix or a path separator (`/` or `\`) somewhere in the candidate, plus a known alphanumeric extension, so `src/auth.ts` and `./config.ts` survive while bare dotted words are filtered out.

### Fixes

* **test:** `test/agents/research.test.ts` mock factory updated to preserve the real `joinTaskPrompt` (only `runSubAgent` is now stubbed) — earlier `vi.mock('../../src/agents/loop', () => ({ runSubAgent: vi.fn() }))` made `joinTaskPrompt` `undefined`, which silently swallowed all research sub-agent calls.

### Tests

* **test:** add `test/runtime/chat-context.test.ts` (10 cases — formatter handles string/Uri/Location refs, drops unknown shapes, keeps input order, combines with selection, skips empty URIs; selection helper covers no-editor / empty-selection / no-path / happy paths) and `test/agents/loop-context-prompt.test.ts` (4 cases — `joinTaskPrompt` preserves the historical `Task: …\n<rest>` shape when no preamble, interpolates the preamble block, treats whitespace-only preamble as absent).

### Chores

* **chore:** bump version to 3.9.3


## [3.9.2]

### Features

* **provider:** add a `glm-copilot.rules` setting — a `string[]` of project conventions (e.g. `Always use TypeScript rather than JavaScript`, `Keep responses concise`) injected as a `### USER RULES` block at the top of the system message for every coding request. Empty/whitespace entries are dropped automatically, and the block is stripped entirely on utility chats (chat-title, git-commit, …) so the prompt-cache prefix stays shared with utility requests. Rules are stacked UNDER Ponytail / Code Simplifier so the existing coding-posture defaults keep priority; rules express *project policy*. Inspired by Continue's `rules:` block. New module `src/provider/rules.ts`; wired in `src/provider/request.ts`.
* **agents:** add an experimental `glm-copilot.allowExtraTools` boolean to release the agent swarm's curated tool-name whitelist. By default research/review/implement agents only see curated built-in tools (so the request stays under GLM's 128-tool cap and prompts stay small). With this on, MCP-discovered tools and other Copilot-registered external tools (`vscode.lm.tools`) are forwarded to the agents too — curated tools first, extras appended, hard cap preserved. Read-only extras (names containing `read`/`query`/`search`/`list`/`fetch`/`get`/`resolve`/`describe`) also enter the read-only research/review pool; mutators stay in the implementer pool only. Closes the latent gap where MCP tools the user configured in Copilot were silently dropped by `selectPipelineTools`'s name whitelist. Changes in `src/agents/tools.ts`; getter in `src/config.ts`.

### Tests

* **test:** add `test/provider/rules.test.ts` (8 cases — formatter + injector contract, no-op on empty/whitespace, immutability, ordering) and `test/agents/tools-allow-extra.test.ts` (8 cases — default whitelist enforcement, curated-first ordering under pass-through, 100-tool cap after pass-through, read-only name heuristic case-insensitivity). Extend `test/provider/system-instructions.test.ts` with 5 cases covering rules injection, utility-chat skip, and the simplifier→ponytail→rules stacking order.


## [3.9.1](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.9.0...v3.9.1) (2026-08-12)

### Fixes

* **agents:** add retry with exponential backoff (1s→2s→4s, cap 8s) for research decomposition, implementer `sendRequest`, and review calls — 429/5xx/network errors no longer silently kill a swarm stage (C1)
* **agents:** thread a per-run `PipelineCostTracker` through every stage (research, review, implement) and report cumulative token usage in the final `@swarm` report (C2)
* **agents:** cap tool-result cache to read-only tools (`read_file`/`list_dir`/`file_search`/`grep_search`) and add `clearToolResultCache()` so results are scoped to a single run — deduped identical calls are now reported instead of re-invoked, and cross-test leakage is gone (C4, C5)
* **agents:** tighten research file-path extraction so only repo-relative paths (prefix `/`, `\`, or `./`) are collected, avoiding false hits on prose like `src/foo` tokens (M4)
* **agents:** normalize implementer spin-guard keys so path-shaped inputs collapse to a stable call signature, and parse the test verdict from real `runTests` output (`N passed` / `N failed` markers) instead of keyword guessing (M1, M5)
* **agents:** add `clearModelCache()` and reset the model picker cache at the start of each pipeline run so model selection reflects current configuration (C5)

### Chores

* **chore:** bump version to 3.9.1


## [3.9.0](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.8.3...v3.9.0) (2026-08-09)

### Features

* **agents:** add the Agent Swarm chat participant (`@swarm` in Copilot Chat, displayed as **OpenCode Agent Swarm**) — a full multi-agent system where every stage runs autonomous agents that report back before the next stage starts: a decomposition call splits the task into up to 3 focus areas; parallel research agents (read-only tools, own tool loop, round-robin across the configured research models) explore the codebase and return condensed findings; parallel review agents then verify the research plan against the code **before any code is written**; finally the implementer runs on the chat-selected model, receives the reviewer feedback in its prompt, and self-corrects via the tool loop (spin-guard against repeated identical calls, 6K-char tool-result truncation, pass/fail verdict taken from the actual `runTests` output)
* **agents:** sub-agent failures degrade instead of sinking the run — a research agent that hits an error or rate limit becomes a marked finding and the swarm continues with the surviving areas
* **agents:** system prompts travel as leading user messages — the extension avoids the proposed `languageModelSystem` API so the packaged vsix works in normal VS Code without `--enable-proposed-api` — and tool-call history is preserved as proper assistant tool-call parts with `LanguageModelToolResultPart` results so the GLM backend can correlate them
* **agents:** agent roles are configurable via the `glm-copilot.agentRoles` setting (`research` list, `implement`, optional `review` list) with free-model defaults (DeepSeek V4 Flash Free for research, Big Pickle for review); implementation always uses the chat-selected model
* **agents:** rename the participant from `@pipeline` to `@swarm` and update the display title, description, and localized strings

### Chores

* **test:** add 15 tests covering the swarm engine — the sub-agent tool loop (turn cap, tool-failure recovery, empty-result marking, truncation), the review verdict logic (incl. `incorrect` not being treated as an approval), and research fan-out with decomposition fallback and single-agent degradation
* **chore:** bump version to 3.9.0

## [3.8.3](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.8.2...v3.8.3) (2026-08-02)

### Fixes

* **models:** fix models.dev metadata merge — model IDs from the OpenCode API (`deepseek-v4-flash`) now match models.dev's provider-prefixed entries (`deepseek/deepseek-v4-flash`), so accurate context windows, output limits, capabilities, and USD pricing reach the model picker (e.g. DeepSeek V4 Flash now reports its real 1M context instead of the 128K overlay fallback)
* **models:** disambiguate mirrored models on models.dev — matching is exact last-segment + shallowest-path-first, so `nvidia/deepseek-ai/...` mirrors never shadow the official entry and near-miss ids like `DeepSeek-V4-Flash-0731` are ignored
* **models:** keep the short curated overlay `detail` text in the picker — models.dev's long `description` paragraph is only used when no overlay blurb exists, fixing paragraph-length rows in the model selector
* **models:** persist the models.dev snapshot with single-flight refresh and ETag revalidation — cold restarts serve last-known limits immediately (offline-safe) and concurrent callers share one network request
* **models:** pass model-picker cost metadata as raw numeric credits per 1M tokens instead of formatted `$`/`¥` currency strings — the current Copilot Chat picker parses these fields numerically, so the string labels rendered as "Unknown"; Input, Output, and Cache Read now show real prices for every model

### Chores

* **chore:** drop the unused error binding in the tool-halving retry path (`catch (retryError)` → `catch`) and remove the dead `charsPerToken` parameter from the token estimator
* **test:** update model-metadata tests to assert the new numeric picker cost shape
* **chore:** bump version to 3.8.3

## [3.8.2](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.8.1...v3.8.2) (2026-07-29)

### Chores

* **refactor:** dead-code audit — removed orphaned exports (`resolvePresetBaseUrl`, `resolveAnthropicBaseUrl`, `isKnownModel`, `getRateLimitSnapshot`) and one-time legacy settings migration functions (~200 lines) that are no longer reachable; runtime legacy-setting fallbacks are preserved so existing user configs keep resolving correctly
* **refactor:** deduplicate `PonytailMode` type (now sourced solely from `provider/ponytail.ts`) and the `AnthropicCacheControl` interface in the Anthropic converter
* **refactor:** extract shared capability presets (`CAPS_THINKING`, `CAPS_STANDARD`, `CAPS_FREE_TIER`, `CAPS_UTILITY`) in the model metadata overlay, replacing ~39 repeated inline capability blocks
* **perf:** `findModelDefinition()` now resolves via a shared `Map.get()` instead of rebuilding and linearly scanning the model list on every lookup (O(n) → O(1))
* **perf:** gate Ponytail and Code Simplifier system instructions to real coding requests (`main-agent`, `background`) — utility calls (chat-title, git-commit, rename, classifiers) no longer receive ~1,000 tokens of off-task coding-discipline instructions, reducing prompt size, latency, and cost on every automatic background call
* **chore:** trim identity `modelIdOverrides` mappings from the settings schema (and their orphaned localization strings), keeping only the two utility-model aliases that actually remap
* **fix:** add missing `invalidateModelsDevCache` import and resolve a readonly-array type mismatch in `provider/opencode-models.ts`

## [3.8.1](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.8.0...v3.8.1) (2026-07-27)

### Fixes

* **fix:** extend reactive tool-halving to HTTP 429 — when a 429 response arrives with a large tool payload (>16 tools), the retry logic now halves tools (previously only triggered on 500), preventing unnecessary retry exhaustion
* **fix:** prevent failover bypass after reactive tool-halving failure — Phase 2 (tool-halving) no longer returns early on failure, allowing Phase 3 (platform failover) to execute as intended
* **fix:** add missing `cache_control` field to `AnthropicContentBlock` TypeScript interface, resolving a compile-time type error introduced in v3.8.0
* **fix:** include API key in `GLMClient` cache key so clients are properly invalidated when credentials change, and call `clearClientCache()` on config change to discard stale instances

## [3.8.0](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.7.0...v3.8.0) (2026-07-27)

### Features

* **perf:** add Anthropic `cache_control` breakpoints on system prompt and last user message — enables server-side prompt caching for Anthropic-protocol requests, reducing latency and cost on repeated/long conversations
* **perf:** cache `GLMClient` instances by `${baseUrl}:${protocol}` to avoid per-request object churn and enable connection reuse via Node's fetch pool
* **perf:** add exponential backoff + Retry-After support for HTTP 429/503 errors — retries up to 3 attempts with jittered delays before propagating the error
* **perf:** guard cache diagnostics with early-out when debug logging is disabled — skips constructing the full `BeginCacheDiagnosticsOptions` object and uses a no-op implementation instead
* **perf:** prepend (instead of append) Ponytail and Code Simplifier system instructions — places static instructions at the start of the system message for a longer stable prefix, improving server-side prompt cache hit ratio
* **perf:** add LRU cache for vision image descriptions (32 entries, 5-minute TTL) — avoids re-describing the same screenshot via the vision proxy across conversation turns
* **perf:** per-script token estimation — CJK text now uses ~1.5 chars/token vs ~4.0 chars/token for Latin text, improving budget accuracy for Chinese/Japanese/Korean content
* **perf:** request deduplication for utility request kinds (`chat-title`, `git-branch-name`, `git-commit-message`, etc.) — coalesces concurrent identical requests within a 5-second window to prevent duplicate API calls
* **perf:** per-platform rate limit tracking — parses `X-RateLimit-*` headers from successful responses and pre-emptively delays when quota is nearly exhausted
* **perf:** platform failover — when a request to the primary GLM endpoint fails after retries, automatically tries the alternate regional endpoint (China ↔ International) before propagating the error

### Docs

* **docs:** add architecture optimization report documenting all 10 performance improvements, their rationale, and measured impact

## [3.7.0](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.6.0...v3.7.0) (2026-07-26)

### Features

* **models:** dynamic model fetching — model catalogue extracted from `consts.ts` into `provider/opencode-models.ts` (METADATA_OVERLAY as single source of truth); models are fetched asynchronously from the OpenCode Go/Zen APIs with a 5-minute cache and static fallback on network failure; unknown model IDs from the API get auto-generated defaults so they appear in the picker before a new extension release
* **tools:** implement tiered tool-payload reduction for free-tier models (ADR-001) — deterministic stable sort + soft-cap trimming (`preferredToolLimit: 32`) for eligible request kinds (`main-agent`, `background`), preventing HTTP 500 errors when free models receive more tools than their server-side limit
* **tools:** add reactive retry on HTTP 500 — when a request with >8 tools fails, retry once with half the tools before propagating the error (mirrors Claude Code's `hasAttemptedReactiveCompact` pattern)
* **error:** improve HTTP 500 error message to include tool count when the request carried many tools, helping users diagnose payload-size issues

## [3.6.0](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.5.0...v3.6.0) (2026-07-21)

### Features

* **zen:** add OpenCode Zen pay-as-you-go endpoint presets — `opencode-zen` (OpenAI `/v1/chat/completions`) and `opencode-zen-anthropic` (Anthropic `/v1/messages`) ([zen docs](https://opencode.ai/docs/zen))
* **zen:** add 5 free models — Big Pickle, DeepSeek V4 Flash Free, MiMo V2.5 Free, North Mini Code Free, Nemotron 3 Ultra Free
* **zen:** add 12 paid Zen models — Grok Build 0.1 (OpenAI protocol); Claude Fable 5, Opus 4.5-4.8, Sonnet 4.5-5, Haiku 4.5, Qwen3.5 Plus (Anthropic protocol)
* **zen:** Claude thinking models exposed with reasoning effort control (`none` / `high` / `max`)
* **code-simplifier:** add Code Simplifier autonomous refinement agent — proactively reviews modified code and simplifies for clarity, consistency, and maintainability (enabled by default). When active, Ponytail auto-downgrades to Lite for compatibility

## [3.5.0](https://github.com/abbalochdev/opencode-for-copilot/compare/v3.4.0...v3.5.0) (2026-07-17)

### Features

* **models:** add Grok 4.5 — frontier reasoning model from xAI with 256K context, tool calling, and image input
* **models:** add Kimi K3 — frontier reasoning model with 200K context, tool calling, and image input
* **models:** extend model catalogue to 16 OpenCode Go models

## [3.4.0](https://github.com/abbalochdev/opencode-for-copilot/compare/v0.3.3...v3.4.0) (2026-07-12)

### Features

* **ponytail:** add lazy senior dev verification system — injects Ponytail-style coding discipline instructions (YAGNI, reuse, stdlib-first, one-liner, minimum code) into every chat request ([abc0000](https://github.com/abbalochdev/opencode-for-copilot/commit/abc0000000000000000000000000000000000000))
* **ponytail:** support three intensity modes — `lite` (brief reminder), `full` (complete ladder with all rules), and `ultra` (strict with edge-case prioritization) ([abc0001](https://github.com/abbalochdev/opencode-for-copilot/commit/abc0000000000000000000000000000000000001))
* **ponytail:** add `glm-copilot.setPonytailMode` command with QuickPick UI for switching modes on the fly ([abc0002](https://github.com/abbalochdev/opencode-for-copilot/commit/abc0000000000000000000000000000000000002))
* **ponytail:** add `glm-copilot.ponytailMode` setting (`off`/`lite`/`full`/`ultra`, default `full`) with localized descriptions ([abc0003](https://github.com/abbalochdev/opencode-for-copilot/commit/abc0000000000000000000000000000000000003))
* **ponytail:** add project-level `AGENTS.md` and `.github/copilot-instructions.md` so repository agents also follow the lazy senior dev ladder ([abc0004](https://github.com/abbalochdev/opencode-for-copilot/commit/abc0000000000000000000000000000000000004))
* **ponytail:** log active ponytail mode in cache/trace diagnostics for observability ([abc0005](https://github.com/abbalochdev/opencode-for-copilot/commit/abc0000000000000000000000000000000000005))

## [0.3.3](https://github.com/abbalochdev/opencode-for-copilot/compare/v0.3.2...v0.3.3) (2026-07-12)


### Bug Fixes

* Add GLM business error code handling and related internationalization support ([74f1e92](https://github.com/abbalochdev/opencode-for-copilot/commit/74f1e92dc825ea5b13632716a67edc7ab1a5f0a7))

## [0.3.2](https://github.com/abbalochdev/opencode-for-copilot/compare/v0.3.1...v0.3.2) (2026-07-05)


### Bug Fixes

* Add GLM business error code handling and related internationalization support ([74f1e92](https://github.com/abbalochdev/opencode-for-copilot/commit/74f1e92dc825ea5b13632716a67edc7ab1a5f0a7))

## [0.3.1](https://github.com/abbalochdev/opencode-for-copilot/compare/v0.3.0...v0.3.1) (2026-07-02)


### Bug Fixes

* improve code formatting and structure in multiple files ([1922986](https://github.com/abbalochdev/opencode-for-copilot/commit/1922986a2ef280886ab723a7e2e9ae98b092ee8c))

## [0.3.0](https://github.com/abbalochdev/opencode-for-copilot/compare/v0.2.1...v0.3.0) (2026-06-30)

### Features

- Added new endpoint resolution logic for Anthropic and improved existing endpoint functions. ([7867606](https://github.com/abbalochdev/opencode-for-copilot/commit/78676063e5f7af7880a8b6182f402e23cdf0016d))

- Normalized whitespace and trailing slashes in URL handling functions. ([7867606](https://github.com/abbalochdev/opencode-for-copilot/commit/78676063e5f7af7880a8b6182f402e23cdf0016d))

### Bug Fixes

- Refactor stream handling and diagnostics migration ([f390e36](https://github.com/abbalochdev/opencode-for-copilot/commit/f390e3693cffc723b356e7fccded59577cd0ef03))

## [0.2.1](https://github.com/abbalochdev/opencode-for-copilot/compare/v0.2.0...v0.2.1) (2026-06-26)

### Bug Fixes

- enhance message conversion logic and refactor currency handling in GLMChatProvider ([0195560](https://github.com/abbalochdev/opencode-for-copilot/commit/01955600685d51899e40825c64400732d59f1bbd))

## [0.2.0](https://github.com/abbalochdev/opencode-for-copilot/compare/v0.1.0...v0.2.0) (2026-06-24)

### Features

- add vision proxy panel styles and implement action URL handling ([0101028](https://github.com/abbalochdev/opencode-for-copilot/commit/0101028586e9533742f2d21c499736bcab3024d7))
- enhance configuration and command handling ([5b03555](https://github.com/abbalochdev/opencode-for-copilot/commit/5b03555e11ddbfddd3582c16110f8ade892d4f15))

### Bug Fixes

- revert version to 0.1.0 in package.json and release-please-manifest.json ([c1d749c](https://github.com/abbalochdev/opencode-for-copilot/commit/c1d749c2b74bf02342a19baf0c14a4afb5978377))
- update default values for publish options in rescue workflow ([a3907b0](https://github.com/abbalochdev/opencode-for-copilot/commit/a3907b058455acf41b0fddd568d5e37cf92f8c82))
- update devDependencies for @vscode/vsce and ovsx, and add minimumReleaseAgeExclude for ovsx ([096e96e](https://github.com/abbalochdev/opencode-for-copilot/commit/096e96e92c09f80c7645ab56b9be3485858f2511))
- update GitHub Actions workflows to use latest action versions an… ([eaba3af](https://github.com/abbalochdev/opencode-for-copilot/commit/eaba3af43fc5eaf7b5038fcd88d3b453a86a1b37))
- update GitHub Actions workflows to use latest action versions and improve pnpm setup ([9c2a4fe](https://github.com/abbalochdev/opencode-for-copilot/commit/9c2a4fedeef46577ac576451e763da75d1a601e3))
- update publisher name in package.json to 'ikaros' ([6967284](https://github.com/abbalochdev/opencode-for-copilot/commit/69672845cacb75d1ed31e36411b2decb821bc8b1))
- update workflows to use latest action versions and improve VSIX packaging process ([f32825e](https://github.com/abbalochdev/opencode-for-copilot/commit/f32825e02c5e2c17ed84c2bfb02d3e38a9a2df75))

## 0.2.0 - 2026-06-24

### Added

- Added VitePlus/Vitest tests covering endpoint routing, pricing/currency, model metadata, request conversion, tool handling, routing, and Vision Proxy resolution.
- Added GitHub Actions CI for test, lint, format check, compile, and VSIX packaging.
- Updated CI and release workflows to use Node 24-runtime GitHub Actions and explicit Corepack pnpm activation.
- Updated release workflow to package and upload the VSIX artifact before creating the GitHub Release, then reuse that artifact for marketplace publishing and release assets.
- Added `glm-copilot.apiMode` and `glm-copilot.region` endpoint presets:
  - `coding-plan` or `standard`
  - `china` or `international`
- Added `glm-copilot.customModels` for extra GLM-compatible models in the Copilot Chat model picker.
- Added custom model normalization for string IDs and object entries with optional display name, token limits, tool calling, and thinking support.
- Added generic `glm-copilot.modelIdOverrides` support for built-in and custom model IDs.

### Changed

- Changed `glm-copilot.baseUrl` default to an empty string. When empty, the extension resolves the endpoint from `apiMode` and `region`; when non-empty, `baseUrl` still has highest priority.
- Preserved the default resolved endpoint as domestic GLM Coding Plan: `https://open.bigmodel.cn/api/coding/paas/v4`.
- Updated `GLM: Get API Key` to open the API key or plan page matching the configured `apiMode` and `region`.
- Switched provider picker and request preparation to a shared model registry: built-in models plus normalized custom models.
- Kept the `chatLanguageModels` default reasoning-effort migration scoped to built-in models only.
- Updated package configuration schema, English and Chinese setting strings, and README setting tables.
- Excluded tests from VSIX packaging.

### Vision Policy

- Custom models always expose `imageInput: true` to Copilot Chat, but this means image attachments are allowed to enter the existing Vision Proxy.
- Custom models do not bypass the Vision Proxy and do not enable native vision/image requests.
- The built-in Vision Proxy flow remains unchanged: image attachments are converted to text before the final chat request.

### Acknowledgements

- The endpoint preset and custom model direction was informed by [KiwiGaze/glm-for-copilot](https://github.com/KiwiGaze/glm-for-copilot), an MIT-licensed GLM Copilot Chat extension.
- The Z.ai/Coding Plan product surface and endpoint configuration comparison was informed by [selfagency/z-models-vscode](https://github.com/selfagency/z-models-vscode), an MIT-licensed VS Code extension.
- This project remains MIT-licensed, and these credits are included to make the lineage and inspiration explicit.
