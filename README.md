<h1 align="center">OpenCode for Copilot Chat</h1>

<p align="center">
  <!-- marketplace-readme:remove-start -->
  <img src="https://img.shields.io/badge/OpenCode-Go-007ACC?logo=visualstudiocode&logoColor=white&style=for-the-badge" alt="OpenCode Go" />
  <br/>
  <img src="https://img.shields.io/github/v/release/abbalochdev/opencode-for-copilot?style=for-the-badge&label=Version" alt="Version" />
  <!-- marketplace-readme:remove-end -->
</p>

**Use OpenCode Go open coding models in the Copilot Chat model picker — and keep everything else Copilot already gives you.**

<p align="center">
  <img src="resources/screenshots/01-picker.png" alt="OpenCode Go models in the Copilot Chat model picker" width="800">
</p>

Love the open coding models on [OpenCode Go](https://opencode.ai/docs/go/) but don't want to give up GitHub Copilot's agent mode, tool calling, and polished UI? This extension drops **GLM-5.2, Kimi K2.7 Code, DeepSeek V4, MiMo, MiniMax, and Qwen** straight into the Copilot Chat model selector — with **vision**, **thinking mode**, and your own OpenCode Go API key. just need a small purchase to use it

## Why this extension?

- **Don't replace Copilot — power it up.** No new sidebar, no new chat UI to learn. Just a new model in the picker you already use.
- **All 14 OpenCode Go models.** GLM-5.2/5.1, Kimi K2.7 Code/K2.6, DeepSeek V4 Pro/Flash, MiMo V2.5/V2.5 Pro, MiniMax M3/M2.7/M2.5, and Qwen3.7 Max/Plus/3.6 Plus — one API key, one extension.
- **Mixed protocols handled automatically.** GLM/Kimi/DeepSeek/MiMo run on the OpenAI `/chat/completions` endpoint; MiniMax/Qwen run on the Anthropic `/v1/messages` endpoint. The extension routes each model to the right endpoint automatically.
- **Agent mode, tool calling, instructions, MCP, skills — all of it still works.** Copilot's entire stack, now running on your OpenCode Go subscription.
- **Vision where each model needs it.** Images are transparently described by the vision proxy first, then passed along as text. If no vision model is configured, the extension falls back to another Copilot/VS Code vision model.
- **Estimated per-turn cost.** When the API returns usage, the extension estimates the list-price cost in USD, reports it to Copilot usage metadata, writes it to logs, and shows the latest turn in the status bar.
- **BYOK, pay OpenCode directly.** Your OpenCode Go API key, your $5/month subscription, your rate limits. Stored in the OS keychain, never on disk.

## Features

### GLM-5.2/5.1, Kimi K2.7 Code/K2.6, DeepSeek V4 Pro/Flash, MiMo V2.5/V2.5 Pro, MiniMax M3/M2.7/M2.5, and Qwen3.7 Max/Plus/3.6 Plus in the model picker

All three models show up alongside GPT-4o, Claude, and friends in Copilot Chat's model selector. Switch models mid-chat without losing history.

### Transparent Vision Proxy

Drop a screenshot into chat and the automatic proxy describes it before the selected model receives the prompt. If no vision model is available on the current endpoint or plan, the extension falls back to another installed Copilot/VS Code vision model. You can also force a VS Code model or a custom API endpoint from **OpenCode: Configure Vision Proxy**.

This keeps GLM-5.2 focused on coding/reasoning while GLM-4.6V-Flash handles multimodal extraction.

<p align="center">
  <img src="resources/screenshots/03-vision.png" alt="Dropping an image into Copilot Chat and GLM responding to it via the vision proxy" width="800">
</p>

### Thinking Mode with Reasoning Effort Control

Full support for GLM's `reasoning_content`. Use Copilot Chat's native model picker menu to choose `none` (off), `high` (balanced), or `max` (default deep reasoning for hard agent tasks).

### Inherits Every Copilot Capability

Because this plugs into Copilot's native provider API, you get the full stack for free:

- **Agent mode** — autonomous multi-step tasks
- **Tool calling** — file edits, terminal, workspace search, Git, tests
- **Instructions & skills** — all your `.instructions.md`, `AGENTS.md`, and skills just work
- **Prompt caching stats** — GLM's cache hit rate logged in the output channel so you can see the savings

<p align="center">
  <img src="resources/screenshots/04-agent.png" alt="GLM-5.2 running Copilot's agent mode with tool calls" width="800">
</p>

### Secure by Default

API key lives in VS Code's `SecretStorage` (OS keychain on macOS / Windows / Linux). Never in `settings.json`, never in your Git history.

### Cost Visibility

After each completed GLM response, the extension reports usage to Copilot metadata and writes it to logs. The status bar shows the latest turn and session total. Estimates use the official GLM list prices for the current endpoint currency: CNY for domestic BigModel endpoints and USD for Z.ai endpoints. Coding Plan requests also show an approximate list-price equivalent when token usage is returned.

### Ponytail Coding Discipline ("Lazy Senior Dev" Verification)

Every request is prefixed with a **Ponytail-style system instruction** that makes the model think like a lazy senior developer — efficient, not careless. It climbs a 7-rung ladder before writing any code:

1. **Does this need to be built at all?** (YAGNI)
2. **Does it already exist in the codebase?** Reuse it.
3. **Does the standard library do this?** Use it.
4. **Does a native platform feature cover it?** Use it.
5. **Does an already-installed dependency solve it?** Use it.
6. **Can this be one line?** Make it one line.
7. **Only then:** write the minimum code that works.

Three intensity modes — `lite` (brief reminder), `full` (complete ladder with all rules, default), and `ultra` (strict, with edge-case prioritization) — plus `off` to disable. Switch modes on the fly from the Command Palette: **OpenCode: Set Ponytail Mode**.

> **Effect on plugin behaviour:** The model generates fewer unnecessary abstractions, avoids reinventing wheels that already exist in your project, prefers stdlib over new dependencies, and writes shorter, more maintainable diffs. This means cleaner PRs, less code to review, and fewer dependencies to manage — without sacrificing correctness, security, or error handling.

### Zero Runtime Dependencies

Pure VS Code API + Node.js built-ins. No Python, no Docker, no local proxy server to babysit.

## Getting Started

### Prerequisites

- VS Code 1.116 or later. This extension relies on non-public Copilot Chat APIs that may break on newer VS Code versions — [report an issue](https://github.com/abbalochdev/opencode-for-copilot/issues) if you hit one.
- GitHub Copilot subscription (Free / Pro / Enterprise — the free tier works)
- **OpenCode Go subscription** ($5 for your first month, then $10/month). Subscribe at [opencode.ai/auth](https://opencode.ai/auth) and copy your API key. The GLM Coding Plan and Z.ai endpoints are also supported via the `endpoint` setting.

### Installation

Install from the registry used by your editor:

1. **Microsoft VS Code** — install from [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=abbalochdev.opencode-for-copilot).
2. **Editors that use Open VSX** — install from [Open VSX](https://open-vsx.org/extension/abbalochdev/opencode-for-copilot).

### Usage

1. Subscribe to [OpenCode Go](https://opencode.ai/docs/go/) and copy your API key from [opencode.ai/auth](https://opencode.ai/auth)
2. Run **OpenCode: Set API Key** from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`)
3. Paste your OpenCode Go API key — it's stored in VS Code's secure SecretStorage (OS keychain)
4. Open Copilot Chat, click the model picker, pick any OpenCode Go model (GLM-5.2, Kimi K2.7 Code, DeepSeek V4 Flash, etc.)
5. That's it — chat away!

## Models

All 14 OpenCode Go models are available. The extension automatically routes each model to the correct endpoint protocol:

### OpenAI endpoint (OpenCode Go)

| Model                | Best For                                   |
| -------------------- | ------------------------------------------ |
| **Grok 4.5**         | Frontier reasoning (xAI)                    |
| **GLM-5.2**          | Flagship coding & reasoning, 1M context     |
| **GLM-5.1**          | High-quality coding & reasoning             |
| **Kimi K3**          | Frontier reasoning model                    |
| **Kimi K2.7 Code**   | Coding-tuned reasoning model                |
| **Kimi K2.6**        | General coding & reasoning                  |
| **DeepSeek V4 Pro**  | High-quality reasoning                      |
| **DeepSeek V4 Flash**| Fast and economical coding                  |
| **MiMo V2.5**       | Fast and economical coding                  |
| **MiMo V2.5 Pro**    | High-quality reasoning                      |

### Anthropic endpoint (OpenCode Go)

| Model               | Best For                                   |
| ------------------- | ------------------------------------------ |
| **MiniMax M3**      | Coding agent work                          |
| **MiniMax M2.7**    | Coding agent work                          |
| **MiniMax M2.5**    | Coding agent work                          |
| **Qwen3.7 Max**     | Top-tier reasoning (256K context)          |
| **Qwen3.7 Plus**    | Cost-effective reasoning (1M context)      |
| **Qwen3.6 Plus**    | Cost-effective reasoning (256K context)    |

All models support tool calling. GLM-5.2 and GLM-5.1 support thinking mode with reasoning effort control (`none` / `high` / `max`). Image attachments go through the Vision Proxy.

## Settings

| Setting                                      | Default                   | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `glm-copilot.endpoint`                       | `opencode-go`             | Single-value endpoint selector. `opencode-go` (OpenAI protocol) serves GLM, Kimi, DeepSeek, MiMo; `opencode-go-anthropic` (Anthropic protocol) serves MiniMax, Qwen. Also supports Zhipu/Z.ai GLM endpoints: `china-coding`, `china-standard`, `china-anthropic`, `international-coding`, `international-standard`, `international-anthropic` |
| `glm-copilot.baseUrl`                        | empty                     | Optional API endpoint override. When non-empty, overrides the `endpoint` preset. Default resolved endpoint is OpenCode Go: `https://opencode.ai/zen/go/v1`                                                                                                                                                                                                                                                                                                       |
| `glm-copilot.maxTokens`                      | `0`                       | Max output tokens (`0` = no limit). Useful for cost control                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `glm-copilot.modelIdOverrides`               | prefilled OpenCode Go IDs | API model IDs to send for built-in or custom models. Change only for compatible endpoints with different model names                                                                                                                                                                                                                                                                                                                                 |
| `glm-copilot.customModels`                   | `[]`                      | Extra GLM-compatible models for the picker. Accepts string IDs or objects with `id`, optional `name`, token limits, `toolCalling`, and `thinking`. Custom IDs override built-ins. Images still go through the current Vision Proxy; custom models do not bypass it for native vision                                                                                                                                                                                                                                          |
| `glm-copilot.debugMode`                      | `minimal`                 | Diagnostic mode: `minimal` for token usage only, `metadata` for privacy-preserving logs, or `verbose` for full request dumps and pipeline snapshots under extension global storage. Full dumps may include sensitive prompt text, tool schemas, file snippets, and image descriptions. Use `OpenCode: Open Request Dumps Folder` to open the dump location                                                                                                                                                                         |
| `glm-copilot.visionModel`                    | _(auto)_                  | VS Code vision model used as fallback when automatic vision is unavailable. Configure from `OpenCode: Configure Vision Proxy`; new saves use `vendor/id`, while legacy bare model IDs are still read                                                                                                                                                                                                                                                                                                                |
| `glm-copilot.visionPrompt`                   | _(built-in)_              | Prompt used to describe image attachments                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `glm-copilot.ponytailMode`                   | `full`                    | Ponytail coding-discipline system instruction level. `off` = no instruction; `lite` = brief reminder; `full` = complete 7-rung ladder with all rules; `ultra` = strict mode prioritizing edge-case correctness. Use `OpenCode: Set Ponytail Mode` to switch at runtime                                                                                                                                                                                                                                                         |
| `glm-copilot.experimental.stabilizeToolList` | `false`                   | Experimental. Tries to pre-activate VS Code/Copilot virtual tools so the API `tools` parameter is more complete and stable across turns. May improve context-cache hit rate when enabled tools change between turns. Can increase input tokens because more function definitions may be included; cache-hit input tokens are cheaper but still count toward usage. Usually leave it off with 64 or fewer enabled tools unless the tool list still changes across turns; do not enable it with more than 128 enabled tools |

Thinking Effort is configured from Copilot Chat's model picker for each thinking-capable GLM model.

Example `settings.json` for a custom API proxy:

```json
{
  "glm-copilot.baseUrl": "https://proxy.example.com/v1",
  "glm-copilot.customModels": [
    "my-model",
    {
      "id": "team-coder",
      "name": "Team Coder",
      "maxInputTokens": 200000,
      "maxOutputTokens": 131072,
      "toolCalling": true,
      "thinking": true
    }
  ],
  "glm-copilot.modelIdOverrides": {
    "glm-5.2": "your-glm-5.2-model-id"
  }
}
```

## Troubleshooting

### GLM models are missing from the agent / background agent model picker

Recent VS Code versions gate custom providers from the background agent and the new agent window. If you can pick GLM in the editor chat but not in the agent window, add the extension to the allowlist in `settings.json`:

```json
{
  "extensions.supportUntrustedWorkspaces": true,
  "extensions.supportAgentsWindow": {
    "abbalochdev.opencode-for-copilot": true
  }
}
```

If the agent still refuses to start with `No utility model is configured for 'copilot-utility-small' while the selected main model is BYOK`, that is a known VS Code Copilot regression — see [microsoft/vscode#324007](https://github.com/microsoft/vscode/issues/324007). Switching the editor chat to GLM usually works while the upstream issue is open.

### HTTP 400 `Invalid schema for function '...'` from a proxy or relay

This extension targets the OpenCode Go endpoints and the official GLM endpoints (BigModel Coding Plan, Z.ai, and the documented BigModel/Z.ai standard API). VS Code/Copilot generates the tool schemas verbatim from its own tool definitions and forwards them as-is. Third-party relays or proxies (e.g. New API, OneAPI) often enforce stricter OpenAI-schema validation than the official endpoint and reject schemas that contain `default: null`, certain `anyOf`/`oneOf` shapes, or other minor deviations — the most common symptom is `Invalid schema for function 'get_errors': null is not of type "array"`.

This is **not** something this extension sanitizes, by design:

- We forward exactly what VS Code/Copilot produces, so any compatibility fix that works on the official endpoint is preserved.
- Maintaining per-relay quirks would create an ever-growing patch surface that can mask real upstream bugs.

If you hit this on a relay, the supported options are:

- Switch `glm-copilot.baseUrl` back to the OpenCode Go or official GLM endpoint (leave empty and use `endpoint`).
- Open a request dump with **OpenCode: Open Request Dumps Folder** and inspect the offending tool schema, then report the strict-validation bug to your relay.
- The error is also written to the OpenCode output channel — you can copy the full server response from there.

## Compared to alternatives

|                           | This extension | Local proxy (e.g. LiteLLM) | Standalone GLM extensions |
| ------------------------- | -------------- | -------------------------- | ------------------------- |
| Works inside Copilot Chat | ✅             | ✅                         | ❌ separate UI            |
| Agent mode, tools, skills | ✅             | ✅                         | ⚠️ reimplemented          |
| Vision support            | ✅ proxied     | ❌                         | ❌                        |
| No extra process to run   | ✅             | ❌                         | ✅                        |
| One-click install         | ✅             | ❌                         | ✅                        |
| API key in OS keychain    | ✅             | ❌                         | ⚠️ varies                 |

## Acknowledgements

This extension is a **fork and rebrand** of [**GLM for VS Code Copilot**](https://marketplace.visualstudio.com/items?itemName=ikaros.glm-for-vscode-copilot) by [ikaros](https://github.com/umbrella22/glm-for-copilot), published under the MIT License. We thank the original author for the high-quality BYOK Copilot Chat provider implementation, vision proxy, and cost estimation infrastructure that make this OpenCode Go extension possible.

This project also references ideas and implementation patterns from [Vizards/deepseek-v4-for-copilot](https://github.com/Vizards/deepseek-v4-for-copilot), [KiwiGaze/glm-for-copilot](https://github.com/KiwiGaze/glm-for-copilot), and [selfagency/z-models-vscode](https://github.com/selfagency/z-models-vscode). Thanks to the original authors. Where applicable, redistribution and derivative work should preserve the original MIT License notices.

## License

[MIT](LICENSE)
