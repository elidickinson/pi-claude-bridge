// Which Claude Code session each pi session last ran on, persisted across processes.
//
// The bridge's pi-session → CC-session mirror (sharedSessions in index.ts) is
// process-local. A new pi process (restart, `pi --continue`, `pi -p` per turn)
// therefore rebuilds with no previous session id, so readCarriedAttachments has
// nothing to read: the session-start context CC wrote after the first prompt
// (environment, session_context, date, ...) is lost, CC re-attaches it to the
// NEWEST prompt, and the whole history misses the prompt cache.
//
// This file only answers "which CC session did this pi session last use, in this
// cwd?" so a first-turn rebuild can carry attachments from it. It never makes the
// bridge RESUME that session: the rebuild still writes a fresh one, exactly as
// before. What guards a stale or wrong link is the same check the in-process
// rebuild relies on: placeCarriedAttachments drops any attachment whose prompt
// text no longer matches its ordinal, and a missing session file yields none. A
// link from another branch of the same pi session (after /tree) can still carry
// an attachment whose prompt text is the same in both branches; the in-process
// rebuild has that same exposure when it reads `previousSessionId` after a /tree.
// Concurrent pi processes can lose each other's update (read-modify-write without
// a lock); a lost link only means that rebuild carries nothing, the old behavior.

import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

type Link = { ccSessionId: string; cwd: string; at: number };
type Links = Record<string, Link>;

/** Bounded so the file cannot grow without limit; the oldest links go first. */
const MAX_LINKS = 500;

function linksPath(): string {
	return process.env.CLAUDE_BRIDGE_SESSION_LINKS_PATH || join(getAgentDir(), "claude-bridge-sessions.json");
}

function readLinks(): Links {
	try {
		const parsed = JSON.parse(readFileSync(linksPath(), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Links) : {};
	} catch {
		return {};
	}
}

// Last value written per pi session in THIS process, so the per-turn cursor
// updates that also go through setSessionStateFor do not rewrite the file.
// Bounded like the file: cleared wholesale past the cap (a cleared entry only
// costs one redundant write).
const written = new Map<string, string>();

/** Remember that `piSessionId` now runs on `ccSessionId` in `cwd`. Best effort:
 *  a failed write only means a later restart carries nothing, the old behavior. */
export function recordSessionLink(piSessionId: string | null | undefined, ccSessionId: string, cwd: string): void {
	if (!piSessionId) return;
	const key = `${ccSessionId}\0${cwd}`;
	if (written.get(piSessionId) === key) return;
	try {
		const links = readLinks();
		links[piSessionId] = { ccSessionId, cwd, at: Date.now() };
		const kept = Object.entries(links).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_LINKS);
		const path = linksPath();
		mkdirSync(dirname(path), { recursive: true });
		// Write-then-rename so a concurrent reader in another pi process never
		// sees a half-written file.
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)));
		renameSync(tmp, path);
		if (written.size >= MAX_LINKS) written.clear();
		written.set(piSessionId, key);
	} catch {
		/* best effort, see above */
	}
}

/** The CC session `piSessionId` last ran on in `cwd`, if one was recorded. */
export function lookupSessionLink(piSessionId: string | null | undefined, cwd: string): string | undefined {
	if (!piSessionId) return undefined;
	const link = readLinks()[piSessionId];
	return link && link.cwd === cwd && typeof link.ccSessionId === "string" ? link.ccSessionId : undefined;
}
