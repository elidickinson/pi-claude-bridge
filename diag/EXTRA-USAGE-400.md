# HTTP 400 "You're out of extra usage"

```
API Error: 400 You're out of extra usage. Add more at claude.ai/settings/usage and keep going.
```

Observed responses carry `invalid_request_error`, `x-should-retry: false`, and `anthropic-ratelimit-unified-overage-disabled-reason: out_of_credits`. This error alone establishes neither subscription exhaustion nor an actual charge. `diag/attrib.py` classifies occurrences in bridge logs.

## Billing policy

As checked on 2026-10-21, [Anthropic's SDK-plan policy](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) says the proposed separate SDK usage pool was paused on June 15. SDK, `claude -p`, and third-party apps can still draw from subscription limits. The October 7 addition of monthly API credits for Max and Team does not remove that access.

Documented paid-usage paths include:

- **Subscription overage:** enabled and funded [usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans) cover requests after included limits are exhausted.
- **API authentication:** [`ANTHROPIC_API_KEY` selects API billing](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan), not subscription allowance.
- **Model/context eligibility:** availability and credit requirements depend on the [model and plan](https://code.claude.com/docs/en/model-config).

Anthropic [supports custom SDK system prompts](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts) but does not document prompt-content eligibility rules or require the `claude_code` preset for subscription usage. Keep genuine SDK attribution; do not spoof `CLAUDE_CODE_ENTRYPOINT`.

## Controlled findings

### Prompt content: August 2026

Same-account, interleaved replays isolated the system prompt as the cause of a captured failure:

| system prompt | failing request's messages | passing request's messages |
| --- | --- | --- |
| inherited pi harness | 400 | 400 |
| parent prompt | 200 | 200 |

Removing the inherited pi harness changed 400 to 200; adding it to a passing request changed 200 to 400. In that captured context, bisection isolated the documentation-routing line containing lowercase `pi packages`. Moving the same harness from `system[]` into a user message also passed. These are observations about tested prompts, not a general keyword rule or proof of a particular backend classifier.

Changing explicit subagent markers, model, tools, thinking, cache settings, or SDK version did not explain the failure. Filler sweeps from 11K to 181K tokens passed. Both passing and failing SDK requests retained genuine `cc_entrypoint=sdk-ts` attribution.

Direct SDK and bridge-parent controls succeeded while Extra Usage was exhausted; the inherited-harness child failed. After projecting inherited prompts into portable context and genuine custom instructions, bridge-child controls also succeeded. These tests establish eligibility behavior, not dollar attribution.

Independent reports describe similar content-sensitive A/B results: [OpenCode auth #147](https://github.com/griffinmartin/opencode-claude-auth/issues/147) (April 8) and [pi #6888](https://github.com/earendil-works/pi/issues/6888) (July 20). Neither establishes Anthropic's routing implementation or actual charges.

### Preset omission: October 21, 2026

A live Agent SDK A/B (Pro login, Haiku 4.5) succeeded with both the `claude_code` preset and a plain custom system prompt. Both reported `status=allowed` and `isUsingOverage=false` with Extra Usage disabled (`org_level_disabled`). Omitting the preset does not itself require Extra Usage; this does not establish eligibility for arbitrary prompt content.

The [August 5 report on PR #21](https://github.com/elidickinson/pi-claude-bridge/pull/21#issuecomment-5195976655) that replace mode used Extra Usage includes no captured prompt or billing evidence. It does not establish preset omission as the cause.

## Reproduction

Capture through the real SDK path, then compare requests using the same account and model, changing only the system prompt:

```sh
node diag/capture-proxy.mjs --port 8795 --out /tmp/cc-cap
ANTHROPIC_BASE_URL=http://127.0.0.1:8795 pi --model claude-bridge/claude-opus-5
```

The proxy writes request and error captures. For exact replay, use the captured headers and body:

```sh
curl -X POST 'https://api.anthropic.com/v1/messages?beta=true' \
     -H "authorization: Bearer $TOKEN" <headers from err-NNNN.json> \
     --data-binary @req-NNNN.json
```

Interleave known-good controls to rule out account-state changes. Record rate-limit events, especially `isUsingOverage` and overage availability; SDK list-price cost estimates are not evidence of charges. Captures contain sensitive conversations and credentials and must not be shared unredacted.
