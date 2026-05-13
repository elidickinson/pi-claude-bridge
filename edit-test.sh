#!/usr/bin/env bash
# Stress test: edit task. Verifies lean prompt still respects read-before-write
# and produces correct edits without clobbering.
#
# Creates a file with a known typo, runs the same edit task in baseline + lean,
# captures resulting file state, and diffs.

set -u

MODEL="claude-bridge/claude-opus-4-7"
LEAN_PROMPT_FILE="$(dirname "$0")/lean-prompt.txt"
LOG="$HOME/.pi/agent/claude-bridge.log"
TESTDIR="/tmp/pi-edit-test"

ORIGINAL='# Project Notes

This is a smal test file with mulitple typos.
The fucntion handles user authentcation correctly.
Pleae review the implmentation.'

EXPECTED_FIXES="small multiple function authentication Please implementation"

mark_log() { printf '\n===EDIT-TEST===%s===\n' "$1" >> "$LOG"; }

setup_file() {
  rm -rf "$TESTDIR"
  mkdir -p "$TESTDIR"
  printf '%s\n' "$ORIGINAL" > "$TESTDIR/notes.md"
}

run_one() {
  local label="$1"; shift
  setup_file
  local outfile
  outfile="$(mktemp)"
  mark_log "$label-start"
  local start=$(date +%s)
  CLAUDE_BRIDGE_DEBUG=1 "$@" pi --print --no-session \
    --model "$MODEL" \
    "Fix all spelling typos in $TESTDIR/notes.md. Preserve the existing structure and meaning." \
    > "$outfile" 2>&1
  local rc=$?
  local end=$(date +%s)
  mark_log "$label-end"

  echo "=== $label ==="
  echo "exit=$rc duration=$((end-start))s"
  echo "--- response (first 200 chars):"
  head -c 200 "$outfile"
  echo
  echo "--- resulting file:"
  cat "$TESTDIR/notes.md"
  echo "--- diff vs original:"
  diff <(printf '%s\n' "$ORIGINAL") "$TESTDIR/notes.md" || true
  echo "--- typo-fix scoreboard:"
  for word in $EXPECTED_FIXES; do
    if grep -qw "$word" "$TESTDIR/notes.md"; then
      echo "  ✓ $word"
    else
      echo "  ✗ $word (missing)"
    fi
  done
  echo
  rm -f "$outfile"
}

extract_usage() {
  awk -v start="===EDIT-TEST===${1}-start===" \
      -v end="===EDIT-TEST===${1}-end===" \
      'index($0,start){p=1;next} index($0,end){p=0} p && /usage:/' "$LOG" \
    | sed -E 's/.*usage: //'
}

echo ">>> BASELINE (full CC preset)"
run_one baseline env -u PI_BRIDGE_LEAN_PROMPT -u PI_BRIDGE_ALLOWED_TOOLS

echo ">>> LEAN (caveman + restricted tools)"
LEAN_PROMPT="$(cat "$LEAN_PROMPT_FILE")"
run_one lean env \
  PI_BRIDGE_LEAN_PROMPT="$LEAN_PROMPT" \
  PI_BRIDGE_ALLOWED_TOOLS="Read,Edit,Bash,Grep,Glob"

echo
echo "=== Token usage (baseline) ==="
extract_usage baseline
echo
echo "=== Token usage (lean) ==="
extract_usage lean
