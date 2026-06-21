# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/pi-claude-bridge)](https://www.npmjs.com/package/pi-claude-bridge)

Pi extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript). Based initially on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal. This fork adds streaming, MCP tool bridging, custom pi tool bridging, session resume/persistence, context sync, thinking support, skills forwarding, and the AskClaude tool.

1. **Provider** — Use Opus/Sonnet/Haiku as models in pi, with all tool calls flowing through pi's TUI
2. **AskClaude tool** — Delegate tasks or questions to Claude Code when using another provider


> **Important note:** Starting June 15, 2026 [Anthropic has announced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) they will no longer allow tools based on the Agent SDK (like this one) to pull from your regular subscription quota. Instead they pull from a monthly credit equal to your subscription fee (so $100 of usage credits on a $100/month Max plan). I'm not sure how valuable this extension will be once that happens. If there are easier ways to pull from that $100 bucket connecting to the API directly without the Agent SDK overhead, that's probably a better approach. (Alternatively there are other extensions focused on spoofing the official Claude Code client to keep using subscription quota.)

<p>
<a href="assets/claude-bridge1.png"><img src="assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="assets/claude-bridge2.png"><img src="assets/claude-bridge2.png" width="49%"></a>
</p>

## Install

```
pi install npm:pi-claude-bridge
```

## Provider

Use `/model` to select `claude-bridge/claude-opus-4-8`, `claude-bridge/claude-opus-4-7`, `claude-bridge/claude-opus-4-6`, `claude-bridge/claude-sonnet-4-6`, or `claude-bridge/claude-haiku-4-5`.

### 1M context window

1M context is **opt-in per model**. By default every model runs on its 200K window. To enable 1M for specific models, list their bare ids under `provider.enableLongContextModels` in `~/.pi/agent/claude-bridge.json` or `.pi/claude-bridge.json` (project overrides global):

```json
{
  "provider": {
    "enableLongContextModels": ["claude-opus-4-8", "claude-opus-4-6"]
  }
}
```

**Set `provider.plan` to match your subscription** (default `"pro"`). This controls the context window pi *reports* for Opus when you haven't listed it above — it must match what Claude Code actually runs, or pi's status bar and auto-compaction threshold will be wrong:

```json
{
  "provider": {
    "plan": "max"
  }
}
```

