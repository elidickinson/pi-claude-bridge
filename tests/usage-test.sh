#!/usr/bin/env bash
# A/B usage comparison: pi-claude-bridge vs Claude Code direct.
# Runs the same conversation through both paths and compares
# subscription usage delta and token metrics.
#
# One-off diagnostic — not part of the regular test suite.
# Requires: Claude Code OAuth credentials in macOS keychain, pi CLI, claude CLI.
# Rate limit: the usage endpoint is aggressively limited — don't run repeatedly.
#
# Usage: tests/usage-test.sh [model] [turns]
#   model: claude-haiku-4-5 (default), claude-sonnet-4-6, claude-opus-4-6
#   turns: number of conversation turns (default: 10)

source "$(dirname "$0")/lib/bash-setup.sh"

echo "=== usage-test.sh ==="

setup_test_env "usage-test" "none"

MODEL="${1:-claude-haiku-4-5}"
NUM_TURNS="${2:-10}"

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

# --- Map model to Claude Code model ID ---
# Claude Code uses different model IDs than the bridge.
case "$MODEL" in
  claude-haiku-4-5)   CC_MODEL="claude-haiku-4-5" ;;
  claude-sonnet-4-6)  CC_MODEL="claude-sonnet-4-6" ;;
  claude-opus-4-6)    CC_MODEL="claude-opus-4-6" ;;
  *)                  CC_MODEL="$MODEL" ;;
esac

# --- Build prompts ---
# Same prompts for both paths. Mix of text-only and tool-use.
# Tool-use prompts reference files in the project dir so both paths
# have equivalent work to do.

TMPFILE_A="$LOGDIR/usage-test-scratch-a.txt"
TMPFILE_B="$LOGDIR/usage-test-scratch-b.txt"
rm -f "$TMPFILE_A" "$TMPFILE_B"

build_prompts() {
  local tmpfile="$1"
  PROMPTS=()
  PROMPTS+=("Read package.json and explain what this project does based on its dependencies, scripts, and metadata. Be thorough.")
  PROMPTS+=("Write a detailed summary of what you just learned to $tmpfile")
  PROMPTS+=("Read README.md and explain the architecture — how does the provider work, what is AskClaude, how do they interact?")
  PROMPTS+=("Read tsconfig.json and explain all the compiler options and why they might have been chosen.")
  PROMPTS+=("What are the tradeoffs of using the Agent SDK as a provider vs direct API access? Think through caching, latency, token overhead.")
  PROMPTS+=("Read $tmpfile back and compare it to what you now know. What did you miss in the first summary?")
  PROMPTS+=("Read LICENSE and explain the implications of this license choice for an open source project.")
  PROMPTS+=("Summarize everything we've discussed. List every file you read, every file you wrote, and key takeaways.")
  PROMPTS+=("What would you change about this project's architecture if you were starting from scratch? Be specific.")
  PROMPTS+=("Give me a final one-paragraph summary of our entire conversation.")
  # Trim to requested turn count
  PROMPTS=("${PROMPTS[@]:0:$NUM_TURNS}")
}

# Extract per-turn metrics from pi --mode json ndjson output
extract_pi_metrics() {
  local logfile="$1"
  local total_input=0 total_cache_read=0 total_cache_write=0 total_output=0 total_cost="0" turn=0

  printf "%-6s  %8s  %8s  %8s  %8s  %10s\n" "Turn" "Input" "CacheRd" "CacheWr" "Output" "Cost"
  echo "------  --------  --------  --------  --------  ----------"

  while IFS= read -r line; do
    turn=$((turn + 1))
    local input=$(echo "$line" | jq -r '.input')
    local cache_read=$(echo "$line" | jq -r '.cacheRead')
    local cache_write=$(echo "$line" | jq -r '.cacheWrite')
    local output=$(echo "$line" | jq -r '.output')
    local cost=$(echo "$line" | jq -r '.cost.total // 0')

    printf "%-6s  %8s  %8s  %8s  %8s  \$%s\n" "$turn" "$input" "$cache_read" "$cache_write" "$output" "$cost"

    total_input=$((total_input + input))
    total_cache_read=$((total_cache_read + cache_read))
    total_cache_write=$((total_cache_write + cache_write))
    total_output=$((total_output + output))
    total_cost=$(python3 -c "print(round($total_cost + $cost, 6))")
  done < <(jq -c 'select(.type == "turn_end") | .message.usage | {input, cacheRead, cacheWrite, output, cost}' "$logfile")

  echo "------  --------  --------  --------  --------  ----------"
  printf "%-6s  %8s  %8s  %8s  %8s  \$%s\n" "Total" "$total_input" "$total_cache_read" "$total_cache_write" "$total_output" "$total_cost"

  local cache_total=$((total_input + total_cache_read + total_cache_write))
  if [ "$cache_total" -gt 0 ]; then
    echo "Cache hit rate: $(python3 -c "print(round($total_cache_read * 100 / $cache_total, 1))")%"
  fi

  # Export for comparison
  eval "$2_INPUT=$total_input"
  eval "$2_CACHE_READ=$total_cache_read"
  eval "$2_CACHE_WRITE=$total_cache_write"
  eval "$2_OUTPUT=$total_output"
  eval "$2_COST=$total_cost"
  eval "$2_TURNS=$turn"
}

