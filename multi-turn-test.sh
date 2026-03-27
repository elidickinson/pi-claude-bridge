#!/usr/bin/env bash
# Multi-turn integration tests for pi-claude-code-acp provider.
# Verifies tool use and multi-turn context via --mode json output.
# Requires: pi CLI, Claude Code (for ACP subprocess), jq.

set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "jq is required but not installed"; exit 1; }

# npm prepends node_modules/.bin to PATH, which shadows the system pi
# with the vendored pi-coding-agent (used only for types). Strip it.
PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':')

TIMEOUT=180
PASS=0
FAIL=0
DIR="$(cd "$(dirname "$0")" && pwd)"
EXPECTED_VERSION=$(jq -r .version "$DIR/package.json")
LOGDIR="$DIR/.test-output"
mkdir -p "$LOGDIR"

kill_descendants() {
  pkill -P $$ 2>/dev/null || true
  sleep 1
}
trap kill_descendants EXIT

run_json() {
  local name="$1"; shift
  local assertion="$1"; shift
  local slug=$(echo "$name" | tr ' :,' '-' | tr -cd '[:alnum:]-')
  local logfile="$LOGDIR/$slug.ndjson"
  printf "%-50s " "$name"
  if timeout "$TIMEOUT" "$@" > "$logfile" 2>&1; then
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

run_json "multi-turn: tool use, context, history" \
  '([.[] | select(.type == "toolcall_end")] | length) >= 2 and
   ([.[] | select(.type == "done")] | length) >= 3 and
   ([.[] | select(.type == "text_end") | .content] | join(" ") | test("'"$EXPECTED_VERSION"'")) and
   ([.[] | select(.type == "text_end") | .content] | join(" ") | test("banana"))' \
  pi --no-session -ne -e "$DIR" \
  --model "claude-code-acp/claude-sonnet-4-6" \
  --mode json \
  -p "The secret word is 'banana'. Read package.json and tell me the version. Be brief." \
     "Now read README.md and tell me the first heading. Be brief." \
     "What was the secret word I told you earlier? Reply with just the word."

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
