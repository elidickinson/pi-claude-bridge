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

## Served context windows

Four conditions, each run with the probe above. Values are tokens; `1M` =
1000000, `200K` = 200000. `429`/`400` = request rejected (see
[Error shapes](#error-shapes)). One run predates full error-field capture (see
the footnote below the table).

| requested id              | Pro, credits off | Pro, credits on | Max, credits off | Max, credits on |
|---------------------------|------------------|-----------------|------------------|-----------------|
| `claude-opus-5-5[1m]`    | —                | —               | —                | —               |
| `claude-opus-5`           | —                | —               | 200K             | —               |
| `claude-opus-5[1m]`      | —                | —               | 1M               | —               |
| `claude-opus-4-8`         | 200K             | 200K            | 200K             | 200K            |
| `claude-opus-4-8[1m]`    | 1M               | 1M              | 1M               | 1M              |
| `claude-opus-4-7`         | 1M               | 1M              | 1M               | 1M              |
| `claude-opus-4-7[1m]`    | 1M               | 1M              | 1M               | 1M              |
| `claude-opus-4-6`         | 200K             | 200K            | 200K             | 200K            |
| `claude-opus-4-6[1m]`    | 429              | 1M              | 1M               | 1M              |
| `claude-fable-5`          | 200K             | —               | —                | —               |
| `claude-fable-5[1m]`     | 1M               | —               | —                | —               |
| `claude-sonnet-5`         | 200K             | —               | —                | —               |
| `claude-sonnet-5[1m]`    | 1M               | —               | —                | —               |
| `claude-sonnet-4-6`       | 200K             | 200K            | 200K             | 200K            |
| `claude-sonnet-4-6[1m]`  | 429              | 1M              | 429              | 1M              |
| `claude-haiku-4-5`        | 200K             | 200K            | 200K             | 200K            |
| `claude-haiku-4-5[1m]`   | 429†             | 400             | 400              | 400             |

Raw runs: `.test-output/context-size/{pro,max}-2026-06-26T21-*.json`

`—` = not yet tested in that condition. Max-credits-on matched Pro-credits-on
for every cell tested in both (shown for completeness). Opus 5.5 is enabled at
1M in the bridge based on [Anthropic's documentation](https://code.claude.com/docs/en/model-config#extended-context)
for Opus 4.7 and later (1M by default on the Anthropic API, including Pro),
**not an SDK subscription/OAuth measurement**. The bridge requests `[1m]` to
match the measured SDK behavior of earlier models; Opus 5.5's `[1m]` behavior
on Pro remains to be tested.

† **Inferred, not directly measured.** The Pro-credits-off run predates
error-field capture; its three rejected `[1m]` rows have no recorded HTTP status
or error text. `opus-4-6[1m]` was confirmed 429 via a separate one-off dump;
`sonnet-4-6[1m]` and `haiku-4-5[1m]` are assumed the same by analogy.

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
