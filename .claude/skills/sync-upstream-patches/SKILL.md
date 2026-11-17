---
name: sync-upstream-patches
description: Check the upstream PRs behind this fork's local patches (patches/*.patch, listed in patches/PATCHES.md) for new commits, merges or closes, and update the local code to match. Also scan upstream issues and PRs about oh-my-pi (omp) for new relevant items. Use when the user asks to sync, refresh or check the local patches, the upstream PRs, or omp compatibility.
---

# Sync local patches with upstream PRs

This fork (`origin` = `navidagz/pi-claude-bridge`) carries patches from open PRs on
upstream `elidickinson/pi-claude-bridge`. `patches/PATCHES.md` is the state file. It
lists each patch, its PR, the PR head SHA at the last check, and the local commit.

## Rules

- Do not run tests. Write or edit tests, then tell the user which tests to run.
- Do not push. Commit only. Tell the user to push.
- Use Conventional Commits, one commit for each logical change.
- Follow `AGENTS.md` for `CHANGELOG.md` entries.
- Verify with typecheck only: `node node_modules/typescript/lib/tsc.js --noEmit -p .`.
  An error in `askclaude/src/index.ts` (`keyHint`) existed before. Ignore it.
- If `gh` fails (auth, network), stop and tell the user. Do not loop.

## Step 1: Read the state

Read `patches/PATCHES.md`. Get the rows of the patch table and the watched items.

## Step 2: Check each upstream PR

For each row with a PR number, run:

```bash
R=elidickinson/pi-claude-bridge
gh pr view <N> -R $R --json state,mergedAt,mergeCommit,headRefOid,updatedAt,commits,comments,reviews
```

Then choose one case:

| Case | Sign | Action |
|---|---|---|
| Unchanged | `state` is `OPEN` and `headRefOid` equals the SHA in the table | No code change. Update "Last check". |
| Updated | `state` is `OPEN` and `headRefOid` differs | Go to step 3. |
| Merged | `state` is `MERGED` | Go to step 4. |
| Closed | `state` is `CLOSED`, `mergedAt` is null | Read the last comments and reviews. Report why it closed. Ask the user to keep or drop the local commit. |

Also read new comments and reviews since the last check. Report any requested changes.

## Step 3: A PR got new commits

1. Get the current diff: `gh pr diff <N> -R $R > /tmp/claude-0/pr<N>.diff`.
2. Compare only the changed lines with the stored patch. Ignore context and index lines:

   ```bash
   diff <(grep -E '^[+-]' patches/pr<N>.patch | grep -vE '^(\+\+\+|---)') \
        <(grep -E '^[+-]' /tmp/claude-0/pr<N>.diff | grep -vE '^(\+\+\+|---)')
   ```

3. If only a merge from `main` changed, the content is the same. Update the SHA only.
4. If the content changed, apply the difference to the local code by hand. Use the
   Edit tool. Upstream code may have moved, so `git apply` often fails. Keep the PR's
   intent, not its line numbers.
5. Replace `patches/pr<N>.patch` with the new diff.
6. Commit: `fix(<scope>): sync with upstream PR #<N>`. Put the changed behavior in the body.
7. Update the row: new head SHA, new local commit.

## Step 4: A PR got merged

1. Add the upstream remote if it is missing, then fetch:

   ```bash
   git remote get-url upstream 2>/dev/null || git remote add upstream https://github.com/elidickinson/pi-claude-bridge.git
   git fetch upstream main --tags
   ```

2. Check if the merge commit is in `upstream/main`: `git merge-base --is-ancestor <mergeCommit> upstream/main`.
3. Do not merge or rebase on your own. Tell the user that the next upstream sync will
   bring in the merged code. Tell them which local commit will then conflict or become
   empty. When they merge upstream, keep the upstream version of that code.
4. After the user syncs upstream, move the row to "Merged" in the notes, and delete
   the patch file. Remove any `UNRELEASED` changelog line that upstream already has.

## Step 5: Scan omp issues and PRs

```bash
R=elidickinson/pi-claude-bridge
for q in omp oh-my-pi "oh my pi"; do
  gh search issues "$q" -R $R --include-prs --limit 50 \
    --json number,title,state,isPullRequest,updatedAt \
    -q '.[]|"\(.number)\t\(.state)\t\(if .isPullRequest then "PR" else "issue" end)\t\(.updatedAt[:10])\t\(.title)"'
done | sort -u -t$'\t' -k1,1n
```

For each item that is not in `patches/PATCHES.md`, or that changed state:

1. Read it: `gh issue view <N> -R $R --json body,comments` (or `gh pr view` and `gh pr diff`).
2. Check the current code. Is the bug still there? Use `grep` on `src/`.
3. If needed, check the installed omp. It is at
   `/root/.bun/install/global/node_modules/@oh-my-pi/` (`pi-ai/src`, `pi-coding-agent/src`).
   Run `omp --version` for the version. omp passes its own `Context` to pi providers
   (`systemPrompt: string[]`, `developer`-role messages).
4. Add a row to "Watched omp items" with a decision. Do not apply an open PR unless
   the user says so.

## Step 6: Update the state and report

1. Update `patches/PATCHES.md`: "Last check" date, SHAs, states, decisions.
2. Report to the user in one table: patch, PR, old state, new state, action taken.
3. List the new omp items and your recommendation for each.
4. List the commits you made, and the tests to run.