print_usage() {
  local data="$1"
  echo "$data" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f\"  5h: {d['five_hour']['utilization']}%  7d: {d['seven_day']['utilization']}%\")
for k in ['seven_day_opus', 'seven_day_sonnet']:
    if d.get(k):
        print(f\"  {k}: {d[k]['utilization']}%\")
"
}

echo "Model: $MODEL"
echo "Turns: $NUM_TURNS"
echo ""

# ============================================================
# Run A: pi-claude-bridge
# ============================================================

echo "=========================================="
echo "  Run A: pi-claude-bridge"
echo "=========================================="

echo "Fetching usage before..."
BEFORE_A=$(get_usage) || { echo "FAIL: Could not fetch usage"; exit 1; }
print_usage "$BEFORE_A"

build_prompts "$TMPFILE_A"
PROMPT_ARGS=()
for p in "${PROMPTS[@]}"; do PROMPT_ARGS+=(-p "$p"); done

LOGFILE_A="$LOGDIR/usage-test-bridge.ndjson"
echo ""
echo "Running bridge conversation..."
timeout 600 pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/$MODEL" \
  --mode json \
  "${PROMPT_ARGS[@]}" \
  > "$LOGFILE_A" 2>"$LOGFILE_A.err"
rm -f "$TMPFILE_A"

echo ""
extract_pi_metrics "$LOGFILE_A" "A"

echo ""
echo "Waiting 15s for usage to settle..."
sleep 15

echo "Fetching usage after..."
AFTER_A=$(get_usage) || { echo "FAIL: Could not fetch usage"; exit 1; }
print_usage "$AFTER_A"
DELTA_A=$(python3 -c "
import json
before = json.loads('''$BEFORE_A''')
after = json.loads('''$AFTER_A''')
print(round(after['five_hour']['utilization'] - before['five_hour']['utilization'], 2))
")
echo "  5h delta: +${DELTA_A}%"

# ============================================================
# Run B: Claude Code direct
# ============================================================

echo ""
echo "=========================================="
echo "  Run B: Claude Code direct"
echo "=========================================="

echo "Fetching usage before..."
BEFORE_B=$(get_usage) || { echo "FAIL: Could not fetch usage"; exit 1; }
print_usage "$BEFORE_B"

build_prompts "$TMPFILE_B"
PROMPT_ARGS=()
for p in "${PROMPTS[@]}"; do PROMPT_ARGS+=(-p "$p"); done

LOGFILE_B="$LOGDIR/usage-test-direct.ndjson"
echo ""
echo "Running Claude Code direct conversation..."

# Each turn is a separate \`claude -p\` invocation with --resume to maintain session.
RESUME_ID=""
TURN_B=0
TOTAL_B_INPUT=0
TOTAL_B_CACHE_READ=0
TOTAL_B_CACHE_WRITE=0
TOTAL_B_OUTPUT=0
TOTAL_B_COST="0"

printf "%-6s  %8s  %8s  %8s  %8s  %10s\n" "Turn" "Input" "CacheRd" "CacheWr" "Output" "Cost"
echo "------  --------  --------  --------  --------  ----------"

for p in "${PROMPTS[@]}"; do
  TURN_B=$((TURN_B + 1))
  TURN_FILE="$LOGDIR/usage-test-direct-turn${TURN_B}.json"

  CLAUDE_ARGS=(--model "$CC_MODEL" --output-format json -p "$p" --permission-mode bypassPermissions)
  if [ -n "$RESUME_ID" ]; then
    CLAUDE_ARGS+=(--resume "$RESUME_ID")
  fi

  timeout 120 claude "${CLAUDE_ARGS[@]}" > "$TURN_FILE" 2>"$TURN_FILE.err" || true

  # Extract session ID for --resume on next turn
  RESUME_ID=$(jq -r '.session_id // empty' "$TURN_FILE" 2>/dev/null)

  # Extract usage — Claude Code JSON uses different field names than pi
  INPUT=$(jq -r '.usage.input_tokens // 0' "$TURN_FILE" 2>/dev/null)
  CACHE_READ=$(jq -r '.usage.cache_read_input_tokens // 0' "$TURN_FILE" 2>/dev/null)
  CACHE_WRITE=$(jq -r '.usage.cache_creation_input_tokens // 0' "$TURN_FILE" 2>/dev/null)
  OUTPUT=$(jq -r '.usage.output_tokens // 0' "$TURN_FILE" 2>/dev/null)
  # Use Claude Code's own cost calculation for consistency
  COST=$(jq -r '.total_cost_usd // 0' "$TURN_FILE" 2>/dev/null)

  printf "%-6s  %8s  %8s  %8s  %8s  \$%s\n" "$TURN_B" "$INPUT" "$CACHE_READ" "$CACHE_WRITE" "$OUTPUT" "$COST"

  TOTAL_B_INPUT=$((TOTAL_B_INPUT + INPUT))
  TOTAL_B_CACHE_READ=$((TOTAL_B_CACHE_READ + CACHE_READ))
  TOTAL_B_CACHE_WRITE=$((TOTAL_B_CACHE_WRITE + CACHE_WRITE))
  TOTAL_B_OUTPUT=$((TOTAL_B_OUTPUT + OUTPUT))
  TOTAL_B_COST=$(python3 -c "print(round($TOTAL_B_COST + $COST, 6))")
done

echo "------  --------  --------  --------  --------  ----------"
printf "%-6s  %8s  %8s  %8s  %8s  \$%s\n" "Total" "$TOTAL_B_INPUT" "$TOTAL_B_CACHE_READ" "$TOTAL_B_CACHE_WRITE" "$TOTAL_B_OUTPUT" "$TOTAL_B_COST"

B_CACHE_TOTAL=$((TOTAL_B_INPUT + TOTAL_B_CACHE_READ + TOTAL_B_CACHE_WRITE))
if [ "$B_CACHE_TOTAL" -gt 0 ]; then
  echo "Cache hit rate: $(python3 -c "print(round($TOTAL_B_CACHE_READ * 100 / $B_CACHE_TOTAL, 1))")%"
fi

rm -f "$TMPFILE_B"

echo ""
echo "Waiting 15s for usage to settle..."
sleep 15

echo "Fetching usage after..."
AFTER_B=$(get_usage) || { echo "FAIL: Could not fetch usage"; exit 1; }
print_usage "$AFTER_B"
DELTA_B=$(python3 -c "
import json
before = json.loads('''$BEFORE_B''')
after = json.loads('''$AFTER_B''')
print(round(after['five_hour']['utilization'] - before['five_hour']['utilization'], 2))
")
echo "  5h delta: +${DELTA_B}%"

# ============================================================
# Comparison
# ============================================================

echo ""
echo "=========================================="
echo "  Comparison"
echo "=========================================="

python3 -c "
a_input, a_cr, a_cw, a_output, a_cost = $A_INPUT, $A_CACHE_READ, $A_CACHE_WRITE, $A_OUTPUT, $A_COST
b_input, b_cr, b_cw, b_output, b_cost = $TOTAL_B_INPUT, $TOTAL_B_CACHE_READ, $TOTAL_B_CACHE_WRITE, $TOTAL_B_OUTPUT, $TOTAL_B_COST
a_delta, b_delta = $DELTA_A, $DELTA_B

print(f'                     {\"Bridge\":>12s}  {\"Direct\":>12s}  {\"Diff\":>12s}')
print(f'                     {\"------\":>12s}  {\"------\":>12s}  {\"----\":>12s}')
print(f'  Input tokens       {a_input:>12}  {b_input:>12}  {a_input - b_input:>+12}')
print(f'  Cache read tokens  {a_cr:>12}  {b_cr:>12}  {a_cr - b_cr:>+12}')
print(f'  Cache write tokens {a_cw:>12}  {b_cw:>12}  {a_cw - b_cw:>+12}')
print(f'  Output tokens      {a_output:>12}  {b_output:>12}  {a_output - b_output:>+12}')
print(f'  API-equiv cost     {\"\$\" + str(a_cost):>12}  {\"\$\" + str(b_cost):>12}  {\"\$\" + str(round(a_cost - b_cost, 6)):>12}')

a_cache_total = a_input + a_cr + a_cw
b_cache_total = b_input + b_cr + b_cw
a_hit = round(a_cr * 100 / a_cache_total, 1) if a_cache_total > 0 else 0
b_hit = round(b_cr * 100 / b_cache_total, 1) if b_cache_total > 0 else 0
print(f'  Cache hit rate     {str(a_hit) + \"%\":>12}  {str(b_hit) + \"%\":>12}  {str(round(a_hit - b_hit, 1)) + \"%\":>12}')

print(f'  Usage delta (5h)   {str(a_delta) + \"%\":>12}  {str(b_delta) + \"%\":>12}  {str(round(a_delta - b_delta, 2)) + \"%\":>12}')

if a_delta == b_delta:
    print()
    print('  Result: Same usage impact.')
elif a_delta > b_delta:
    print()
    print(f'  Result: Bridge used {round(a_delta - b_delta, 2)}% more of 5h window.')
elif b_delta > a_delta:
    print()
    print(f'  Result: Bridge used {round(b_delta - a_delta, 2)}% less of 5h window.')
"

echo ""
echo "Logs:"
echo "  Bridge: $LOGFILE_A"
echo "  Direct: $LOGDIR/usage-test-direct-turn*.json"
