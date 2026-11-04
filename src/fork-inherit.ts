// A forked or cloned pi session starts from its parent's bridge state, so its
// first turn forks the parent's Claude Code session at a cut (row 6 or 7)
// instead of writing pi's history to a new one.
//
// The child gets a copy with dirtyTail set: row 4 (plain resume) then cannot
// apply, so the child never appends to the parent's CC file. Rows 6 and 7 keep
// CC's prompt_snapshot records, and CC replays the recorded system prompt and
// tools, so the copy is only made when the child's prompt fingerprint equals
// the parent's. A child with its own prompt or tools (a subagent with its own
// agent prompt) keeps the written session it got before.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool } from "@earendil-works/pi-ai";
import { getAgentDir, type SessionHeader } from "@earendil-works/pi-coding-agent";
import { copyRecording, type SessionState } from "./session-sync.js";

const FORMAT_VERSION = 1;

/** The parent's pi session id named by a session header's `parentSession`
 *  file, or undefined when there is none or it cannot be read. Never throws. */
export function parentSessionId(header: SessionHeader | null | undefined): string | undefined {
	try {
		if (!header || typeof header.parentSession !== "string" || !header.parentSession) return undefined;
		const text = readFileSync(header.parentSession, "utf8");
		const newline = text.indexOf("\n");
		const parent: unknown = JSON.parse(newline === -1 ? text : text.slice(0, newline));
		if (parent === null || typeof parent !== "object") return undefined;
		const { type, id } = parent as Record<string, unknown>;
		if (type !== "session" || typeof id !== "string" || !id || id === header.id) return undefined;
		return id;
	} catch {
		return undefined;
	}
}

function writeString(hash: ReturnType<typeof createHash>, value: string): void {
	hash.update(`s${value.length}:`);
	hash.update(value, "utf16le");
}

/** sha256 over the system prompt and each tool's name, description and schema, in order. */
export function promptFingerprint(systemPrompt: string | undefined, tools: readonly Tool[] | undefined): string {
	const hash = createHash("sha256");
	hash.update(systemPrompt === undefined ? "prompt:none;" : "prompt:");
	if (systemPrompt !== undefined) writeString(hash, systemPrompt);
	hash.update(`tools:${tools?.length ?? 0};`);
	for (const tool of tools ?? []) {
		writeString(hash, tool.name);
		writeString(hash, tool.description);
		writeString(hash, JSON.stringify(tool.parameters) ?? "");
	}
	return hash.digest("hex");
}

function fingerprintPath(piSessionId: string): string {
	const hash = createHash("sha256").update(piSessionId, "utf16le").digest("hex");
	return join(getAgentDir(), "claude-bridge", "fork-inherit", `f-${hash}.json`);
}

// Last value written or read per fingerprint file, shared by every module
// instance (like the session registry in index.ts) so a write is skipped only
// when the file already holds the value.
const FINGERPRINTS_KEY = Symbol.for("claude-bridge:forkInheritFingerprints");
const knownFingerprints: Map<string, string> = ((globalThis as Record<symbol, unknown>)[FINGERPRINTS_KEY] as Map<string, string> | undefined) ?? new Map();
(globalThis as Record<symbol, unknown>)[FINGERPRINTS_KEY] = knownFingerprints;

/** The fingerprint last recorded for a pi session; undefined when absent, unreadable or invalid. */
export function loadFingerprint(piSessionId: string): string | undefined {
	const path = fingerprintPath(piSessionId);
	let fingerprint: string | undefined;
	try {
		const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (stored !== null && typeof stored === "object") {
			const { version, fingerprint: value } = stored as Record<string, unknown>;
			if (version === FORMAT_VERSION && typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) fingerprint = value;
		}
	} catch {
		fingerprint = undefined;
	}
	if (fingerprint === undefined) knownFingerprints.delete(path);
	else knownFingerprints.set(path, fingerprint);
	return fingerprint;
}

/** Atomic write with mode 0600, as saveSessionState does; skipped when the file holds the value. */
export function saveFingerprint(piSessionId: string, fingerprint: string): void {
	const path = fingerprintPath(piSessionId);
	if (knownFingerprints.get(path) === fingerprint) return;
	const dir = join(getAgentDir(), "claude-bridge", "fork-inherit");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	const tempPath = join(dir, `.${randomUUID()}.tmp`);
	writeFileSync(tempPath, JSON.stringify({ version: FORMAT_VERSION, fingerprint }), { flag: "wx", mode: 0o600 });
	chmodSync(tempPath, 0o600);
	renameSync(tempPath, path);
	knownFingerprints.set(path, fingerprint);
}

/** Child pi session id to parent pi session id, from session_start until the child's first provider call. */
const PARENTS_KEY = Symbol.for("claude-bridge:forkInheritParents");
export const pendingParents: Map<string, string> = ((globalThis as Record<symbol, unknown>)[PARENTS_KEY] as Map<string, string> | undefined) ?? new Map();
(globalThis as Record<symbol, unknown>)[PARENTS_KEY] = pendingParents;

/** A copy of the parent's state that cannot plain-resume (and so append to) the parent's CC file. */
export function inheritedState(parent: SessionState): SessionState {
	return { ...parent, ...copyRecording(parent), dirtyTail: true };
}

type Log = (message: string) => void;

/** session_start hook: remember the parent named by the session header. */
export function rememberParentSession(childId: string, header: SessionHeader | null | undefined, log: Log): void {
	const parentId = parentSessionId(header);
	if (parentId === undefined || parentId === childId) return;
	pendingParents.set(childId, parentId);
	log(`fork-inherit: ${childId} has parent ${parentId}`);
}

/** Provider hook before syncSharedSession: on the child's first call, seed its
 *  state from the parent's when the prompt fingerprints match; then record
 *  this session's fingerprint for its own future children. */
export function inheritParentState(
	childId: string,
	fingerprint: string,
	stateFor: (piSessionId: string) => SessionState | null,
	setStateFor: (piSessionId: string, state: SessionState) => void,
	log: Log,
): void {
	try {
		const parentId = pendingParents.get(childId);
		if (parentId === undefined) return;
		pendingParents.delete(childId);
		const childState = stateFor(childId);
		const parentState = childState ? null : stateFor(parentId);
		const parentFingerprint = parentState ? loadFingerprint(parentId) : undefined;
		const reason = childState ? "child has state"
			: !parentState ? "parent has no state"
			: parentFingerprint === undefined ? "parent has no prompt fingerprint"
			: parentFingerprint !== fingerprint ? "prompt differs"
			: undefined;
		if (reason || !parentState) {
			log(`fork-inherit: ${childId} not inherited from ${parentId}: ${reason}`);
			return;
		}
		setStateFor(childId, inheritedState(parentState));
		log(`fork-inherit: ${childId} inherits CC session ${parentState.ccSessionId.slice(0, 8)} from ${parentId}, ${parentState.digests.length} slots`);
	} finally {
		saveFingerprint(childId, fingerprint);
	}
}
