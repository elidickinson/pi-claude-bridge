#!/usr/bin/env bash
# Prompt cache test across a mid-conversation git transition. Manual: run directly
# (tests/int-cache-git.sh), never wired into `npm test` — costs ~2 min of real-API
# Haiku per run.
#
# Variant of tests/int-cache.sh. Same harness, same thresholds, but the pi/Claude
# Code process cwd is a throwaway git repo created here, and the conversation
# contains a real `git add -A && git commit` run by the agent (working-tree change
# + new commit) followed by more turns that force reads of the whole history.
#
# The question is empirical: Claude Code's `claude_code` preset embeds a gitStatus
# snapshot, and CC 2.1.280 moves a cache_control ttl=1h breakpoint between turns.
# Do Anthropic cache reads survive a commit boundary, or collapse at it?
#
# Cache thresholds are copied verbatim from int-cache.sh. If `includeGitInstructions:
# false` stops stripping the git snapshot, the commit becomes a real prompt mutation
# and this test must fail rather than pass with loosened numbers -- so a collapse is
# reported loudly, with the failing turn's hit rate, instead of patched out.

source "$(dirname "$0")/lib/bash-setup.sh"

echo "=== cache-git-test.sh ==="

require_command jq git timeout

setup_test_env "cache-git-test" ".ndjson"

LOGFILE="$LOGDIR/cache-git-test.ndjson"

# Throwaway repo, also the pi/CC process cwd: gitStatus is computed from the cwd,
# so the transition has to happen there. Never this repo.
CWD_PREFIX="$LOGDIR/cache-git-cwd."
REPO=$(mktemp -d "$CWD_PREFIX"XXXXXX)
PREFLIGHT="$LOGDIR/cache-git-test-preflight.ndjson"

