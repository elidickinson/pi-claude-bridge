#!/usr/bin/env bash
# Benchmark CC preset vs custom systemPromptFile via pi-claude-bridge.
#
# Creates two cwd dirs — one without config (baseline = CC preset) and one
# with .pi/claude-bridge.json pointing at a custom prompt file — then runs the
# same task from each and reports token usage from the bridge log.
#
# Usage: ./bench.sh "your test task here"

set -u

TASK="${1:-Read the README.md in the current directory and tell me in one sentence what this project is.}"
MODEL="claude-bridge/claude-opus-4-7"
LEAN_PROMPT_FILE="$(cd "$(dirname "$0")" && pwd)/lean-prompt.md"
LOG="$HOME/.pi/agent/claude-bridge.log"

if [[ ! -f "$LEAN_PROMPT_FILE" ]]; then
  echo "ERR: lean prompt not at $LEAN_PROMPT_FILE" >&2
  exit 1
fi

BASELINE_DIR="$(mktemp -d -t pi-bench-baseline.XXXXXX)"
LEAN_DIR="$(mktemp -d -t pi-bench-lean.XXXXXX)"
trap 'rm -rf "$BASELINE_DIR" "$LEAN_DIR"' EXIT

# Lean cwd gets a project config pointing at the prompt file.
mkdir -p "$LEAN_DIR/.pi"
cat > "$LEAN_DIR/.pi/claude-bridge.json" <<EOF
{
  "provider": {
    "systemPromptFile": "$LEAN_PROMPT_FILE",
    "appendSystemPrompt": false
  }
}
EOF

mark_log() { printf '\n===BENCH-MARK===%s===\n' "$1" >> "$LOG"; }

run_one() {
  local label="$1" cwd="$2"
  local outfile
  outfile="$(mktemp)"
  mark_log "$label-start"
  local start=$(date +%s)
  ( cd "$cwd" && CLAUDE_BRIDGE_DEBUG=1 pi --print --no-session \
      --model "$MODEL" "$TASK" ) > "$outfile" 2>&1
  local rc=$?
  local end=$(date +%s)
  mark_log "$label-end"
  echo "[$label] exit=$rc duration=$((end-start))s output_chars=$(wc -c < "$outfile" | tr -d ' ')"
  echo "[$label] response (first 250 chars):"
  head -c 250 "$outfile"
  echo
  echo "---"
  rm -f "$outfile"
}

extract_usage() {
  awk -v start="===BENCH-MARK===${1}-start===" \
      -v end="===BENCH-MARK===${1}-end===" \
      'index($0,start){p=1;next} index($0,end){p=0} p && /usage:/' "$LOG" \
    | sed -E 's/.*usage: //'
}

echo "=== Pi Bridge Benchmark ==="
echo "Task: $TASK"
echo "Model: $MODEL"
echo "Lean prompt: $LEAN_PROMPT_FILE ($(wc -w < "$LEAN_PROMPT_FILE") words)"
echo

echo ">>> Run 1: BASELINE (no config — CC preset)"
run_one baseline "$BASELINE_DIR"

echo ">>> Run 2: LEAN (.pi/claude-bridge.json with systemPromptFile)"
run_one lean "$LEAN_DIR"

echo
echo "=== Token usage (baseline) ==="
extract_usage baseline
echo
echo "=== Token usage (lean) ==="
extract_usage lean
