# Context windows served by the Claude Agent SDK

Measured context windows from the Claude Agent SDK (`query()`), per model id,
subscription plan, and Extra Usage (metered credits) setting.

## Method

`diag/context-size.mjs` calls the SDK for each model id × {bare, `[1m]`} with
one trivial turn and records `result.modelUsage[*].contextWindow` plus error
details. Auth is subscription OAuth (claude.ai), no `ANTHROPIC_API_KEY`.

```
node diag/context-size.mjs pro        # current tier (pro | max)
node diag/context-size.mjs --compare  # diff latest pro-* vs max-* JSON
```

Raw JSON + MD per run save to `.test-output/context-size/` (gitignored).

## Environment

- Claude Agent SDK `@anthropic-ai/claude-agent-sdk` 0.2.141 (bundled Claude Code 2.1.141)
- Auth: subscription OAuth (claude.ai), `ANTHROPIC_API_KEY` unset
- Options: `settingSources: []`, `tools: []`, `maxTurns: 1`, `persistSession: false`
- Date: 2026-06-26

The Opus 5.5 rows come from a later run, same options and auth:

- Claude Agent SDK 0.3.280 (bundled Claude Code 2.1.280)
- Plan: Max 20x, Extra Usage off — the run's rate-limit event reports
  `overageStatus: "rejected"`, `overageDisabledReason: "org_level_disabled"`
- Date: 2026-09-23

The Pro-credits-on and Pro-credits-off columns come from later runs, same
options and auth:

- Claude Agent SDK 0.3.284 (bundled Claude Code 2.1.284)
- Pro, Extra Usage enabled — rate-limit events report
  `overageStatus: "allowed"`. The saved run's filename says `max-*`; that
  label was passed by mistake and the account is Pro
  (`organizationType: "claude_pro"` in `~/.claude.json`).
- Pro, Extra Usage disabled — rate-limit events report
  `overageStatus: "rejected"`, `overageDisabledReason: "org_level_disabled"`
- Date: 2026-09-28

## Served context windows

