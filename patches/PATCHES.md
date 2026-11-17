# Local patches

This fork carries changes that are not in upstream `elidickinson/pi-claude-bridge` yet.
The `sync-upstream-patches` skill reads and updates this file. Keep one row per patch.

Upstream: `https://github.com/elidickinson/pi-claude-bridge`
Last check: 2026-11-17 (upstream `main` at release 0.13.0)

## Patches

| Patch file | Upstream PR | Issue | PR state | PR head SHA | Local commit | Status |
|---|---|---|---|---|---|---|
| `pr240.patch` | #240 | - | open | `9b93a008f17977994ec4eb09810df3188b8b6f7b` | `c54cc5f` | applied, same as PR |
| `pr258.patch` | #258 | #253 | open | `25d023217d5277cc2a9729ea6b9de757c0edf638` | `c3b4461` | applied, same as PR |
| `file-mentions.patch` | none | - | - | - | `6c37851` | local only, no upstream PR |
| `omp.patch` | none | #232 | - | - | `3aa5675` | superseded, `string[]` join kept |

### Notes

- `omp.patch`: upstream 0.13.0 (#262) removed `src/prompt-capture.ts`. The advisor
  capture and the `string[]` capture keys are obsolete. The `string[]` join is still
  needed. It now lives in `toBridgeContext` (`src/transcript.ts`). Keep the file for
  history only.

## Watched omp items

Open upstream issues and PRs about oh-my-pi (omp) that are not applied here.

| Item | State | Relevance | Decision |
|---|---|---|---|
| #195 / PR #197 | open | A rate-limited turn keeps the `<synthetic>` text, so omp does not walk `retry.fallbackChains`. | Not applied. Apply if omp fallback on usage limit is needed. |
| PR #217 | open | omp shim lacked `contentText` and `formatSkillsForPrompt`. | Obsolete. The bridge no longer imports them. omp 18.22 exports `getSystemMessageText`, `getCurrentSystemMessage`, `getCurrentTools`. |
| #232 | open | Prompt capture threw on omp `string[]` prompts. | Capture removed upstream. The `string[]` join is fixed locally. |

Closed omp items (no action): #63, #67, #114, #115, #222.
