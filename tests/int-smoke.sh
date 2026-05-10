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

trap kill_descendants EXIT

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

run "provider: --provider flag works" \
  pi --no-session -ne -e "$DIR" \
  --provider claude-bridge \
  -p "Reply with just the word 'yes'"

run "provider: model list includes provider" \
  bash -c "pi --no-session -ne -e '$DIR' --list-models 2>&1 | grep claude-bridge"

# AskClaude only registers when a non-claude-bridge provider is active
run "tool: AskClaude registered" \
  bash -c "pi --no-session -ne -e '$DIR' --mode json --provider '$ALT_PROVIDER' --model '$ALT_MODEL' -p 'list your tools' 2>&1 | grep -q AskClaude && echo ok"

# AskClaude e2e: force a non-Claude model to call the tool and check for a tool result
run "tool: AskClaude responds" \
  bash -c "pi --no-session -ne -e '$DIR' --provider '$ALT_PROVIDER' --model '$ALT_MODEL' --mode json \
    -p 'Use the AskClaude tool with prompt=\"What is 2+2? Reply with just the number.\" and then tell me the answer.' 2>&1 \
    | grep -q '\"toolName\":\"AskClaude\"' && echo ok"

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
