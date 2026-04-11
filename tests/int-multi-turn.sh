#!/usr/bin/env bash
# Multi-turn integration tests for pi-claude-bridge provider.
# Verifies tool use and multi-turn context via --mode json output.
# Requires: pi CLI, Claude Code (for Agent SDK subprocess), jq.

source "$(dirname "$0")/lib/bash-setup.sh"

echo "=== multi-turn-test.sh ==="

require_command jq

setup_test_env "multi-turn" ".ndjson"

TIMEOUT=180
PASS=0
FAIL=0
EXPECTED_VERSION=$(jq -r .version "$DIR/package.json")

trap kill_descendants EXIT

run_json() {
  local name="$1"; shift
  local assertion="$1"; shift
  local slug=$(echo "$name" | tr ' :,' '-' | tr -cd '[:alnum:]-')
  local logfile="$LOGDIR/$slug.ndjson"
  printf "%-50s " "$name"
  if timeout "$TIMEOUT" "$@" > "$logfile" 2>"$logfile.err"; then
    if [ ! -s "$logfile" ]; then
      echo "FAIL (empty output)"
      ((FAIL++))
    elif jq -s -e "$assertion" < "$logfile" > /dev/null 2>&1; then
      echo "PASS"
      ((PASS++))
    else
      echo "FAIL (assertion)"
      echo "  Events: $(jq -r '.type // empty' < "$logfile" 2>/dev/null | sort | uniq -c | sort -rn | head -5)"
      ((FAIL++))
    fi
  else
    echo "FAIL (exit $?)"
    [ -s "$logfile" ] && echo "  Events: $(jq -r '.type // empty' < "$logfile" 2>/dev/null | sort | uniq -c | sort -rn | head -5)"
    ((FAIL++))
  fi
  echo "  Log: $logfile"
  kill_descendants
}

# --- Tests ---
# Event types: pi --mode json wraps provider events in its own envelope.
# Top-level types: session, agent_start, agent_end, turn_start, turn_end,
#   message_start, message_end, message_update, tool_execution_start, tool_execution_end.
# Provider stream events (text_end, toolcall_end, etc.) are nested under
#   message_update.assistantMessageEvent.
# See: reference-code/pi-mono/packages/coding-agent/src/core/extensions/types.ts (AgentSessionEvent)

run_json "multi-turn: tool use, context, history" \
  '([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "toolcall_end")] | length) >= 2 and
   ([.[] | select(.type == "agent_end")] | length) >= 3 and
   ([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "text_end") | .content] | join(" ") | test("'"$EXPECTED_VERSION"'")) and
   ([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "text_end") | .content] | join(" ") | test("banana"))' \
  pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-haiku-4-5" \
  --mode json \
  -p "The secret word is 'banana'. Read package.json and tell me the version. Be brief." \
     "Now read README.md and tell me the first heading. Be brief." \
     "What was the secret word I told you earlier? Reply with just the word."

# Multiple tool calls in a single turn — the scenario that caused the deadlock
# when processAssistantMessage didn't end the stream on tool_use.
run_json "single-turn: multiple sequential tool calls" \
  '([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "toolcall_end")] | length) >= 2 and
   ([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "text_end") | .content] | join(" ") | test("pi-claude-bridge")) and
   ([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "text_end")] | length) > 0' \
  pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-haiku-4-5" \
  --mode json \
  -p "Read both package.json and README.md, then tell me the package name and the full first heading of the README."

# 3+ parallel tool calls in a single turn — exercises the chained MCP resolve
# fix that ensures all pending tool results are delivered when the model fires
# more than two tool_use blocks simultaneously.
run_json "single-turn: 3+ parallel tool calls" \
  '([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "toolcall_end")] | length) >= 3 and
   ([ .[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "text_end") ] | length) > 0 and
   ([ .[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "text_end") | .content | select(. != null and . != "") ] | length) > 0 and
   ([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "text_end") | .content] | join(" ") | test("pi-claude-bridge")) and
   ([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "text_end") | .content] | join(" ") | test("ES2022"))' \
  pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-haiku-4-5" \
  --mode json \
  -p "Read package.json, README.md, and tsconfig.json at the same time, then tell me the package name, the first heading in the README, and the TypeScript target."

# Regression: final text after multi-round tool calls was lost when the bridge
# entered the DEFERRED path and set up a callback that never fired, yielding an
# empty assistant message back to pi.
run_json "regression: final text survives multi-round tool calls" \
  '([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "toolcall_end")] | length) >= 2 and
   ([ .[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "text_end") ] | length) > 0 and
   ([ .[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "text_end") | .content | select(. != null and . != "") ] | length) > 0' \
  pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-haiku-4-5" \
  --mode json \
  -p "Read package.json and README.md, then summarize what you found in one sentence."

# Regression: extractAllToolResults traversed past assistant messages, feeding
# stale tool results from turn 1 into turn 2.  Turn 1 reads package.json (has
# "pi-claude-bridge"), turn 2 reads LICENSE (has "MIT License").  If stale
# results leak, turn 2 would see package.json content instead of LICENSE content.
run_json "regression: turn 2 tool results not stale from turn 1" \
  '([.[] | select(.type == "agent_end")] | length) >= 2 and
   ([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "toolcall_end")] | length) >= 2 and
   ([.[] | select(.type == "message_update") | .assistantMessageEvent | select(.type == "text_end") | .content] | join(" ") | test("[Mm][Ii][Tt]"))' \
  pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-haiku-4-5" \
  --mode json \
  -p "Read package.json and tell me the package name. Be brief, just the name." \
     "Now read LICENSE and tell me what type of license it is. Be brief, just the license type."

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
