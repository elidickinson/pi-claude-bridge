#!/usr/bin/env bash
# Smoke tests for pi-claude-bridge provider.
# Requires: pi CLI, Claude Code (for Agent SDK subprocess).
# Requires: CLAUDE_BRIDGE_TESTING_ALT_PROVIDER / CLAUDE_BRIDGE_TESTING_ALT_MODEL

source "$(dirname "$0")/lib/bash-setup.sh"

echo "=== smoke-test.sh ==="

setup_test_env "smoke-test"

ALT_PROVIDER=$(require_env CLAUDE_BRIDGE_TESTING_ALT_PROVIDER)
ALT_MODEL=$(require_env CLAUDE_BRIDGE_TESTING_ALT_MODEL)

TIMEOUT=60
PASS=0
FAIL=0

TEST_CWD_PREFIX="$LOGDIR/smoke-cwd."
TEST_CWD=$(mktemp -d "$TEST_CWD_PREFIX"XXXXXX)
cd "$TEST_CWD"
cleanup() {
  if [[ "${TEST_CWD:-}" == "$TEST_CWD_PREFIX"* && ${#TEST_CWD} -gt ${#TEST_CWD_PREFIX} && -d "$TEST_CWD" ]]; then
    rm -rf -- "$TEST_CWD"
  fi
  kill_descendants
}
trap cleanup EXIT

run() {
  local name="$1"; shift
  local slug=$(echo "$name" | tr ' :,' '-' | tr -cd '[:alnum:]-')
  local logfile="$LOGDIR/$slug.log"
  printf "%-50s " "$name"
  if output=$(timeout "$TIMEOUT" "$@" 2>&1); then
    echo "$output" > "$logfile"
    if [ -n "$output" ]; then
      echo "PASS"
      ((++PASS))
    else
      echo "FAIL (empty output)"
      echo "  Log: $logfile"
      ((++FAIL))
    fi
  else
    local rc=$?
    echo "${output:-}" > "$logfile" 2>/dev/null || true
    echo "FAIL (exit $rc)"
    echo "  Log: $logfile"
    ((++FAIL))
  fi
  kill_descendants
}

# --- Tests ---

run "provider: print mode responds" \
  pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-sonnet-4-6" \
  -p "Reply with just the word 'yes'"

# findInitialModel takes its CLI branch on `cliProvider && cliModel`, so --provider
# on its own is a no-op: pi falls through to the global settings default and the
# test passes or fails on whichever model that happens to be. Assert the model that
# actually answered, not merely that something did.
run "provider: --provider + --model resolve to the bridge" \
  bash -c "pi --no-session -ne -e '$DIR' --provider claude-bridge --model claude-haiku-5-5 --mode json \
    -p \"Reply with just the word 'yes'\" 2>/dev/null \
    | jq -r 'select(.message.role==\"assistant\") | .message.provider + \"/\" + .message.model' \
    | sort -u | grep -x 'claude-bridge/claude-haiku-5-5'"

run "provider: model list includes provider" \
  bash -c "pi --no-session -ne -e '$DIR' --list-models 2>&1 | grep claude-bridge"

# The bridge forwards pi's whole system prompt, so --append-system-prompt reaches
# Claude as pi's addendum section. Verify it isn't dropped.
run "system prompt: --append-system-prompt reaches Claude" \
  bash -c "pi --no-session -ne -e '$DIR' --model 'claude-bridge/claude-haiku-5-5' \
    --append-system-prompt 'You must end every response with the exact word BANANA.' \
    -p 'What is 2+2? Answer in one short sentence.' 2>&1 | grep -q BANANA && echo ok"

run "system prompt: --system-prompt reaches Claude" \
  bash -c "pi --no-session -ne -e '$DIR' --model 'claude-bridge/claude-haiku-5-5' \
    --system-prompt 'You are a pirate. You must end every response with the exact word ARRR.' \
    -p 'What is 2+2? Answer in one short sentence.' 2>&1 | grep -q ARRR && echo ok"

# AskClaude refuses to run when claude-bridge is the active provider, so use another.
#
# This covers registration too: `"toolName":"AskClaude"` appears only in tool
# execution events, so a match proves pi dispatched a call to a registered tool.
# The prompt names the tool, but the grep keys off the JSON field rather than the
# bare name, so the user message --mode json echoes back cannot false-positive.
# A separate "is it registered" check by asking the model to enumerate its tools
# was dropped as both weaker and flaky — models summarise and omit custom tools.
run "tool: AskClaude responds" \
  bash -c "pi --no-session -ne -e '$DIR' -e '$DIR/askclaude' --provider '$ALT_PROVIDER' --model '$ALT_MODEL' --mode json \
    -p 'Use the AskClaude tool with prompt=\"What is 2+2? Reply with just the number.\" and then tell me the answer.' 2>&1 \
    | grep -q '\"toolName\":\"AskClaude\"' && echo ok"

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
