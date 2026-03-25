# ACP `_meta` Field Reference

Undocumented `_meta` options supported by `claude-agent-acp` (the ACP bridge to the Claude Agent SDK). These are passed in `newSession` requests and translated into Claude Agent SDK options.

Source: [`zed-industries/claude-agent-acp`](https://github.com/zed-industries/claude-agent-acp) `src/acp-agent.ts` (`createSession` method).

## `_meta.systemPrompt`

Controls Claude Code's system prompt. Accepts two forms:

**String** — replaces the system prompt entirely:
```typescript
_meta: { systemPrompt: "You are a code reviewer. Only analyze, never modify." }
```

**Object with `append`** — appends to the default `claude_code` preset:
```typescript
_meta: { systemPrompt: { append: "Additional instructions here..." } }
```

The `append` form is preferred — it keeps Claude Code's full default prompt and adds to it. This is the same mechanism the Claude Agent SDK uses via `systemPrompt: { type: "preset", preset: "claude_code", append: "..." }`.

**Use case:** Forward pi's skills and AGENTS.md to Claude Code so it has awareness of the same context.

## `_meta.disableBuiltInTools`

Boolean. Disables all of Claude Code's built-in tools (Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, etc.).

```typescript
_meta: { disableBuiltInTools: true }
```

**Caveat:** Does not work when `bypassPermissions` session mode is active. Use `disallowedTools` instead.

## `_meta.claudeCode.options`

Nested object passed through to the Claude Agent SDK's query options. Supported fields:

### `allowedTools`

Array of tool name strings or glob patterns. Pre-approves listed tools in the permission pipeline.

```typescript
_meta: {
  claudeCode: {
    options: {
      allowedTools: ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"]
    }
  }
}
```

Supports MCP tool globs: `"mcp__server-name__*"`.

**Caveat:** This is a whitelist for permission approval, NOT a restriction. Tools not in the list still go through the permission check and can be approved. Does not restrict tool availability when `bypassPermissions` is active. Use `disallowedTools` to actually block tools.

### `disallowedTools`

Array of tool name strings. Blocks listed tools — works even with `bypassPermissions`.

```typescript
_meta: {
  claudeCode: {
    options: {
      disallowedTools: ["Write", "Edit", "Bash", "NotebookEdit"]
    }
  }
}
```

**Use case:** The only reliable way to restrict tools when using `bypassPermissions`.

### `resume`

String (session ID). Resume a previous Claude Code session.

```typescript
_meta: {
  claudeCode: {
    options: { resume: "session-id-here" }
  }
}
```

Also accessible at the top level: `newSession` extracts `_meta.claudeCode.options.resume`.

### `maxTurns`

Number. Maximum conversation turns before Claude Code stops.

```typescript
_meta: {
  claudeCode: {
    options: { maxTurns: 10 }
  }
}
```

### `extraArgs`

Object of CLI argument key-value pairs passed to Claude Code. Keys are CLI flag names (without `--`), values are the flag value or `null` for boolean flags.

```typescript
_meta: {
  claudeCode: {
    options: {
      extraArgs: {
        "strict-mcp-config": null,  // --strict-mcp-config (ignore ~/.claude.json and .mcp.json MCP servers)
        "setting-sources": "user",  // --setting-sources user
      }
    }
  }
}
```

**Use case:** `strict-mcp-config` prevents Claude Code from loading MCP servers from user/project config files, reducing token overhead from unwanted tool schemas.

**Caveat:** Not all CLI args may be effective when passed this way — the ACP adapter may not forward all args. `strict-mcp-config` is confirmed working.

### `mcpServers`

MCP server configurations to add to the session. These are merged with any built-in ACP server.

```typescript
_meta: {
  claudeCode: {
    options: {
      mcpServers: {
        "my-server": {
          command: "node",
          args: ["/path/to/server.js"],
          env: { API_KEY: "..." }
        }
      }
    }
  }
}
```

### `hooks`

Tool execution hooks (PreToolUse, PostToolUse). Advanced — allows intercepting tool calls.

## Other `newSession` fields

These are part of the ACP protocol, not `_meta`:

- **`cwd`** (required) — working directory for the session
- **`mcpServers`** (required) — array of MCP server configs (protocol-level, separate from `_meta.claudeCode.options.mcpServers`)

## What's NOT available via ACP

These Claude Agent SDK features have no known ACP equivalent:

- **`settingSources`** — controls which `.claude` config dirs are loaded. Likely works via `extraArgs: { "setting-sources": "user" }` (same mechanism as `strict-mcp-config`) but untested.
- **`strictMcpConfig`** — works via `extraArgs: { "strict-mcp-config": null }`. Confirmed working.
- **`permissionMode`** — ACP uses `setSessionMode` instead (e.g., `modeId: "bypassPermissions"`).
- **`canUseTool` callback** — no ACP equivalent for per-tool permission logic.
- **`includePartialMessages`** — streaming is handled differently in ACP (session/update notifications).

## References

- [claude-agent-acp source](https://github.com/zed-industries/claude-agent-acp)
- [Claude Agent SDK docs](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference)
- [ACP meta field reference (third-party)](https://raw.githubusercontent.com/phil65/agentpool/refs/heads/main/acp_meta_field_reference.md)
