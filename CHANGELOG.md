# Changelog

## Unreleased

- **Fix: "No conversation found with session ID" in dirs with dots/underscores/spaces** — bump `cc-session-io` to 0.1.2; `projectPathToHash` now matches the CLI's sanitization (`/[^a-zA-Z0-9]/g` → `-`) instead of only replacing slashes
- **Fix: steer/followUp during tool execution no longer hangs** — `extractAllToolResults` now walks past injected user messages instead of stopping at them
- **ID-based tool result matching** — tool results are matched to MCP handlers by `toolCallId` instead of FIFO position; eliminates silent wrong-result delivery if order diverges
- Add integration tests for tool execution scenarios (normal, followUp, steer, parallel+steer, abort) with auto-restart on failure
- Add `background` parameter to AskClaude — runs Claude in the background while pi continues working; result delivered as a follow-up message on completion; footer status shows progress
- Add `defaultBackground` and `defaultIsolated` config options for AskClaude
- Remove skill path aliasing (`.pi/` → `.claude/` round-trip); pass through real paths instead
- Rewrite skills block to reference MCP-bridged read tool (`mcp__custom-tools__read`)
