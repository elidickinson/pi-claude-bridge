# pi-claude-bridge-askclaude

Pi extension that adds an **AskClaude** tool: when you're using another provider in pi, the model can delegate a question or task to Claude Code (via the [Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)) and get its answer back. A companion to [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge), which doesn't need to be installed.

## Install

```
pi install npm:pi-claude-bridge-askclaude
```

Claude Code must be logged in: run `claude auth login`.

## Usage

The calling model picks a mode per call: `read` (default) for questions about the codebase, `none` for general knowledge with no file access, or `full` to let Claude Code make changes. By default Claude sees pi's conversation so far; `isolated: true` sends only the prompt. Model names (`opus`, `sonnet`, `haiku`, a full id) go to Claude Code as they are, so Claude Code picks the context size; `opus[1m]` asks for 1M. pi's skills are listed in Claude Code's system prompt. AskClaude doesn't work while claude-bridge is the active provider.

**Full mode risks:** in `full` mode Claude Code writes files and runs bash with `bypassPermissions`, using its own tools on your machine. pi shows none of those steps as they happen, pi's tool hooks and any permission or sandbox extension don't apply, and the calling model only gets Claude's final answer back. There is no setting to disable `full` mode alone; uninstall AskClaude if you don't want that.

## Settings

AskClaude has no settings of its own. It reads `provider.pathToClaudeCodeExecutable` and `provider.autoMemoryEnabled` from pi-claude-bridge's config, `~/.pi/agent/claude-bridge.json`, if present.

`CLAUDE_BRIDGE_DEBUG=1` logs to the same debug log as pi-claude-bridge.
