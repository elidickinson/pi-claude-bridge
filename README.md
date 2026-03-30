# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/pi-claude-bridge)](https://www.npmjs.com/package/pi-claude-bridge)

Pi extension that integrates Claude Code via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

> Built on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal — the provider skeleton, tool name mapping, and settings loading originate from that project. This fork adds streaming, MCP tool bridging, custom pi tool bridging, session resume/persistence, context sync, thinking support, skills forwarding, and the AskClaude tool.

1. **Provider** — Use Opus/Sonnet/Haiku as models in pi, with all tool calls flowing through pi's TUI
2. **AskClaude tool** — Delegate tasks or questions to Claude Code when using another provider

Uses your Claude Max/Pro subscription. I believe this is compliant with Anthropic's terms because only the real Claude Code is touching the API and it's to enable [local development](https://x.com/trq212/status/2024212380142752025) not to steal API calls for some other commerical purpose. That said, obviously this extension is not endorsed or supported by Anthropic.
<p>
<a href="claude-bridge1.png"><img src="claude-bridge1.png" width="49%"></a>&nbsp;
<a href="claude-bridge2.png"><img src="claude-bridge2.png" width="49%"></a>
</p>

## Setup

1. Install:
   ```
   pi install npm:pi-claude-bridge
   ```

2. Ensure Claude Code is installed and logged in (`claude` CLI works).

3. Reload pi: `/reload`

## Provider

Use `/model` to select `claude-bridge/claude-opus-4-6`, `claude-bridge/claude-sonnet-4-6`, or `claude-bridge/claude-haiku-4-5`.

Behind the scenes, pi's tools are bridged to Claude Code but it should all work like normal in pi. Bash commands get a 120-second default timeout (matching Claude Code's default) since pi's bash has no timeout by default.

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

Config: `~/.pi/agent/claude-bridge.json` (global) or `.pi/claude-bridge.json` (project).

```json
{
  "maxHistoryMessages": 40,
  "askClaude": {
    "enabled": true,
    "allowFullMode": false,
    "description": "Custom tool description override"
  }
}
```

`maxHistoryMessages` limits how many pi messages are imported into the CC session context. Omit for no limit (default).

## Tests

`npm run test:unit` for offline tests; `CLAUDE_BRIDGE_TESTING_ALT_MODEL=openrouter/z-ai/glm-4.7-flash npm test` for the full suite (hits APIs).

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to log to `~/.pi/agent/claude-bridge.log`.

## Maintenance

After updating Claude Code or the Agent SDK, check for new built-in tools that may need adding to `DISALLOWED_BUILTIN_TOOLS` in `index.ts`. Unrecognized CC tools leak through to pi as tool calls it can't handle. Symptoms: "Tool X not found" errors in pi.
