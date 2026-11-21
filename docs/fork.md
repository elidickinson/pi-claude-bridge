# Fork inventory

Fork: `ricardofelixb/pi-claude-bridge`; upstream: `elidickinson/pi-claude-bridge`
(remote `upstream`). Fork code belongs in `src/fork/`; tests use `unit-fork-*.mjs`
so upstream's `test:unit` glob runs them too. Do not install this worktree in pi.

## 1. Continue at a tool result — top upstream candidate (#274)

- Kind: generally useful bug fix; upstream issue #274, fork PR #6 (`0e9ff15`).
  Upstream `5ea9bb8` (0.13.0) has not fixed it. Upstreaming this removes several hooks; no upstream
  PR is authorized by this job. Multiple single-line hooks in `src/index.ts` are
  explicitly approved because session selection, input, output and child env
  must agree on whether Claude Code resumes the interrupted turn itself.
- Implementation: `src/fork/continuation.ts`, re-exported by `src/fork/index.ts`.
  Upstream `src/query-state.ts` is restored exactly: output tracking uses a
  fork-owned weak set, so completed queries are not retained.
- All hook/wiring lines in `src/index.ts` (line numbers refreshed after merge):
  - L23: the single `./fork/index.js` import (shared with account registration).
  - L572: optional `continuation = false` parameter on `syncSharedSession`.
  - L594: `let row` instead of `const row` allows the policy hook to select it.
  - L600: `row = continuationSyncRow(row, compared.cutCount, continuation);`
  - L1062: `observeContinuationOutput(message, c);`
  - L1893: `let { promptBlocks, promptText, continuation } = prepareContinuationPrompt(context.messages, historyRewritten, unparkedToolResult, extractUserPromptBlocks, extractUserPrompt);`
  - L1894: `syncSharedSession(..., continuation.active)` passes the decision.
  - L1930–1935: `const pushPrompt = () => { ... };` wraps upstream's unchanged
    initial-record/push statements; it contains no fork policy.
  - L1936: `pushContinuationPrompt(queryCtx, continuation, pushPrompt);`
  - L1969: `continuationPromptEnv(options?.env, continuation)` supplies trace env.
  - L1974: `env: continuationChildEnv(childEnv, continuation)` sets launch env.
  Each policy hook is a one-line call; the other lines only carry its values.
- Setting: automatic only for continuations ending at a tool result; ordinary
  user prompts keep upstream behavior. Uses child-only
  `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, `CLAUDE_CODE_RESUME_PROMPT` and
  `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS`; 30s no-output fallback.
- Fork test: `tests/unit-fork-session-sync.mjs` (#274 prefix-write regression).
  End-to-end provider mocks: `tests/unit-orphan-result-after-restart.mjs`
  (restart, rewrite, 30s fallback, ordinary env) and
  `tests/unit-query-lifecycle.mjs` (discard, reload, termination).
  Their existing fake SDKs understand interrupted-turn resume; no paid calls.

## 2. Per-project Claude account

- Kind: generally useful opt-in feature; upstream candidate after #274.
- Implementation: `src/fork/config.ts`, `src/fork/account.ts` (`applyAccount`).
- Hooks: `src/config.ts:11` imports `withProjectAccount, type AccountProvider`;
  `src/config.ts:17` intersects `Config.provider` with `AccountProvider`;
  `src/config.ts:57` accepts `loadConfig(cwd = process.cwd())`;
  `src/config.ts:67` returns
  `withProjectAccount({ askClaude: global.askClaude, provider }, cwd, tryParseJson)`
  after upstream's `systemPromptPreset` normalization.
  `src/index.ts:23` imports the shared fork barrel and `src/index.ts:2206`
  calls `registerAccount(pi, providerSettings)`.
- Setting: `provider.account`, global or project `.pi/claude-bridge.json`;
  project account overrides global account, no other project provider settings
  are trusted. Unset keeps the original Claude Code login. Missing named login
  fails closed instead of falling back to a different subscription.
- Fork tests: `tests/unit-fork-config.mjs`, `tests/unit-fork-account.mjs`.

## 3. /claude-account

- Kind: generally useful opt-in command; upstream candidate with account config.
- Implementation: `src/fork/account.ts`: switch/default, sign in via link and
  pasted code, confirm before creating a login, confirm sign out, reload.
- Hook: same `src/index.ts` import and `registerAccount(pi, providerSettings)`
  registration as account activation; no inline account policy remains there.
- Setting: writes only project `provider.account`; local git exclude protects
  the choice. Never changes executable or billing settings from project config.
- Fork test: `tests/unit-fork-account.mjs`; existing command-registration stubs
  in upstream test harnesses remain necessary.

## 4. Shortened history (#77): upstream-owned implementation

- Kind: regression originally fixed by fork; replaced by upstream digest sync
  (`b151768`, `10e61df`). No duplicate fork implementation or production hook.
- Setting: none; edited/shortened pi history is imported into a fresh transcript.
- Fork regression: "imports a compressed history instead of starting with none"
  in `tests/unit-fork-session-sync.mjs` (moved from fork commit `d63fcbb`).
- Upstream candidate: none; already upstream. Keep the fork regression.

## 5. CI on branch pushes

- Kind: fork infrastructure preference, already isolated in
  `.github/workflows/fork-ci.yml`; upstream `ci.yml` is untouched.
- Hook: none. Trigger: `push`, excluding `main`, plus `workflow_dispatch`.
- Setting: workflow triggers only; runs `npm ci` and `npm run test:unit`.
- Test: run those exact commands locally; no Claude credentials/calls needed.
- Upstream candidate: no (fork's GitHub event behavior).

## 6. Unreleased fork changelog

- Kind: fork release metadata. `CHANGELOG.md` keeps an `UNRELEASED` section for
  account and fork maintenance notes above upstream's released sections.
- Hook / setting: none. Test: inspect the header after each release merge.
- Upstream candidate: account feature note only if that feature is accepted.

## Quick checks and sync procedure

- `npm ci`
- Scoped unit checks: `node --import tsx --import ./tests/lib/setup.mjs --test tests/unit-fork-*.mjs`
  and the relevant `tests/unit-*.mjs` suites for changed modules.
- CI unit command: `npm run test:unit`. Do **not** run `npm test` here: it also
  runs paid Claude live/integration tests. No known flaky unit tests.
- Typecheck: `npm run typecheck` (CI/conductor whole-project gate); implementer
  checks stay scoped per job instructions.
- Fetch both remotes and confirm origin/main is included before restructuring;
  this sync starts at `0e9ff15` (includes PR #6), not `1a08061`.
- Commit extractions before `git merge --no-ff upstream/main`. Keep upstream
  code in conflicts and reattach these hooks; rerere is enabled. Walk every
  entry's hook, setting and regression test after merging.
- Post-merge audit at upstream `5ea9bb8`: all six entries above retain their
  hooks, settings and tests; #77 remains upstream-owned. Upstream's whole-prompt
  forwarding, preset normalization, rejected-tool-call handling and Mythos model
  changes are retained. Neither fork module depends on deleted
  `src/prompt-capture.ts` or `src/agents-md.ts`.
- Deleted fork test `tests/unit-prompt-capture-turn-failure.mjs` imported
  `__capture` from `src/prompt-capture.ts`. Its capture-failure path no longer
  exists in 0.13.0, so the test was retired with the module, not reimplemented.
  `tests/unit-system-prompt-provider.mjs` covers the new forwarding behavior;
  `tests/unit-cc-rejected-tool-call.mjs` retains rejection/failure coverage.
