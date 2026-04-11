#!/usr/bin/env bash
# Prompt cache efficiency test for pi-claude-bridge.
# Runs a multi-turn conversation and verifies Anthropic prompt caching is working.
# Expects: cacheRead grows across turns (system prompt + history are cache-hit),
#   cacheWrite is small after the first turn (only new content is written).
#
# Also checks session sync correctness: consecutive same-provider turns must
# resume the session (Case 3), not rebuild it (Case 4). A rebuild would reset
# prompt caching. This catches the off-by-one cursor bug where pi's post-return
# assistant message append caused syncSharedSession to see 1 "missed" message.

source "$(dirname "$0")/lib/bash-setup.sh"

echo "=== cache-test.sh ==="

setup_test_env "cache-test" ".ndjson"

LOGFILE="$LOGDIR/cache-test.ndjson"

trap kill_descendants EXIT

TMPFILE="$LOGDIR/cache-test-scratch.txt"
rm -f "$TMPFILE" "$CLAUDE_BRIDGE_DEBUG_PATH"

echo "Running 5-turn conversation (text + tool use)..."
timeout 180 pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-haiku-4-5" \
  --mode json \
  -p "The secret number is 42. Acknowledge briefly." \
     "Write the secret number to $TMPFILE. Just the number, nothing else." \
     "What is 42 * 2? Just the number." \
     "Read $TMPFILE and tell me what's in it." \
     "What was the secret number, what did you write, what did you read, and what was 42*2? One per line." \
  > "$LOGFILE" 2>"$LOGFILE.err" || PI_EXIT=$?
PI_EXIT=${PI_EXIT:-0}

rm -f "$TMPFILE"

if [ -s "$LOGFILE.err" ]; then
  echo ""
  echo "pi stderr:"
  cat "$LOGFILE.err"
  echo ""
fi

if [ "$PI_EXIT" -ne 0 ]; then
  echo "FAIL: pi exited with code $PI_EXIT"
  exit 1
fi

echo ""
echo "Turn-by-turn cache metrics:"
echo "---"
printf "%-6s  %8s  %8s  %8s  %8s  %s\n" "Turn" "Input" "CacheRd" "CacheWr" "Output" "CacheHit%"

# Thresholds
MIN_CACHE_HIT_PCT=90
MIN_EXPECTED_TURNS=7    # 5 prompts + 2 tool sub-turns (write + read)
MIN_CASE3_RESUMES=2
EXPECTED_CASE1=1

TURN=0
FAIL=0
PREV_CACHE_READ=0

while IFS= read -r line; do
  TURN=$((TURN + 1))
  INPUT=$(echo "$line" | jq -r '.input')
  CACHE_READ=$(echo "$line" | jq -r '.cacheRead')
  CACHE_WRITE=$(echo "$line" | jq -r '.cacheWrite')
  OUTPUT=$(echo "$line" | jq -r '.output')
  TOTAL_INPUT=$((INPUT + CACHE_READ + CACHE_WRITE))

  if [ "$TOTAL_INPUT" -gt 0 ]; then
    HIT_PCT=$((CACHE_READ * 100 / TOTAL_INPUT))
  else
    HIT_PCT=0
  fi

  printf "%-6s  %8s  %8s  %8s  %8s  %s%%\n" "$TURN" "$INPUT" "$CACHE_READ" "$CACHE_WRITE" "$OUTPUT" "$HIT_PCT"

  # Assertions
  if [ "$TURN" -ge 3 ]; then
    # Turn 3+: cache read should be >= turn 2's (system prompt + history cached).
    # It can stay flat when the prior turn's response was short.
    if [ "$CACHE_READ" -lt "$PREV_CACHE_READ" ]; then
      echo "  FAIL: Turn $TURN cacheRead ($CACHE_READ) decreased from turn $((TURN - 1)) ($PREV_CACHE_READ)"
      FAIL=$((FAIL + 1))
    fi
    # Cache hit rate should be high
    if [ "$HIT_PCT" -lt $MIN_CACHE_HIT_PCT ]; then
      echo "  FAIL: Turn $TURN cache hit rate ${HIT_PCT}% < ${MIN_CACHE_HIT_PCT}%"
      FAIL=$((FAIL + 1))
    fi
  fi

  PREV_CACHE_READ=$CACHE_READ
done < <(jq -c 'select(.type == "turn_end") | .message.usage | {input, cacheRead, cacheWrite, output}' "$LOGFILE")

echo "---"

if [ "$TURN" -lt $MIN_EXPECTED_TURNS ]; then
  echo "FAIL: Only $TURN turns detected (expected >= $MIN_EXPECTED_TURNS with tool use sub-turns)"
  FAIL=$((FAIL + 1))
fi

# --- Assert session resume (no spurious rebuilds) ---
# With the off-by-one cursor bug, every follow-up turn triggered Case 4 (full
# rebuild) instead of Case 3 (resume), because pi appends the final assistant
# message after streamSimple returns, making the cursor lag by 1.

echo ""
echo "Session sync cases:"

CASE1_COUNT=$(grep -c "Case 1:" "$CLAUDE_BRIDGE_DEBUG_PATH" 2>/dev/null || true)
CASE1_COUNT=${CASE1_COUNT:-0}
CASE3_COUNT=$(grep -c "Case 3:" "$CLAUDE_BRIDGE_DEBUG_PATH" 2>/dev/null || true)
CASE3_COUNT=${CASE3_COUNT:-0}
CASE4_COUNT=$(grep -c "Case 4:" "$CLAUDE_BRIDGE_DEBUG_PATH" 2>/dev/null || true)
CASE4_COUNT=${CASE4_COUNT:-0}
echo "  Case 1 (clean start): $CASE1_COUNT"
echo "  Case 3 (resume):      $CASE3_COUNT"
echo "  Case 4 (rebuild):     $CASE4_COUNT"

if [ "$CASE1_COUNT" -ne $EXPECTED_CASE1 ]; then
  echo "  FAIL: Expected exactly $EXPECTED_CASE1 Case 1 (clean start), got $CASE1_COUNT"
  FAIL=$((FAIL + 1))
fi

if [ "$CASE4_COUNT" -gt 0 ]; then
  echo "  FAIL: $CASE4_COUNT spurious Case 4 rebuilds (expected 0 for consecutive same-provider turns)"
  echo "    Likely cause: off-by-one cursor — trailing assistant message misidentified as missed"
  FAIL=$((FAIL + 1))
fi

if [ "$CASE3_COUNT" -lt $MIN_CASE3_RESUMES ]; then
  echo "  FAIL: Expected at least $MIN_CASE3_RESUMES Case 3 resumes for turns 2+, got $CASE3_COUNT"
  FAIL=$((FAIL + 1))
fi

# --- Summary ---

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "PASS: Prompt caching and session resume working correctly"
else
  echo "FAIL: $FAIL assertions failed"
  echo "  Log: $LOGFILE"
  echo "  Debug: $CLAUDE_BRIDGE_DEBUG_PATH"
  exit 1
fi
