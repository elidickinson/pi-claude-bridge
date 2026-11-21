# Fork inventory

Fork: `ricardofelixb/pi-claude-bridge`; upstream: `elidickinson/pi-claude-bridge`
(remote `upstream`). Fork code belongs in `src/fork/`; tests use `unit-fork-*.mjs`
so upstream's `test:unit` glob runs them too. Do not install this worktree in pi.

## 1. Continue at a tool result — top upstream candidate (#274)

- Kind: generally useful bug fix; upstream issue #274, fork PR #6 (`0e9ff15`).
  Upstream has not fixed it. Upstreaming this removes several hooks; no upstream
  PR is authorized by this job. Multiple single-line hooks in `src/index.ts` are
  explicitly approved because session selection, input, output and child env
  must agree on whether Claude Code resumes the interrupted turn itself.
- Current implementation: `src/index.ts`, `src/query-state.ts`; extraction into
  `src/fork/` follows the account extraction, before merging upstream.
- Setting: automatic only for continuations ending at a tool result; ordinary
  user prompts keep upstream behavior. Uses child-only
  `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`, `CLAUDE_CODE_RESUME_PROMPT` and
  `CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS`; 30s no-output fallback.
- Tests: `tests/unit-orphan-result-after-restart.mjs`,
  `tests/unit-sync-shared-session.mjs`, `tests/unit-query-lifecycle.mjs`.

## 2. Per-project Claude account

- Kind: generally useful opt-in feature; upstream candidate after #274.
- Implementation: `src/fork/config.ts`, `src/fork/account.ts` (`applyAccount`).
- Hooks: `src/config.ts` imports `withProjectAccount, type AccountProvider`;
  `Config.provider` intersects `AccountProvider`; `loadConfig(cwd = process.cwd())`
  returns `withProjectAccount({ askClaude: global.askClaude, provider: { ...global.provider } }, cwd, tryParseJson)`.
  `src/index.ts` calls `registerAccount(pi, providerSettings)`.
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
  in `tests/unit-sync-shared-session.mjs` (fork commit `d63fcbb`).
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
- No fork account code depends on `prompt-capture.ts` or `agents-md.ts`.