cleanup() {
  if [[ "$REPO" == "$CWD_PREFIX"* && ${#REPO} -gt ${#CWD_PREFIX} && -d "$REPO" ]]; then
    rm -rf -- "$REPO"
  fi
  kill_descendants
}
trap cleanup EXIT

# COMMIT_CMD is what the agent is told to run, verbatim. -c identity flags are
# required: a fresh repo has no user.email/user.name and the host gitconfig is
# not guaranteed to provide one.
COMMIT_CMD="git add -A && git -c user.email=test@test -c user.name=test commit -m 'wip checkpoint'"

setup_repo() {
  git -C "$REPO" init -q
  git -C "$REPO" symbolic-ref HEAD refs/heads/main
  printf 'alpha\n' > "$REPO/seed.txt"
  git -C "$REPO" add -A
  git -C "$REPO" -c user.email=test@test -c user.name=test commit -q -m "seed commit"
  # Untracked file so the transition commit is non-empty. Turn 2 overwrites its
  # contents with the secret number.
  printf 'beta\n' > "$REPO/scratch.txt"
}

# After the transition the repo must have >=2 commits and a clean tree: a clean
# tree proves the commit picked up the working-tree change rather than coming
# from a separate edit, and >=2 commits proves it is a new commit.
verify_repo() {
  local want_commit="$1"
  local n wt
  n=$(git -C "$REPO" rev-list --count HEAD 2>/dev/null || echo 0)
  wt=$(git -C "$REPO" status --porcelain | tr -d '[:space:]')
  echo "  cwd=$REPO commits=$n (want >= $want_commit) dirty=${wt:+yes}${wt:-no}"
  [ "$n" -ge "$want_commit" ] || return 1
  [ "$want_commit" -lt 2 ] || [ -z "$wt" ] || return 1
  return 0
}

# Turn-4 wording. Terse and imperative, and it forbids extra commands, because the
# looser "Run this exact command and show me the output" had the model answer from
# a file read instead of calling bash.
GIT_PROMPT="Call the bash tool to run this exact command in your current directory, then reply with DONE followed by the command output. Do not edit any file and do not run any other command.

$COMMIT_CMD"

# The agent runs the command with no -C, in the pi/CC process cwd, so that cwd must
# be the throwaway repo before any prompt is sent. Guard this repo anyway: a
# `git add -A` loose in here would commit untracked work. The guard is checked on
# EVERY exit path (the EXIT trap), not just at run end — a host mutation must fail
# the run and be reported even when the run itself fails first. (bash has no
# trap-replacement API, so the child trap deletes and re-arms the parent's.)
HOST_HEAD=$(git -C "$DIR" rev-parse HEAD)
HOST_STATUS=$(git -C "$DIR" status --porcelain)
HOST_GUARD_TRIPPED=0
host_guard() {
  local now_head now_status
  now_head=$(git -C "$DIR" rev-parse HEAD)
  now_status=$(git -C "$DIR" status --porcelain)
  if [ "$now_head" != "$HOST_HEAD" ] || [ "$now_status" != "$HOST_STATUS" ]; then
    echo "  FAIL: the agent mutated this repo (HEAD $HOST_HEAD -> $now_head)" >&2
    HOST_GUARD_TRIPPED=1
  fi
}
guard_host_repo() {
  host_guard
  [ "$HOST_GUARD_TRIPPED" -eq 0 ]
}
# Parent EXIT trap runs FIRST (most recently armed trap fires first): report a
# host mutation on any exit path, then do the child's cleanup.
cleanup() {
  kill_descendants
  host_guard
  if [[ "$REPO" == "$CWD_PREFIX"* && ${#REPO} -gt ${#CWD_PREFIX} && -d "$REPO" ]]; then
    rm -rf -- "$REPO"
  fi
  # Binding on the success path too: kill_descendants first, then the guard, so
  # nothing can mutate the host after the check but before this process exits.
  if [ "$HOST_GUARD_TRIPPED" -eq 1 ]; then
    exit 1
  fi
}
trap cleanup EXIT

# Cheap 1-turn dry run so a full 8-turn run is never spent on a prompt the model
# won't follow.
preflight() {
  setup_repo
  verify_repo 1 || return 1
  timeout 180 pi --no-session -ne -e "$DIR" \
    --model "claude-bridge/claude-haiku-4-5" \
    --mode json \
    -p "$GIT_PROMPT" \
    > "$PREFLIGHT" 2>"$PREFLIGHT.err" || return 1
  verify_repo 2
}

echo "Running preflight: can the agent be made to commit as instructed?"
cd "$REPO"
PREFLIGHT_OK=0
for attempt in 1 2 3; do
  echo " preflight attempt $attempt:"
  if preflight; then
    guard_host_repo && PREFLIGHT_OK=1 && break
  else
    guard_host_repo
  fi
  echo " -> agent did not produce the commit; assistant text:"
  jq -r 'select(.type=="agent_end") | .messages[]? | select(.role=="assistant") | .content[]? | select(.type=="text") | "    " + .text' "$PREFLIGHT" 2>/dev/null | tail -6 || true
  if [ -s "$PREFLIGHT.err" ]; then
    echo " stderr:"
    tail -5 "$PREFLIGHT.err" | sed 's/^/    /'
  fi
done

if [ "$PREFLIGHT_OK" -ne 1 ]; then
  if [ "$HOST_GUARD_TRIPPED" -eq 1 ]; then
    echo "FAIL: the host repo was mutated during preflight -- restore it before rerunning (see guard line above)"
  else
    echo "FAIL: commit prompt never produced a real commit in preflight; full run would be invalid"
  fi
  echo "  Log: $PREFLIGHT"
  exit 1
fi
echo "  preflight OK with prompt: $GIT_PROMPT"

# Reset the repo so the measured conversation starts from 1 commit and its own
# transition, with the preflight turn absent from its history.
rm -rf "$REPO/.git" "$REPO/seed.txt" "$REPO/scratch.txt"
setup_repo
verify_repo 1 || { echo "FAIL: could not reset test repo"; exit 1; }

rm -f "$LOGFILE" "$LOGFILE.err" "$CLAUDE_BRIDGE_DEBUG_PATH"

echo "Running 8-turn conversation, git transition at turn 4..."
timeout 180 pi --no-session -ne -e "$DIR" \
  --model "claude-bridge/claude-haiku-4-5" \
  --mode json \
  -p "The secret number is 42. Acknowledge briefly." \
     "Write the secret number to $REPO/scratch.txt. Just the number, nothing else." \
     "What is 42 * 2? Just the number." \
     "$GIT_PROMPT" \
     "What is the secret number? Just the number." \
     "Read $REPO/scratch.txt and tell me what is in it. One line." \
     "How many commits does the repo at $REPO have now? Just the number." \
     "One line each: the secret number, the contents of $REPO/scratch.txt, and 42*2." \
  > "$LOGFILE" 2>"$LOGFILE.err" || PI_EXIT=$?
PI_EXIT=${PI_EXIT:-0}

if [ -s "$LOGFILE.err" ]; then
  echo ""
  echo "pi stderr:"
  cat "$LOGFILE.err"
  echo ""
fi

if [ "$PI_EXIT" -ne 0 ]; then
  guard_host_repo
  echo "FAIL: pi exited with code $PI_EXIT"
  exit 1
fi

cd "$DIR"

echo ""
echo "Test repo after the run (the commit must be real):"
REPO_OK=0
if verify_repo 2; then
  REPO_OK=1
else
  echo "  FAIL: git transition did not happen -- run is invalid"
fi
git -C "$REPO" log --oneline | sed 's/^/    /'

echo ""
echo "Turn-by-turn cache metrics:"
echo "---"
printf "%-6s  %8s  %8s  %8s  %8s  %s\n" "Turn" "Input" "CacheRd" "CacheWr" "Output" "CacheHit%"

# Thresholds
MIN_CACHE_HIT_PCT=90
# Count tool calls, not turns: how many assistant turns the write and read get
# split across is the model's choice, but both tools have to run for the prompts
# to be answered, and tool results exercise the recording/cache path.
MIN_EXPECTED_TOOL_CALLS=2   # write + commit (+ read)
MIN_CASE3_RESUMES=2
EXPECTED_CASE1=1

# bash 3.2 (macOS default) has no associative arrays; park per-turn hit% in a file.
PCTFILE="$LOGDIR/cache-git-test-pct.txt"
rm -f "$PCTFILE"

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
  echo "$HIT_PCT" >> "$PCTFILE"

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

# One pi turn per assistant message, so a prompt that calls a tool spans two turns
# and the transition's row is not simply its prompt number. GIT_TURN is the first
# turn whose request history contains the commit: the turn_end right after the
# commit's tool result.
COMMIT_TURN=$(jq -s -r '
  to_entries
  | (map(select(.value.type == "tool_execution_start"
               and (.value.args.command // "" | test("commit -m"))) | .key) | first // -1) as $ci
  | if $ci < 0 then 0
    else (map(select(.key < $ci and .value.type == "turn_end") | .key) | length) + 2 end' "$LOGFILE")
GIT_TURN=${COMMIT_TURN:-0}

if [ "$GIT_TURN" -lt 1 ]; then
  echo "  FAIL: no commit tool call found in the log -- run is invalid"
  FAIL=$((FAIL + 1))
else
  echo "The git transition (working-tree change + commit) is inside turn $GIT_TURN."
  PRE_PCT=$(sed -n "$((GIT_TURN - 1))p" "$PCTFILE" 2>/dev/null || echo "")
  AT_PCT=$(sed -n "${GIT_TURN}p" "$PCTFILE" 2>/dev/null || echo "")
  POST_PCT=$(sed -n "$((GIT_TURN + 1))p" "$PCTFILE" 2>/dev/null || echo "")
  echo "  hit% across the boundary: turn $((GIT_TURN - 1))=${PRE_PCT:-?}% -> turn $GIT_TURN=${AT_PCT:-?}% (commit result) -> turn $((GIT_TURN + 1))=${POST_PCT:-?}%"
fi

guard_host_repo || REPO_OK=0
# The final verdict goes through the guard too: a tripped guard cannot pass.
HOST_OK=1
guard_host_repo || HOST_OK=0

TOOL_CALLS=$(jq -c 'select(.type == "tool_execution_start")' "$LOGFILE" | wc -l | tr -d ' ')
echo "Tool calls: $TOOL_CALLS (across $TURN turns)"
if [ "$TOOL_CALLS" -lt $MIN_EXPECTED_TOOL_CALLS ]; then
  echo "FAIL: Only $TOOL_CALLS tool call(s) (expected >= $MIN_EXPECTED_TOOL_CALLS: the write, the commit, the read)"
  echo "      The model likely answered from context instead of calling the tool."
  FAIL=$((FAIL + 1))
fi

# Post-transition turns: the cache question is about the turns after the commit,
# so a run that dies right after the boundary is not a pass.
if [ "$TURN" -lt $((GIT_TURN + 2)) ] || [ "$TURN" -lt 7 ]; then
  echo "  FAIL: only $TURN turns reported usage (expected >= $((GIT_TURN + 2)), and >= 7); the run ended early"
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
NOTES=""
if [ "$REPO_OK" -ne 1 ]; then
  FAIL=$((FAIL + 1))
  NOTES="$NOTES (invalid run: transition missing)"
fi
if [ "$HOST_OK" -ne 1 ]; then
  FAIL=$((FAIL + 1))
  NOTES="$NOTES (HOST REPO WAS MUTATED)"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "PASS: Prompt cache held through the git transition (commit at turn $GIT_TURN) and session resume is clean"
else
  echo "FAIL: $FAIL assertions failed$NOTES"
  echo "  Log: $LOGFILE"
  echo "  Debug: $CLAUDE_BRIDGE_DEBUG_PATH"
  exit 1
fi
