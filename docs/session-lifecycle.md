# Session Lifecycle and Rebuild Management

`pi-claude-bridge` synchronizes conversation history between Pi and Claude Code. Pi stores messages in its internal memory, while Claude Code persists state as JSONL files on disk under `~/.claude/projects/<cwd-hash>/`.

`src/session-sync.ts` manages this bridge, deciding when to resume an existing session file and when to rebuild it.

## Synchronization Paths

On each turn, `syncSharedSession()` evaluates conversation state and selects one of four paths:

### 1. Case 1: Reentrant Child (Independent Context)
- **When**: A background subagent or nested query runs while a parent query is active.
- **Action**: Starts an isolated session for the child without mutating or overwriting the parent session state.

### 2. Case 2: Clean Start
- **When**: Starting a fresh session (e.g. on session start or when switching models).
- **Action**: Generates a new session UUID and writes an initial transcript matching current history.

### 3. Case 3: In-Place Rebuild (Preserve Session UUID)
- **When**: History has diverged (such as after `/compact`, tree navigation, or session rewinds), but no concurrent writer exists.
- **Action**: Deletes the existing session file and writes a clean transcript using the same UUID. Preserving the UUID maintains consistent log correlation and prevents orphan files.

### 4. Case 4: Session Reuse (`REUSE`)
- **When**: The current conversation extends the existing transcript without divergence.
- **Requirements**:
  - `needsRebuild` is false.
  - `bridgeState.sharedSession.cwd === cwd` (working directory is identical).
  - Prior messages length meets or exceeds the previous cursor position.
- **Action**: Invokes Claude Code with `--resume <sessionId>` to append only new messages, maximizing prompt cache hits.

---

## Session State Flags

The shared session state tracks specific invalidation flags:

### `needsRebuild`
Forces the next turn down the `REBUILD` path instead of resuming. Set when:
- An abort occurs.
- Pi compacts history (`/compact`) or navigates session branches.
- A query ends with an error result (preventing subsequent turns from resuming corrupted state).
- Tool delivery encounters an unrecoverable steer mismatch.

### `forceRotate`
Forces the next rebuild to generate a brand-new session UUID and bypass `deleteSession` on the previous file.
- **Why it matters**: When Claude Code is aborted, the child process is terminated, but operating system file buffers may still be flushing an interrupt record (`[Request interrupted by user]`).
- If the next turn immediately reused or rebuilt the same session file at that path, late writes from the dying process could corrupt the newly created transcript.
- `forceRotate` ensures subsequent writes target a fresh file, leaving late writes to land harmlessly on the abandoned inode.

---

## Carrying `@file` Attachments

When a user mentions `@filename` in Claude Code, Claude Code expands the file contents into an internal `attachment` record. Pi only stores the raw `@filename` string.

During a session rebuild:
1. `collectCarriedAttachments()` inspects the session JSONL before deletion.
2. It extracts content-bearing attachments, indexing them by prompt ordinal.
3. `placeCarriedAttachments()` re-injects these attachments into the newly converted message stream.
4. This ensures file context is retained across history compacting and rebuilds.
