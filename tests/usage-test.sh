#!/usr/bin/env bash
# Usage accounting test for pi-claude-bridge.
# Snapshots Claude subscription usage before and after a conversation,
# then compares the delta against reported token metrics.
#
# This is a one-off diagnostic test, not part of the regular suite.
# Requires: Claude Code OAuth credentials in macOS keychain.
# Rate limit: the usage endpoint is aggressively limited — don't run repeatedly.

set -euo pipefail
echo "=== usage-test.sh ==="

PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':')

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="$DIR/.test-output"
LOGFILE="$LOGDIR/usage-test.ndjson"
mkdir -p "$LOGDIR"

kill_descendants() { pkill -P $$ 2>/dev/null || true; sleep 1; }
trap kill_descendants EXIT

# --- OAuth token from keychain ---

TOKEN=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" 2>/dev/null) \
  || { echo "FAIL: Could not extract OAuth token from keychain"; exit 1; }

get_usage() {
  curl -sf \
    -H "Authorization: Bearer $TOKEN" \
    -H "anthropic-beta: oauth-2025-04-20" \
    "https://api.anthropic.com/api/oauth/usage"
}

# --- Snapshot usage before ---

echo "Fetching usage before test..."
BEFORE=$(get_usage) || { echo "FAIL: Could not fetch usage (rate limited?)"; exit 1; }
BEFORE_5H=$(echo "$BEFORE" | python3 -c "import sys,json; print(json.load(sys.stdin)['five_hour']['utilization'])")
BEFORE_7D=$(echo "$BEFORE" | python3 -c "import sys,json; print(json.load(sys.stdin)['seven_day']['utilization'])")
echo "  5h: ${BEFORE_5H}%  7d: ${BEFORE_7D}%"

# --- Run a conversation ---

TMPFILE="$LOGDIR/usage-test-scratch.txt"
rm -f "$TMPFILE"

echo ""
echo "Running 5-turn conversation with tool use..."
timeout 180 pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-haiku-4-5" \
  --mode json \
  -p "The secret number is 42. Acknowledge briefly." \
     "Write the secret number to $TMPFILE. Just the number, nothing else." \
     "What is 42 * 2? Just the number." \
     "Read $TMPFILE and tell me what's in it." \
     "What was the secret number, what did you write, what did you read, and what was 42*2? One per line." \
  > "$LOGFILE" 2>"$LOGFILE.err"

rm -f "$TMPFILE"

# --- Extract token metrics ---

echo ""
echo "Turn-by-turn token metrics:"
echo "---"
printf "%-6s  %8s  %8s  %8s  %8s  %10s\n" "Turn" "Input" "CacheRd" "CacheWr" "Output" "Cost"

TOTAL_INPUT=0
TOTAL_CACHE_READ=0
TOTAL_CACHE_WRITE=0
TOTAL_OUTPUT=0
TOTAL_COST="0"
TURN=0

while IFS= read -r line; do
  TURN=$((TURN + 1))
  INPUT=$(echo "$line" | jq -r '.input')
  CACHE_READ=$(echo "$line" | jq -r '.cacheRead')
  CACHE_WRITE=$(echo "$line" | jq -r '.cacheWrite')
  OUTPUT=$(echo "$line" | jq -r '.output')
  COST=$(echo "$line" | jq -r '.cost.total // 0')

  printf "%-6s  %8s  %8s  %8s  %8s  \$%s\n" "$TURN" "$INPUT" "$CACHE_READ" "$CACHE_WRITE" "$OUTPUT" "$COST"

  TOTAL_INPUT=$((TOTAL_INPUT + INPUT))
  TOTAL_CACHE_READ=$((TOTAL_CACHE_READ + CACHE_READ))
  TOTAL_CACHE_WRITE=$((TOTAL_CACHE_WRITE + CACHE_WRITE))
  TOTAL_OUTPUT=$((TOTAL_OUTPUT + OUTPUT))
  TOTAL_COST=$(python3 -c "print($TOTAL_COST + $COST)")
done < <(jq -c 'select(.type == "turn_end") | .message.usage | {input, cacheRead, cacheWrite, output, cost}' "$LOGFILE")

echo "---"
printf "%-6s  %8s  %8s  %8s  %8s  \$%s\n" "Total" "$TOTAL_INPUT" "$TOTAL_CACHE_READ" "$TOTAL_CACHE_WRITE" "$TOTAL_OUTPUT" "$TOTAL_COST"

# --- Wait and snapshot usage after ---
# Usage endpoint may lag a bit behind actual consumption

echo ""
echo "Waiting 15s for usage to settle..."
sleep 15

echo "Fetching usage after test..."
AFTER=$(get_usage) || { echo "FAIL: Could not fetch usage after test (rate limited?)"; exit 1; }
AFTER_5H=$(echo "$AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin)['five_hour']['utilization'])")
AFTER_7D=$(echo "$AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin)['seven_day']['utilization'])")
echo "  5h: ${AFTER_5H}%  7d: ${AFTER_7D}%"

DELTA_5H=$(python3 -c "print(round($AFTER_5H - $BEFORE_5H, 2))")
DELTA_7D=$(python3 -c "print(round($AFTER_7D - $BEFORE_7D, 2))")

echo ""
echo "=== Summary ==="
echo "Usage delta:  5h: +${DELTA_5H}%  7d: +${DELTA_7D}%"
echo "Token totals: input=$TOTAL_INPUT  cacheRead=$TOTAL_CACHE_READ  cacheWrite=$TOTAL_CACHE_WRITE  output=$TOTAL_OUTPUT"
echo "Reported cost: \$${TOTAL_COST}"

CACHE_HIT_TOTAL=$((TOTAL_INPUT + TOTAL_CACHE_READ + TOTAL_CACHE_WRITE))
if [ "$CACHE_HIT_TOTAL" -gt 0 ]; then
  OVERALL_HIT=$(python3 -c "print(round($TOTAL_CACHE_READ * 100 / $CACHE_HIT_TOTAL, 1))")
  echo "Overall cache hit rate: ${OVERALL_HIT}%"
fi

# Sanity check: usage shouldn't have jumped more than 5% for a tiny haiku conversation
EXCESSIVE=$(python3 -c "print('yes' if $DELTA_5H > 5 else 'no')")
if [ "$EXCESSIVE" = "yes" ]; then
  echo ""
  echo "WARNING: 5h usage jumped ${DELTA_5H}% — seems high for a small haiku conversation."
  echo "  This could indicate overhead beyond what token metrics report."
fi

echo ""
echo "Log: $LOGFILE"