Four conditions, each run with the probe above. Values are tokens; `1M` =
1000000, `200K` = 200000. `429`/`400` = request rejected (see
[Error shapes](#error-shapes)). One run predates full error-field capture (see
the footnote below the table).

| requested id              | Pro, credits off | Pro, credits on | Max, credits off | Max, credits on |
|---------------------------|------------------|-----------------|------------------|-----------------|
| `claude-sonnet-5-5`       | 1M               | 1M              | —                | —               |
| `claude-sonnet-5-5[1m]`  | 1M               | 1M              | —                | —               |
| `claude-opus-5-5`         | 1M               | 1M              | 1M               | —               |
| `claude-opus-5-5[1m]`    | 1M               | 1M              | 1M               | —               |
| `claude-opus-5`           | 1M               | 1M              | 200K             | —               |
| `claude-opus-5[1m]`      | 1M               | 1M              | 1M               | —               |
| `claude-opus-4-8`         | 1M§              | 200K            | 200K             | 200K            |
| `claude-opus-4-8[1m]`    | 1M               | 1M              | 1M               | 1M              |
| `claude-opus-4-7`         | 1M               | 1M              | 1M               | 1M              |
| `claude-opus-4-7[1m]`    | 1M               | 1M              | 1M               | 1M              |
| `claude-opus-4-6`         | 200K             | 200K            | 200K             | 200K            |
| `claude-opus-4-6[1m]`    | 429              | 1M              | 1M               | 1M              |
| `claude-fable-5`          | 429§             | 1M              | —                | —               |
| `claude-fable-5[1m]`     | 429§             | 1M              | —                | —               |
| `claude-sonnet-5`         | 1M§              | 1M              | —                | —               |
| `claude-sonnet-5[1m]`    | 1M               | 1M              | —                | —               |
| `claude-sonnet-4-6`       | 200K             | 200K            | 200K             | 200K            |
| `claude-sonnet-4-6[1m]`  | 429              | 1M              | 429              | 1M              |
| `claude-haiku-4-5`        | 200K             | 200K            | 200K             | 200K            |
| `claude-haiku-4-5[1m]`   | 429†             | 400             | 400              | 400             |

Raw runs: `.test-output/context-size/{pro,max}-2026-06-26T21-*.json`,
Opus 5.5 `.test-output/context-size/max-2026-09-23T13-50-08-107Z.json`,
Sonnet 5.5 `.test-output/context-size/max-2026-09-28T18-33-28-340Z.json`
(Pro credits on) and `.test-output/context-size/pro-2026-09-28T18-56-52-762Z.json`
(Pro credits off)

`—` = not yet tested in that condition. Max-credits-on matched Pro-credits-on
for every cell tested in both (shown for completeness). Opus 5.5 served 1M from
both the bare id and `[1m]` on Max with credits off (128K max output either
way), the same shape as Opus 4.7 — the suffix is not what buys the window
there. The bridge still requests `[1m]`, which is what keeps its
`MEASURED_ONE_M` entry safe on the plans below.

Measured 2026-09-28, Pro without Extra Usage: Sonnet 5.5 serves 1M from both
the bare id and `[1m]` — no credits gate, matching Anthropic's docs, so its
`MEASURED_ONE_M` entry holds on every measured plan. The same run shows
bare-1M is unconditional for the whole 4.7+ opus/sonnet generation
(opus-4-7/4-8/5/5-5, sonnet-5/5-5): bare and `[1m]` both serve 1M with credits
off, so the June Pro-credits-off bare cells of 200K for sonnet-5 and opus-4-8
are stale — a backend change, not an entitlement effect. Two exceptions:
`fable-5` is now fully credits-gated on Pro (§ below), and the 4-6 models
keep their `[1m]` credits gate (`PLAN_GATED_ONE_M` still required).

† **Inferred, not directly measured.** The Pro-credits-off run predates
error-field capture; its three rejected `[1m]` rows have no recorded HTTP status
or error text. `opus-4-6[1m]` was confirmed 429 via a separate one-off dump;
`sonnet-4-6[1m]` and `haiku-4-5[1m]` are assumed the same by analogy.

§ **Changed 2026-09-28 (Pro credits off, SDK 0.3.284).** `fable-5` went from
serving (bare 200K, `[1m]` 1M in June) to rejecting both variants with 429
"Fable 5 requires usage credits" — a model-level gate, not a long-context
one, and no fable id serves that condition at all. `sonnet-5` and `opus-4-8`
bare rose 200K → 1M. `fable-5-1` was not re-probed and is assumed to share
fable-5's gate.

## Error shapes

Rejected `[1m]` turns surface in the SDK message stream, not `result.errors[]`
(always empty). Sequence: `system:init → rate_limit_event → assistant →
result:success` — `subtype: "success"` despite `is_error: true`. Error text in
`result.result`; HTTP status in `result.api_error_status`.

### Credit-gated rejection (429) — e.g. `opus-4-6[1m]` on Pro, credits off

```json
// rate_limit_event
{ "rate_limit_info": { "status": "rejected", "overageDisabledReason": "org_level_disabled", "isUsingOverage": false } }

// assistant (synthetic)
{ "error": "rate_limit", "message": { "model": "<synthetic>", "stop_reason": "stop_sequence",
  "content": [{ "type": "text", "text": "Usage credits are required for long context requests." }] } }

// result
{ "subtype": "success", "is_error": true, "api_error_status": 429,
  "result": "Usage credits are required for long context requests.", "modelUsage": {}, "total_cost_usd": 0 }
```

A third message shares this shape — `"You're out of extra usage. Add more at
claude.ai/settings/usage and keep going."` (400) — but is *not* a long-context
entitlement failure: it fires intermittently on models otherwise served 1M, and
Max serves 1M with credits off. See [EXTRA-USAGE-400.md](./EXTRA-USAGE-400.md).

### Capability rejection (400) — e.g. `haiku-4-5[1m]` (not 1M-capable)

Same shape, `api_error_status: 400`, no `rate_limit_event`. Text varies:

- Pro, credits on: `"This authentication style is incompatible with the long context beta header."`
- Max (either): `"The long context beta is not yet available for this subscription."`

### Served turn — e.g. `opus-4-8[1m]` → 1M

```json
{ "subtype": "success", "is_error": false, "stop_reason": "end_turn",
  "modelUsage": { "claude-opus-4-8[1m]": { "contextWindow": 1000000, "maxOutputTokens": 32000,
    "inputTokens": 173, "outputTokens": 4, "costUSD": 0.000579 } } }
```

Allowed turns carry `rate_limit_event.status: "allowed"` plus `overageStatus` /
`resetsAt` / `rateLimitType: "five_hour"`. Rejected turns fail fast (~130–400 ms,
zero model tokens).

## Findings

1. **The `[1m]` suffix is the only reliable way to request 1M via the SDK.**
   Bare model ids serve 200K (except the anomalous `opus-4-7`). The interactive
   Claude Code CLI auto-selects `[1m]` for Opus on Max/Team/Enterprise, but the
   SDK does not.
2. **`opus-4-7` bare serves 1M everywhere** — stable across runs. Unexplained.
3. **The subscription/OAuth path differs from the public API.** Anthropic's docs
   say Opus 4.8/4.7 default to 1M on the API with no beta header; subscription
   SDK serves 200K for a bare 4.8 id.
