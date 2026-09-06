# Prompt Caching and Prefix Stability

Prompt caching in the Anthropic Claude API significantly reduces latency and token costs by reusing pre-computed KV states for common prompt prefixes. Because Claude Code runs as an external subprocess invoked on each conversation turn, preserving byte-identical prefix stability is essential.

## How Anthropic Prompt Caching Works

Anthropic prompt caching operates strictly from the beginning of the prompt:
1. The prefix is ordered: `tools -> system -> messages`.
2. Any byte change at offset $N$ invalidates the cache from offset $N$ onward.
3. Cache writes are billed at a higher rate, while cache reads are discounted by up to 90%.

A cache break forces Anthropic to re-tokenize and re-cache the entire conversation from the point of divergence.

## Git Status Cache Stabilization

### The Issue
By default, the Claude Code `claude_code` preset appends a dynamic `gitStatus:` block to the system prompt (`system[2]`). This block contains:
- Output from `git status --short` (modified files, staged changes, untracked files).
- Output from `git log -n 5` (recent commit hashes and titles).

Whenever a tool call creates a file, stages a change, or creates a commit, this git status block changes. Because the bridge re-invokes Claude Code per turn, every git transition changed the trailing bytes of the system prompt. This broke the prompt cache for the entire conversation that followed, turning long multi-turn sessions into expensive repeated cache writes (issue #73).

### The Solution
The provider path explicitly configures:

```typescript
settings: {
  ...claudeCodeSettings(bridgeState.providerSettings),
  claudeMdExcludes: CLAUDE_MD_EXCLUDES,
  includeGitInstructions: false,
}
```

Setting `includeGitInstructions: false` strips the dynamic `gitStatus` snapshot from the preset system prompt. Because the provider path supplies tools over Pi's MCP bridge (`tools: []` to Claude Code), stripping native Git instructions from Claude Code's built-in tools has zero cost to tool execution.

AskClaude retains native Claude Code tools and its guidance, where full git integration is expected.

## System Prompt Projection and Prefix Sharing

Pi constructs system prompts containing instructions, project context files (`AGENTS.md`), and available skills. If passed directly, Pi's harness instructions would conflict with Claude Code's preset.

`src/prompt-capture.ts` handles this by:
1. Capturing what Pi assembled during `before_agent_start`.
2. Extracting only the portable parts (context files and registered skills).
3. Projecting them as an append to Claude Code's preset system prompt.
4. Preserving a consistent byte order so subsequent turns reuse the cached system prompt block.

## Practical Tips for Cache Health

- **Avoid unnecessary working directory transitions**: Changing working directories alters path footers and forces a session rebuild.
- **Keep custom instructions stable**: If an extension dynamically rewrites system prompts on every turn, prompt captures cannot match, causing prompt resolution to throw and fall back.
- **Monitor cache metrics**: Check the debug log (`~/.pi/agent/claude-bridge.log`) for `usage: ... cachePct=...%` to verify cache read efficiency.
