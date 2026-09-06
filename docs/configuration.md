# Configuration and Environment Reference

`pi-claude-bridge` can be configured globally or per-project.

## Configuration File Locations

Configuration is loaded from:
1. **Global configuration**: `~/.pi/agent/claude-bridge.json` (or `$PI_CODING_AGENT_DIR/claude-bridge.json` if set).
2. **Project configuration**: `.pi/claude-bridge.json` inside the project directory.

Settings in project configuration take precedence over global settings.

```json
{
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "strictMcpConfig": true,
    "autoMemoryEnabled": false,
    "pathToClaudeCodeExecutable": "/usr/local/bin/claude"
  },
  "askClaude": {
    "enabled": true,
    "name": "AskClaude",
    "label": "Ask Claude Code",
    "defaultMode": "read",
    "allowFullMode": true,
    "defaultIsolated": false,
    "appendSkills": true
  }
}
```

---

## Provider Settings (`provider`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `plan` | `"pro"` \| `"max"` | `"pro"` | Set to `"max"` if you have an Anthropic Max, Team Premium, or Enterprise subscription. Enables 1M context on Opus 4.6. |
| `longContextExtraUsage` | `boolean` | `false` | Enables 1M context for models that charge through Extra Usage on your plan (Sonnet 4.6 on all plans; Opus 4.6 on Pro). |
| `strictMcpConfig` | `boolean` | `true` | When true, ignores host filesystem MCP servers in `~/.claude.json` / `.mcp.json`. Cloud MCP servers are always blocked. |
| `autoMemoryEnabled` | `boolean` | `false` | Enables Claude Code's auto-memory system. Disabled by default to keep Pi in control of agent memory. |
| `pathToClaudeCodeExecutable` | `string` | *(auto)* | Custom path to the `claude` executable. Useful on NixOS or environments where the bundled SDK binary cannot execute. |

---

## AskClaude Settings (`askClaude`)

| Option | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `enabled` | `boolean` | `false` | Opt-in toggle to register the `AskClaude` delegation tool. |
| `name` | `string` | `"AskClaude"` | Tool name registered with Pi. |
| `label` | `string` | `"Ask Claude Code"` | TUI display label. |
| `description` | `string` | *(dynamic)* | Custom override for the tool description. |
| `defaultMode` | `"read"` \| `"none"` \| `"full"` | `"read"` | Default permission mode for delegation calls. |
| `allowFullMode` | `boolean` | `true` | Set to `false` to disable write and bash access in AskClaude globally. |
| `defaultIsolated` | `boolean` | `false` | When `true`, AskClaude calls start in a fresh session with no conversation history. |
| `appendSkills` | `boolean` | `true` | Forwards Pi-side skills into the system prompt for AskClaude. |

---

## Model Matrix and Context Entitlements

The bridge provides the following models under the `claude-bridge` provider:

| Model ID | Family Shortcut | Default Context | 1M Context Requirements |
| :--- | :--- | :--- | :--- |
| `claude-bridge/claude-fable-5-1` | `fable` | **1,000,000** | Available by default |
| `claude-bridge/claude-fable-5` | *(full id)* | **1,000,000** | Available by default |
| `claude-bridge/claude-opus-5` | `opus` | **1,000,000** | Available by default |
| `claude-bridge/claude-opus-4-8` | *(full id)* | **1,000,000** | Available by default |
| `claude-bridge/claude-opus-4-7` | *(full id)* | **1,000,000** | Available by default |
| `claude-bridge/claude-opus-4-6` | *(full id)* | 200,000 | Requires `plan: "max"` or `longContextExtraUsage: true` |
| `claude-bridge/claude-sonnet-5` | `sonnet` | **1,000,000** | Available by default |
| `claude-bridge/claude-sonnet-4-6` | *(full id)* | 200,000 | Requires `longContextExtraUsage: true` |
| `claude-bridge/claude-haiku-4-5` | `haiku` | 200,000 | 200,000 only |

---

## Environment Variables

| Variable | Description |
| :--- | :--- |
| `CLAUDE_BRIDGE_DEBUG=1` | Enables verbose diagnostic logging to `~/.pi/agent/claude-bridge.log`. |
| `CLAUDE_BRIDGE_DEBUG_PATH` | Overrides the destination path for the bridge log. |
| `CLAUDE_CONFIG_DIR` | Specifies the directory where Claude Code stores session JSONL files (defaults to `~/.claude`). |
| `CLAUDE_BRIDGE_RECORD_STREAM` | When set to a file path, appends raw SDK streaming events line-by-line for creating test fixtures. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | Set automatically by the extension to disable telemetry and update checks. |
