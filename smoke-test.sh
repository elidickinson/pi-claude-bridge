#!/usr/bin/env bash
# Smoke tests for pi-claude-code-acp provider.
# Requires: pi CLI, Claude Code (for ACP subprocess).
# Each test runs pi in print mode with a timeout — if the provider hangs or
# produces no output, the test fails.

set -euo pipefail
echo "=== smoke-test.sh ==="

# npm prepends node_modules/.bin to PATH, which shadows the system pi
# with the vendored pi-coding-agent (used only for types). Strip it.
PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':')

TIMEOUT=60
PASS=0
FAIL=0
DIR="$(cd "$(dirname "$0")" && pwd)"

# Kill child processes spawned by pi (ACP, node, etc.) that outlive the test.
# Uses pkill -P to target only descendants of given PIDs.
kill_descendants() {
  # Kill any remaining children of this shell
  pkill -P $$ 2>/dev/null || true
  sleep 1
}
trap kill_descendants EXIT

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
  kill_descendants
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

# AskClaude only registers when a non-acp provider is active
run "tool: AskClaude registered" \
  bash -c "pi --no-session -ne -e '$DIR' --mode json --model 'openrouter/qwen/qwen3.5-9b' -p 'list your tools' 2>&1 | grep -q AskClaude && echo ok"

# AskClaude e2e: force a non-Claude model to call the tool and check for a tool result
run "tool: AskClaude responds" \
  bash -c "pi --no-session -ne -e '$DIR' --model 'openrouter/qwen/qwen3.5-9b' --mode json \
    -p 'Use the AskClaude tool with prompt=\"What is 2+2? Reply with just the number.\" and then tell me the answer.' 2>&1 \
    | grep -q '\"toolName\":\"AskClaude\"' && echo ok"

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
