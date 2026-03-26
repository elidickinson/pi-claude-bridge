#!/usr/bin/env bash
# Smoke tests for pi-claude-code-acp provider.
# Requires: pi CLI, Claude Code (for ACP subprocess).
# Each test runs pi in print mode with a timeout — if the provider hangs or
# produces no output, the test fails.

set -euo pipefail

TIMEOUT=60
PASS=0
FAIL=0
DIR="$(cd "$(dirname "$0")" && pwd)"

# Clean up any leftover ACP processes from prior runs
pkill -f "claude-agent-acp" 2>/dev/null || true
sleep 1

run() {
  local name="$1"; shift
  printf "%-50s " "$name"
  if output=$(timeout "$TIMEOUT" "$@" 2>&1); then
    if [ -n "$output" ]; then
      echo "PASS"
      ((PASS++))
    else
      echo "FAIL (empty output)"
      ((FAIL++))
    fi
  else
    echo "FAIL (exit $?)"
    ((FAIL++))
  fi
  # Let ACP subprocess exit cleanly between tests
  pkill -f "claude-agent-acp" 2>/dev/null || true
  sleep 1
}

# --- Tests ---

run "provider: print mode responds" \
  pi --no-session -ne -e "$DIR" \
  --model "claude-code-acp/claude-sonnet-4-6" \
  -p "Reply with just the word 'yes'"

run "provider: --provider flag works" \
  pi --no-session -ne -e "$DIR" \
  --provider claude-code-acp \
  -p "Reply with just the word 'yes'"

run "provider: model list includes provider" \
  bash -c "pi --no-session -ne -e '$DIR' --list-models 2>&1 | grep claude-code-acp"

run "tool: AskClaude registered" \
  bash -c "pi --no-session -ne -e '$DIR' --mode json -p 'list your tools' 2>&1 | grep -q AskClaude && echo ok"

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
