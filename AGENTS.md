# Agent Guidelines

## Claims about how Claude Code behaves

`~/.claude/projects/**` is **not** evidence of what CC does -- the bridge writes there too, and CC re-serializes imported records under synthetic ids. Split by provenance (CC-live: real `requestId`/`promptId`; ours: `msg_syn_*`/`req_syn_*`) and regroup by `message.id` (`diag/audit-transcripts.mjs` does both).

Better: prove it with a live probe. `tests/int-cc-contracts.mjs` pins undocumented behavior against the installed CC/SDK; `diag/capture-proxy.mjs` captures request bodies. `claude-code-rip/` is mechanism only, never current behavior. Before reverse-engineering an SDK option, grep `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` first.

Validate any *rate* from the debug log on a case whose answer you know. Bin by era before comparing groups -- a window straddling the onset credits whatever else changed.

Five wrong conclusions across two sessions came from skipping the above.

## Adding a model

The picker is built from pi-ai's static builtin catalog (`getModels("anthropic")`
in `src/index.ts`) plus `MODELS_AHEAD_OF_CATALOG` in `src/models.ts`, so an id
in neither never appears in `/model`. Check
`node_modules/@earendil-works/pi-ai/dist/providers/data/anthropic.json`
before concluding a bridge change made a model reachable. `--model
claude-bridge/<unlisted-id>` still launches, because pi's `buildFallbackModel`
clones the provider's first registered model and overrides its id: the window
that session reports comes from that clone, not from
`resolveClaudeCodeRuntimeModel`.

Measure before allowlisting: `node diag/context-size.mjs max <id>` records what
the SDK actually serves (see `diag/CONTEXT-SIZE.md`), and
`BRIDGE_MODEL=claude-bridge/<id> node --import tsx tests/int-served-window.mjs`
shows served vs registered through a real pi session.

## Changelog

Maintain an entry in the `## UNRELEASED` section at the top of `CHANGELOG.md` for every significant change, using the existing format:

```
- **Tag: summary** — detail
```

Do not add changelog entries for docs-only changes, or for small changes (especially test-only ones) unless they relate to an issue. Combine multiple UNRELEASED entries about the same feature into one.

Keep entries short: one sentence of detail is usually enough. Only a big change warrants a few sentences. Leave implementation details and file lists to the commit log and docs.

Tags: `Add`, `Fix`, `Refactor`, `Tests`, `Bump`, `Deprecate`, `Remove`, `Debug`, `Breaking`.

## Release

No build step — the package ships `src` TypeScript as-is (see `files` in `package.json`). To cut version `X.Y.Z`:

1. **Changelog** — rename the `## UNRELEASED` section to `## X.Y.Z — YYYY-MM-DD`.
2. **Bump** — set `version` to `X.Y.Z` in `package.json`.
3. **Commit** — `git commit -m "Release X.Y.Z"` (changelog + package.json only).
4. **Tag** — `git tag -a vX.Y.Z -m "X.Y.Z"` (note the `v` prefix; annotated so `--follow-tags` pushes it).
5. **Push commit and tag together** — `git push --follow-tags`.
6. **Publish** — `npm login` and `npm publish`.

The AskClaude package in `askclaude/` is versioned and published on its own: bump `askclaude/package.json` and run `npm publish` from `askclaude/`.

## Tests

Smoke tests typically need to run outside a sandbox because they access local pi/Claude settings and auth state.

An end-to-end reproduction needs no API spend: `tests/int-compact-midreply.mjs` runs pi, the bridge and a real Claude Code against a scripted stub Messages API through `ANTHROPIC_BASE_URL`, and asserts on the request bodies CC sent.

Cover inputs the model chooses, like tool names and message shapes, not just our own branches. A test of a copy of the code is not coverage.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