- **`"pro"`** (default) — bare Opus runs at 200K, so pi registers 200K. Use for Pro, Team Standard, or Enterprise subscription seats.
- **`"max"`** — Claude Code auto-upgrades a bare Opus id to 1M (default since v2.1.75), so pi registers 1M **without appending `[1m]`**, avoiding the usage-credits gate an explicit `opus[1m]` can trip on Max 5x ([claude-code#39841](https://github.com/anthropics/claude-code/issues/39841)). Use for Max, Team Premium, Enterprise pay-as-you-go, or the Anthropic API.

`plan` only affects Opus (the only family that auto-upgrades with a bare id); Sonnet and Haiku are unaffected. It never appends `[1m]` — that's solely `enableLongContextModels`'s job — so on Max you get accurate 1M budgeting for Opus without the `[1m]` risk.

**Whether you need to opt in — and whether it costs extra — depends on both the model and your plan** (per Anthropic's [paid-plan context docs](https://support.claude.com/en/articles/8606394-how-large-is-the-context-window-on-paid-claude-plans)):

- **Opus 4.6/4.7/4.8 on Max/Team/Enterprise**: auto-upgraded to 1M with the bare id (covered by your subscription) — set `provider.plan: "max"` for accurate reporting; don't list Opus in `enableLongContextModels`, since an explicit `opus[1m]` is redundant and reportedly trips the usage-credits gate on Max 5x ([claude-code#39841](https://github.com/anthropics/claude-code/issues/39841)).
- **Opus 4.6/4.7/4.8 on Pro**: set `provider.plan: "pro"` (the default). 1M requires usage credits; list Opus in `enableLongContextModels` only if credits are enabled, otherwise the request fails with `Usage credits are required for long context requests`.
- **Sonnet 4.6 on any plan**: 1M is metered via usage credits on *every* plan, including Max (except usage-based Enterprise). Opting in means every Sonnet turn spends credits — only do it deliberately.

**Registered context window:** the bridge registers each model with pi at the window it actually requests from Claude Code — 1M for opted-in long-context models (which send `[1m]`) and for bare Opus when `plan` is `"max"` (auto-upgraded by CC); 200K otherwise. This keeps pi's status bar and auto-compaction threshold honest, preventing the original issue #24/#17 "Prompt is too long" / credit-gate class where pi reports headroom while CC runs at 200K.

**Extension providers and models.json:** pi's `modelOverrides` in `~/.pi/agent/models.json` do not currently apply to extension-registered providers (like claude-bridge). Overriding `contextWindow` or other fields requires editing `src/models.ts` directly.

Behind the scenes, pi's tools are bridged to Claude Code but it should all work like normal in pi. Bash commands get a 120-second default timeout (matching Claude Code's default) since pi's bash has no timeout by default. Skills in pi are copied over to Claude Code's system prompt so should work as they would with any other pi provider.

## AskClaude Tool

Available when using any non-claude-bridge provider. Pi's LLM can delegate tasks to Claude Code and wait for it to answer a question or perform a task. Examples of how to use:

- "Ask Claude to plan a fix"
- "If you get stuck, ask claude for help"
- "Ask claude to review the plan in @foo.md, implement it, then ask an isolated=true claude to review the implementation"
- "Ask claude to poke holes in this theory"
- "Find all the places in the codebase that handle auth"

You could also create skills or add something to AGENTS.md to e.g. "Always call Ask Claude to review complicated feature implementations before considering the task complete."

### Parameters

- **`prompt`** — the question or task for Claude Code
- **`mode`** — `read` (default, read files and search/fetch on web), `none`, or `full` (read+write+bash, disable this mode with `allowFullMode: false` in config)
- **`model`** — `opus` (default), `sonnet`, `haiku`, or a full model ID
- **`thinking`** — effort level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
- **`isolated`** — when `true`, Claude gets a clean session with no conversation history (default: `false`)

## Configuration

Config: `~/.pi/agent/claude-bridge.json` (global) or `.pi/claude-bridge.json` (project; merged over global).

```json
{
  "askClaude": {
    "enabled": true,
    "allowFullMode": true,
    "defaultIsolated": false,
    "description": "Custom tool description override"
  },
  "provider": {
    "strictMcpConfig": true,
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`askClaude`:
- `enabled` — register the AskClaude tool (default `true`)
- `name`, `label`, `description` — overrides for the tool's pi-side name, TUI label, and description
- `defaultMode` — `"read"` (default), `"none"`, or `"full"`
- `defaultIsolated` — start each call in a fresh session (default `false`)
- `allowFullMode` — allow `mode: "full"`; set `false` to lock it out
- `appendSkills` — forward pi's skills block into the system prompt (default `true`)

`provider` (low-level SDK plumbing, most users can ignore):
- `appendSystemPrompt` — append pi's AGENTS.md and skills (default `true`)
- `settingSources` — CC filesystem settings to load; only applied when `appendSystemPrompt: false`
- `strictMcpConfig` — block MCP servers from `~/.claude.json` / `.mcp.json` (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Required on **NixOS** (and other non-FHS systems) where the SDK's bundled musl/glibc binaries can't run. Set to your Nix-installed binary, e.g. `"/home/you/.nix-profile/bin/claude"`.

## Tests

`npm run test:unit` for offline tests (`tests/unit-*.mjs`: queue, import, skills). 

`npm test` for the full suite, which adds integration tests that hit APIs (`tests/int-*.{sh,mjs}`: smoke, multi-turn, cache, session-resume, session-rebuild, tool-message). Set `CLAUDE_BRIDGE_TESTING_ALT_MODEL` in `.env.test` for the alt-provider smoke test (e.g. `openrouter/z-ai/glm-4.7-flash`).

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `~/.pi/agent/claude-bridge.log` — every provider call, session sync decision, tool result delivery, and CC's stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query Claude Code CLI logs** at `~/.pi/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log` — the CC subprocess's own debug stream, one file per `query()` call. Tags are `provider` (main turn), `continuation` (steer replay), or `askclaude` (sub-delegation). Useful when a resume fails or CC misbehaves internally — shows the CLI's own view of session loading, API requests, and tool calls.

When filing a bug about a session-resume failure (e.g. "No conversation found"), the most useful attachments are the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Maintenance

After a Claude Code release, review `MODE_DISALLOWED_TOOLS` in `src/index.ts` — it gates which CC tools the AskClaude subagent may invoke per mode (`read` / `full` / `none`). Add new agentic tools (PlanMode, Task spawning, etc.) to the appropriate mode lists if they shouldn't be available to subagents.
