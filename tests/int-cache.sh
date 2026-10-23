#!/usr/bin/env bash
# Prompt cache efficiency test for pi-claude-bridge.
# Runs a multi-turn conversation and verifies Anthropic prompt caching is working.
# Expects: cacheRead grows across turns (system prompt + history are cache-hit),
#   cacheWrite is small after the first turn (only new content is written).
#
# Also checks session sync correctness: consecutive same-provider turns must
# resume the session, not fork or rewrite it. Complete content recording must
# include tool results and pi's final assistant message.

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
# Count tool calls, not turns: how many assistant turns the write and read get
# split across is the model's choice, but both tools have to run for the prompts
# to be answered, and tool results exercise the recording/cache path.
MIN_EXPECTED_TOOL_CALLS=2   # write + read
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

TOOL_CALLS=$(jq -c 'select(.type == "tool_execution_start")' "$LOGFILE" | wc -l | tr -d ' ')
echo "Tool calls: $TOOL_CALLS (across $TURN turns)"
if [ "$TOOL_CALLS" -lt $MIN_EXPECTED_TOOL_CALLS ]; then
  echo "FAIL: Only $TOOL_CALLS tool call(s) (expected >= $MIN_EXPECTED_TOOL_CALLS: the write and the read)"
  echo "      The model likely answered from context instead of calling the tool."
  FAIL=$((FAIL + 1))
fi

# --- Assert session resume (no spurious rebuilds) ---
# Every follow-up turn must match the recorded content exactly.
# Parses the "syncResult: path=<path> sessionId=<uuid>"
# marker emitted by syncSharedSession at the end of each call. Gives us both
# the distribution and sessionId stability in one pass.

echo ""
echo "Session sync:"

CLEAN_START_COUNT=0
REUSE_COUNT=0
REBUILD_COUNT=0
declare -a SESSION_IDS=()

while IFS= read -r line; do
  path=$(echo "$line" | sed -nE 's/.*syncResult: path=([a-z-]+).*/\1/p')
  sid=$(echo "$line" | sed -nE 's/.*sessionId=([a-f0-9-]+).*/\1/p')
  case "$path" in
    clean-start) CLEAN_START_COUNT=$((CLEAN_START_COUNT + 1));;
    reuse)       REUSE_COUNT=$((REUSE_COUNT + 1));;
    rebuild|fork|prefix-write) REBUILD_COUNT=$((REBUILD_COUNT + 1));;
    *) echo "FAIL: unrecognized sync path: $path"; FAIL=$((FAIL + 1));;
  esac
  if [ -n "$sid" ]; then
    SESSION_IDS+=("$sid")
  fi
done < <(grep "syncResult:" "$CLAUDE_BRIDGE_DEBUG_PATH" 2>/dev/null || true)

UNIQUE_SIDS=$(printf "%s\n" "${SESSION_IDS[@]}" | sort -u | grep -c . || true)
UNIQUE_SIDS=${UNIQUE_SIDS:-0}

echo "  clean-start: $CLEAN_START_COUNT"
echo "  reuse:       $REUSE_COUNT"
echo "  rebuild:     $REBUILD_COUNT"
echo "  unique session ids: $UNIQUE_SIDS"

if [ "$CLEAN_START_COUNT" -ne $EXPECTED_CASE1 ]; then
  echo "  FAIL: Expected exactly $EXPECTED_CASE1 clean-start, got $CLEAN_START_COUNT"
  FAIL=$((FAIL + 1))
fi

if [ "$REBUILD_COUNT" -gt 0 ]; then
  echo "  FAIL: $REBUILD_COUNT spurious rebuilds (expected 0 for consecutive same-provider turns)"
  echo "    Recorded content does not match the unchanged conversation"
  FAIL=$((FAIL + 1))
fi

if [ "$REUSE_COUNT" -lt $MIN_CASE3_RESUMES ]; then
  echo "  FAIL: Expected at least $MIN_CASE3_RESUMES reuses for turns 2+, got $REUSE_COUNT"
  FAIL=$((FAIL + 1))
fi

# Same-provider flow should never produce more than 1 distinct sessionId:
# one created on first turn (or none for clean-start), reused thereafter.
# A regression that churns UUIDs per turn would surface here even if the
# distribution checks above still passed.
if [ "$UNIQUE_SIDS" -gt 1 ]; then
  echo "  FAIL: expected at most 1 distinct sessionId in same-provider flow, got $UNIQUE_SIDS"
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
