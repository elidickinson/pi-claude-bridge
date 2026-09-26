/**
 * Fingerprint-based syncSharedSession and mid-tool model/effort updates.
 *
 * The old count-vs-cursor comparison reused the CC session whenever prior
 * message COUNT matched the cursor, so a prior removed/rewritten at the same
 * count never reached Claude Code (probe: [recall1,user1] vs [user1,assistant1]
 * collided). These tests pin the content-fingerprint discriminator, the
 * ownership threading (pi session identity via ownerSessionId — issue #30), the
 * root-rewind cursor reset,
 * and the needRebuild preservation across active-query completion.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");
const { fingerprintProjectedPriors } = await import("../src/priors-fingerprint.js");

const ts = () => Date.now();

describe("syncSharedSession fingerprints", () => {
	afterEach(() => {
		__test.resetSharedSession();
		__test.setPiUI(null);
	});

	function tmp() {
		return mkdtempSync(join(tmpdir(), "sync-fp-"));
	}

	it("rebuilds when prior content changes at the same count", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 2, cwd, fingerprint: undefined });
			// Establish the state's fingerprint by first running an identical sync —
			// a legacy state (fingerprint undefined) shortens nothing at same count,
			// but the computed digest is only rester on the reuse/rebuild path.
			// Seed it with a real rebuild: same-count changed content with no
			// fingerprint stored falls through to REBUILD, which stores the digest.
			const result1 = __test.syncSharedSession([
				{ role: "user", content: "Original first turn", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Original reply" }], timestamp: ts() },
				{ role: "user", content: "Next question", timestamp: ts() },
			], cwd);
			assert.equal(result1.sessionId, sessionId, "same-count sync after a legacy state rebuilds once and stores the digest");
			assert.ok(__test.getSharedSession().fingerprint, "rebuild stores the priors fingerprint");

			// Same count, changed content: must NOT reuse.
			const sharedBefore = __test.getSharedSession();
			const result2 = __test.syncSharedSession([
				{ role: "user", content: "REWRITTEN first turn", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Original reply" }], timestamp: ts() },
				{ role: "user", content: "Next question", timestamp: ts() },
			], cwd);
			assert.equal(result2.sessionId, sessionId, "in-place rebuild keeps the UUID");
			assert.notEqual(__test.getSharedSession().fingerprint, sharedBefore.fingerprint, "fingerprint advanced with the rewrite");
			const session = openSession({ sessionId, projectPath: cwd });
			assert.match(JSON.stringify(session.records), /REWRITTEN first turn/, "CC history now matches pi's rewritten prior");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("reuses when content is identical at the same count", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages([
				{ role: "user", content: "Hi" },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }] },
			]);
			seeded.save();
			__test.setSharedSession({ sessionId, cursor: 2, cwd });

			const messages = [
				{ role: "user", content: "Hi", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }], timestamp: ts() },
				{ role: "system", content: "prompt state", timestamp: ts() },
				{ role: "user", content: "Next", timestamp: ts() },
			];
			// First sync with no fingerprint stored: legacy path can't reuse the
			// same-count case without a digest comparison — it must rebuild once.
			// (documented one-time churn on upgrade)
			const result1 = __test.syncSharedSession(messages, cwd);
			assert.equal(result1.sessionId, sessionId);
			assert.ok(__test.getSharedSession().fingerprint, "fingerprint stored after the first rebuild");

			// Identical content again → REUSE.
			const result2 = __test.syncSharedSession(messages, cwd);
			assert.equal(result2.sessionId, sessionId, "same content same count reuses the session");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// Regression: a stored fingerprint covers the history prefix the cursor
	// points at. A matching prefix with MULTIPLE unseen messages past the cursor
	// must rebuild — reusing would keep the old CC session, store a fingerprint
	// over priors it never imported, and silently drop the unseen turns from
	// Claude Code's context (missing context, not saved quota).
	it("a matching prefix followed by multiple unseen priors rebuilds instead of reusing", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			const seeded = createSession({ sessionId, projectPath: cwd });
			seeded.importMessages([
				{ role: "user", content: "Known turn 1" },
				{ role: "assistant", content: [{ type: "text", text: "Known reply 1" }] },
			]);
			seeded.save();
			const knownPriors = [
				{ role: "user", content: "Known turn 1", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Known reply 1" }], timestamp: ts() },
			];
			__test.setSharedSession({
				sessionId,
				cursor: 2,
				cwd,
				fingerprint: fingerprintProjectedPriors(knownPriors).hash,
			});

			const extended = [
				...knownPriors,
				{ role: "user", content: "Unseen offline turn", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Unseen offline reply" }], timestamp: ts() },
			];
			const result = __test.syncSharedSession(extended, cwd);

			assert.equal(result.sessionId, sessionId, "same-owner extended priors rebuild in place, keeping the UUID");
			const shared = __test.getSharedSession();
			assert.equal(
				shared.fingerprint,
				fingerprintProjectedPriors(extended).hash,
				"stored fingerprint realigned to the FULL retained priors, not just the matched prefix",
			);
			const live = openSession({ sessionId, projectPath: cwd });
			assert.match(JSON.stringify(live.records), /Unseen offline turn/, "the unseen turn was imported into the CC history");

			// Cursor realigned: an identical follow-up sync reuses without churn.
			const again = __test.syncSharedSession(extended, cwd);
			assert.equal(again.sessionId, sessionId, "realigned state reuses on the next sync");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("does not rebuild on metadata-only diffs (timestamps/usage)", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 2, cwd });
			const messagesA = [
				{ role: "user", content: "Hi", timestamp: 1 },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }], usage: { input: 10, output: 2 }, stopReason: "stop", model: "old", timestamp: 2 },
				{ role: "user", content: "Next", timestamp: 3 },
			];
			const result1 = __test.syncSharedSession(messagesA, cwd);
			const fingerprintA = __test.getSharedSession().fingerprint;
			const messagesB = [
				{ role: "user", content: "Hi", timestamp: 999 },
				{ role: "assistant", content: [{ type: "text", text: "Hello." }], usage: { input: 99999, output: 777 }, stopReason: "stop", model: "different", timestamp: 1000 },
				{ role: "user", content: "Next", timestamp: 1001 },
			];
			const result2 = __test.syncSharedSession(messagesB, cwd);
			assert.deepEqual(
				{ r: result2.sessionId },
				{ r: result1.sessionId },
				"metadata-only diffs must not force a rebuild",
			);
			assert.equal(__test.getSharedSession().fingerprint, fingerprintA, "fingerprint unchanged under timestamps/usage/model metadata");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("rebuilds with full retained import when a same-owner (reentrant) call has shortened priors", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 4, cwd, ownerSessionId: "pi-session-a" });
			const result = __test.syncSharedSession([
				{ role: "user", content: "Kept1", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Kept2" }], timestamp: ts() },
				{ role: "user", content: "New turn after prune", timestamp: ts() },
			], cwd, undefined, undefined, "pi-session-a");

			assert.equal(result.sessionId, sessionId, "same-owner shortening rebuilds in place, not a clean start");
			assert.equal(result.preserveSharedSession, undefined);
			const session = openSession({ sessionId, projectPath: cwd });
			const body = JSON.stringify(session.records);
			assert.match(body, /Kept1/, "retained priors are fully imported into the rebuild");
			assert.match(body, /Kept2/, "retained priors are fully imported into the rebuild");
			assert.ok(!__test.getSharedSession()?.preserveSharedSession, "shared state takes the rebuilt session");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("starts an ephemeral isolated session importing its own priors for a real child (no reentrancy claim)", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 5, cwd });
			const result = __test.syncSharedSession([
				{ role: "user", content: "Child prompt", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Child work" }], timestamp: ts() },
				{ role: "user", content: "Child continuation", timestamp: ts() },
			], cwd);

			assert.notEqual(result.sessionId, sessionId, "a child must never resume the parent's session");
			assert.notEqual(result.sessionId, null, "a child with its own priors gets a real ephemeral session importing them");
			assert.equal(result.preserveSharedSession, true, "the parent session is preserved");
			const childSession = openSession({ sessionId: result.sessionId, projectPath: cwd });
			const body = JSON.stringify(childSession.records);
			assert.match(body, /Child prompt/, "the child's own priors are imported");
			assert.ok(!body.match(/Parent/), "no parent-only history leaks into the child session");
			assert.deepEqual(
				{ id: __test.getSharedSession().sessionId },
				{ id: sessionId },
				"shared state is untouched by the child sync",
			);
			deleteSession(result.sessionId, cwd);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("root rewind (zero retained priors) clears the stale cursor", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 7, cwd, ownerSessionId: "pi-session-a" });
			const result = __test.syncSharedSession([
				{ role: "user", content: "Start over at the root", timestamp: ts() },
			], cwd, undefined, undefined, "pi-session-a");

			assert.equal(result.sessionId, null, "root rewind is a clean start");
			assert.equal(result.preserveSharedSession, undefined, "root rewind drops the shared state (no preserve)");
			assert.equal(__test.getSharedSession(), null, "the stale cursor is cleared — no max(oldCursor,newLen) carryover");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("detects a recall-style injection before the last user message that disappears", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: ts() });
			// Turn N: recall injected before the last user message; the shared state
			// advanced its cursor to 4 during that turn (mid-turn/completion cursor
			// writes count the recall message), fingerprint bound to that prefix —
			// exactly what the mid-turn/completion writes store.
			const withRecall = [
				{ role: "user", content: "Hi", timestamp: ts() },
				assistant("Hello."),
				{ role: "user", content: "RECALL: facts from memory", timestamp: ts() },
				{ role: "user", content: "Continue the task", timestamp: ts() },
			];
			__test.setSharedSession({
				sessionId,
				cursor: 4,
				cwd,
				fingerprint: fingerprintProjectedPriors(withRecall.slice(0, 4)).hash,
			});

			// The transient context-hook injection disappears on the next request:
			// it was inserted before the last user message, not persisted in pi's
			// history. SAME count of priors — [Hi, Hello, Continue, Reply] — the
			// exact count-collision the old code reused on. Fingerprints force the
			// CC history update, and CC's persisted recall dies with the rebuild.
			const withoutRecall = [
				{ role: "user", content: "Hi", timestamp: ts() },
				assistant("Hello."),
				{ role: "user", content: "Continue the task", timestamp: ts() },
				assistant("Reply."),
				{ role: "user", content: "Next turn", timestamp: ts() },
			];
			const result = __test.syncSharedSession(withoutRecall, cwd);
			assert.equal(result.sessionId, sessionId, "removal is an in-place rebuild, never count-collision reuse");
			const session = openSession({ sessionId, projectPath: cwd });
			const body = JSON.stringify(session.records);
			assert.ok(!body.match(/RECALL/), "CC history no longer holds the removed recall message");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("detects a recall-style injection whose content changes at the same count", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: ts() });
			// Turn N: recall v1 lived at priors position 2 (before the last user
			// message); the next request re-injects a REFRESHED recall before its
			// own last user message — same collision shape as the removal case.
			const first = [
				{ role: "user", content: "Hi", timestamp: ts() },
				assistant("Hello."),
				{ role: "user", content: "RECALL v1: stale memory facts", timestamp: ts() },
				{ role: "user", content: "Continue the task", timestamp: ts() },
			];
			__test.setSharedSession({
				sessionId,
				cursor: 4,
				cwd,
				fingerprint: fingerprintProjectedPriors(first).hash,
			});
			const second = [
				{ role: "user", content: "Hi", timestamp: ts() },
				assistant("Hello."),
				{ role: "user", content: "Continue the task", timestamp: ts() },
				assistant("Reply."),
				{ role: "user", content: "RECALL v2: refreshed memory facts", timestamp: ts() },
				{ role: "user", content: "Go on", timestamp: ts() },
			];
			const fpBefore = fingerprintProjectedPriors(first).hash;
			const result = __test.syncSharedSession(second, cwd);
			assert.equal(result.sessionId, sessionId, "changed injection rebuilds in place");
			assert.notEqual(__test.getSharedSession().fingerprint, fpBefore, "fingerprint advanced with the changed injection");
			const session = openSession({ sessionId, projectPath: cwd });
			const body = JSON.stringify(session.records);
			// RECALL v2 sits in the CURRENT turn (trailing users), so it travels as
			// the prompt, not as priors — the pinned contract here is that the stale
			// v1 text no longer replays and the priors were re-imported.
			assert.ok(!body.match(/RECALL v1/), "the stale injection text is gone from CC history");
			assert.match(body, /Continue the task/, "the priors were re-imported into the CC history");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("preserves a pending needsRebuild across the active-query completion reconstruction", () => {
		// The completion handler reconstructs {sessionId,cursor,cwd} wholesale on
		// query completion; a needsRebuild marked while the query was running (pi
		// rewrote history mid-turn) used to be dropped there. The extracted
		// reconstruction helper — the exact code the .then body calls — must keep
		// the pending flag and refresh the fingerprint.
		const pending = {
			sessionId: randomUUID(),
			cursor: 3,
			cwd: "/tmp/whatever",
			needsRebuild: true,
			fingerprint: "abc",
		};
		const history = [
			{ role: "user", content: "Q1" },
			{ role: "assistant", content: [{ type: "text", text: "A1" }] },
			{ role: "user", content: "Q2" },
			{ role: "assistant", content: [{ type: "text", text: "A2" }] },
		];
		const merged = __test.reconstructCompletedSession(pending, pending.sessionId, 4, pending.cwd, history, "pi-session-a");
		assert.equal(merged.needsRebuild, true, "pending needsRebuild survives the reconstruction");
		assert.notEqual(merged.fingerprint, "abc", "fingerprint refreshed to the priors CC has");
		assert.deepEqual(
			{ s: merged.sessionId, c: merged.cursor, w: merged.cwd },
			{ s: pending.sessionId, c: 4, w: "/tmp/whatever" },
		);

		// And when nothing was pending, the reconstruction carries no flag.
		const clean = { sessionId: pending.sessionId, cursor: 2, cwd: pending.cwd };
		const mergedClean = __test.reconstructCompletedSession(clean, clean.sessionId, 4, clean.cwd, history);
		assert.equal(mergedClean.needsRebuild, undefined);
		assert.equal(merged.ownerSessionId, "pi-session-a", "owner identity rides on the reconstructed state");
	});

	// Regression: a foreign caller dispatching while a
	// needsRebuild is pending must never reach the REBUILD path (which would
	// deleteSession() the owner's live session file and adopt the child's
	// ownerSessionId onto shared state) — the needsRebuild bypass is owner-gated.
	it("a foreign session with priors while needsRebuild is pending does not rebuild or delete the owner's session", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			// Seed the owner's session file so REBUILD's deleteSession(preserveId)
			// would actually destroy something live.
			const owner = createSession({ sessionId, projectPath: cwd });
			owner.importMessages([
				{ role: "user", content: "Owner turn 1" },
				{ role: "assistant", content: [{ type: "text", text: "Owner reply 1" }] },
			]);
			owner.save();
			__test.setSharedSession({ sessionId, cursor: 2, cwd, ownerSessionId: "parent-pi-session", needsRebuild: true });

			const result = __test.syncSharedSession([
				{ role: "user", content: "Child p1", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Child a1" }], timestamp: ts() },
				{ role: "user", content: "Child continue", timestamp: ts() },
			], cwd, undefined, undefined, "child-pi-session");

			assert.notEqual(result.sessionId, sessionId, "the child never resumes the owner's session");
			assert.equal(result.preserveSharedSession, true, "the owner's state is kept, the child's session is ephemeral");
			// The owner's live session file was NOT deleted/rebuilt in place.
			const live = openSession({ sessionId, projectPath: cwd });
			assert.match(JSON.stringify(live.records), /Owner turn 1/, "owner's live session file untouched by the foreign dispatch");
			assert.deepEqual(
				__test.getSharedSession(),
				{ sessionId, cursor: 2, cwd, ownerSessionId: "parent-pi-session", needsRebuild: true },
				"shared state owner/cursor/needsRebuild all unchanged — no foreign owner adoption",
			);
			assert.notEqual(result.sessionId, null, "the child gets an ephemeral session of its own");
			deleteSession(result.sessionId, cwd);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// Regression: a foreign zero-priors child
	// arriving while a needsRebuild is pending must not null the shared state via
	// the root-rewind clear (clearOwnState includes needsRebuild regardless of
	// owner); shared state must survive.
	it("a foreign zero-priors child while needsRebuild is pending preserves shared state", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 3, cwd, ownerSessionId: "parent-pi-session", needsRebuild: true });
			const result = __test.syncSharedSession([
				{ role: "user", content: "Child fresh prompt", timestamp: ts() },
			], cwd, undefined, undefined, "child-pi-session");
			assert.equal(result.sessionId, null, "no resume for the foreign zero-priors child");
			assert.equal(result.preserveSharedSession, true, "the owner's state must survive the child's dispatch");
			assert.deepEqual(
				__test.getSharedSession(),
				{ sessionId, cursor: 3, cwd, ownerSessionId: "parent-pi-session", needsRebuild: true },
				"shared state not nulled by the foreign root-rewind clear",
			);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// Regression: the legitimate path — proven same owner arriving with a pending
	// needsRebuild must still take rebuild (the needsRebuild bypass stays).
	it("the owner with needsRebuild pending still rebuilds", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 2, cwd, ownerSessionId: "pi-session-a", needsRebuild: true });
			const result = __test.syncSharedSession([
				{ role: "user", content: "Kept1", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Kept2" }], timestamp: ts() },
				{ role: "user", content: "Next after pending rebuild" },
			].map((m) => ({ ...m, timestamp: m.timestamp ?? ts() })), cwd, undefined, undefined, "pi-session-a");
			assert.equal(result.sessionId, sessionId, "owner rebuild in place keeps the UUID");
			assert.equal(result.preserveSharedSession, undefined);
			const session = openSession({ sessionId, projectPath: cwd });
			assert.match(JSON.stringify(session.records), /Kept1/, "retained priors are imported");
			assert.equal(__test.getSharedSession().needsRebuild, undefined, "pending rebuild consumed");
			assert.equal(__test.getSharedSession().ownerSessionId, "pi-session-a", "owner unchanged");
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// Regression: the REUSE path had no
	// ownership gate — a foreign caller with priors that prefix-match the stored
	// fingerprint at count >= cursor could resume the parent's CC session and
	// advance the shared cursor. Foreign callers must route to isolation like
	// every other foreign path.
	it("a foreign caller with prefix-matching priors is not resumed into the shared session", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			const parentPriors = [
				{ role: "user", content: "Parent turn 1", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Parent reply 1" }], timestamp: ts() },
				{ role: "user", content: "Parent turn 2", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Parent reply 2" }], timestamp: ts() },
				{ role: "user", content: "Parent turn 3", timestamp: ts() },
			];
			__test.setSharedSession({
				sessionId,
				cursor: 4,
				cwd,
				ownerSessionId: "parent-pi-session",
				fingerprint: fingerprintProjectedPriors(parentPriors.slice(0, 4)).hash,
			});
			// Foreign caller whose priors CONTAIN the parent's stored prefix (e.g. a
			// cloned/branched session) and whose count exceeds the cursor.
			const clonePriors = [
				...parentPriors.slice(0, 4).map((m) => ({ ...m })),
				{ role: "user", content: "Clone's own extra turn", timestamp: ts() },
			];
			const result = __test.syncSharedSession([...clonePriors, { role: "user", content: "Clone turn", timestamp: ts() }], cwd, undefined, undefined, "clone-pi-session");

			assert.notEqual(result.sessionId, sessionId, "a foreign caller must never resume the owner's CC session");
			assert.equal(result.preserveSharedSession, true, "the owner's state is kept; the foreign session is ephemeral");
			const kept = __test.getSharedSession();
			assert.deepEqual(
				{ id: kept.sessionId, cursor: kept.cursor, owner: kept.ownerSessionId, fp: kept.fingerprint },
				{ id: sessionId, cursor: 4, owner: "parent-pi-session", fp: fingerprintProjectedPriors(parentPriors.slice(0, 4)).hash },
				"shared cursor/fingerprint not advanced by the foreign prefix match",
			);
			if (result.sessionId) deleteSession(result.sessionId, cwd);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	// Regression: reconstructCompletedSession
	// carried "previous owner wins" blindly, so a foreign completion that landed
	// in the mark-to-completion window permanently tainted the shared owner.
	// The completing session's own context is authoritative.
	it("a foreign completion never adopts the foreign owner; the owner's completion carries its own id", () => {
		const history = [
			{ role: "user", content: "Q1" },
			{ role: "assistant", content: [{ type: "text", text: "A1" }] },
			{ role: "user", content: "Q2" },
		];
		// Tainted state: previous owner differs from the completing caller's id.
		const tainted = {
			sessionId: randomUUID(),
			cursor: 2,
			cwd: "/tmp/x",
			fingerprint: "abc",
			ownerSessionId: "child-pi-session",
		};
		const repaired = __test.reconstructCompletedSession(tainted, tainted.sessionId, 3, "/tmp/x", history, "parent-pi-session");
		assert.equal(repaired.ownerSessionId, "parent-pi-session", "the actual owner's captured session is authoritative — foreign taint repaired");

		// Normal path unchanged: matching previous state carries (same id).
		const normal = { ...tainted, ownerSessionId: "parent-pi-session" };
		assert.equal(
			__test.reconstructCompletedSession(normal, normal.sessionId, 3, "/tmp/x", history, "parent-pi-session").ownerSessionId,
			"parent-pi-session",
			"same-owner completion keeps carrying the owner",
		);

		// Legacy upgrade still works: no previous owner, incoming id adopted.
		const legacy = { sessionId: randomUUID(), cursor: 2, cwd: "/tmp/x" };
		assert.equal(
			__test.reconstructCompletedSession(legacy, legacy.sessionId, 3, "/tmp/x", history, "parent-pi-session").ownerSessionId,
			"parent-pi-session",
			"legacy states still get upgraded with the incoming id",
		);

		// Unknown incoming id on an owned state keeps the stored owner (owner wins
		// when there is nothing to contradict it — e.g. AskClaude with no identity).
		assert.equal(
			__test.reconstructCompletedSession(normal, normal.sessionId, 3, "/tmp/x", history, undefined).ownerSessionId,
			"parent-pi-session",
			"no incoming id — the stored owner stands",
		);
	});

	// Regression: a subagent child dispatched while the
	// parent's query is still live runs through the parent's pinned stream fn in
	// the parent's module state — but it is a DIFFERENT pi session. Ownership is
	// decided by StreamOptions.sessionId identity, not by "a query is active
	// somewhere", so a child's dispatch must be isolated even mid-parent-query.
	it("a foreign session (different pi sessionId) with zero priors mid-parent-query preserves the shared session", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 4, cwd, ownerSessionId: "parent-pi-session" });
			const result = __test.syncSharedSession([
				{ role: "user", content: "Child first prompt", timestamp: ts() },
			], cwd, undefined, undefined, "child-pi-session");

			assert.equal(result.sessionId, null, "a foreign zero-priors dispatch starts fresh, no resume");
			assert.equal(result.preserveSharedSession, true, "the parent's shared state must survive the child's dispatch");
			const kept = __test.getSharedSession();
			assert.deepEqual(
				{ id: kept.sessionId, cursor: kept.cursor, owner: kept.ownerSessionId },
				{ id: sessionId, cursor: 4, owner: "parent-pi-session" },
				"shared session id/cursor/owner untouched — the child must not root-rewind the parent's state",
			);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("a foreign session with its own priors is isolated even when its priors exceed the shared cursor", () => {
		const cwd = tmp();
		const sessionId = randomUUID();
		try {
			__test.setSharedSession({ sessionId, cursor: 2, cwd, ownerSessionId: "parent-pi-session" });
			const result = __test.syncSharedSession([
				{ role: "user", content: "Child p1", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Child a1" }], timestamp: ts() },
				{ role: "user", content: "Child p2", timestamp: ts() },
				{ role: "assistant", content: [{ type: "text", text: "Child a2" }], timestamp: ts() },
				{ role: "user", content: "Child p3", timestamp: ts() },
			], cwd, undefined, undefined, "child-pi-session");

			assert.notEqual(result.sessionId, null, "the child gets a real session importing its own priors");
			assert.notEqual(result.sessionId, sessionId, "the child never resumes the parent's session");
			assert.equal(result.preserveSharedSession, true, "the parent's shared state survives untouched");
			assert.equal(__test.getSharedSession().sessionId, sessionId, "shared state not rebuilt for the child");
			deleteSession(result.sessionId, cwd);
		} finally {
			deleteSession(sessionId, cwd);
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("fingerprintProjectedPriors is deterministic and excludes metadata", () => {
		const base = [
			{ role: "user", content: "Hi", timestamp: 1 },
			{ role: "assistant", content: [
				{ type: "thinking", thinking: "hm", thinkingSignature: "sig" },
				{ type: "text", text: "Hello" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { cmd: "ls" } },
			], provider: "claude-bridge", usage: { input: 5 }, timestamp: 2 },
			{ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "out" }], isError: false, timestamp: 3 },
		];
		const a = fingerprintProjectedPriors(base).hash;
		const b = fingerprintProjectedPriors(JSON.parse(JSON.stringify(base))).hash;
		assert.equal(a, b, "deterministic across copies");
		const metaOnly = JSON.parse(JSON.stringify(base));
		metaOnly[0].timestamp = 999;
		metaOnly[1].usage = { input: 9999, output: 999 };
		metaOnly[1].timestamp = 1000;
		metaOnly[2].timestamp = 1001;
		const c = fingerprintProjectedPriors(metaOnly).hash;
		assert.equal(a, c, "timestamps/usage excluded");
		const contentChanged = JSON.parse(JSON.stringify(base));
		contentChanged[2].content = [{ type: "text", text: "DIFFERENT output" }];
		assert.notEqual(fingerprintProjectedPriors(contentChanged).hash, a, "tool result content is fingerprinted");
		const argsChanged = JSON.parse(JSON.stringify(base));
		argsChanged[1].content[2].arguments = { cmd: "rm -rf /" };
		assert.notEqual(fingerprintProjectedPriors(argsChanged).hash, a, "tool arguments are fingerprinted");
		const emptyProjection = fingerprintProjectedPriors([]).hash;
		assert.notEqual(emptyProjection, a);
	});

	it("applyMidToolChanges applies model and effort to a live query; reports truthful no-op path otherwise", async () => {
		const calls = [];
		const stubQuery = {
			setModel: async (model) => calls.push(["setModel", model]),
			applyFlagSettings: async (settings) => calls.push(["applyFlagSettings", settings]),
		};
		const c = new (await import("../src/query-state.js")).QueryContext();
		c.activeQuery = stubQuery;

		await __test.applyMidToolChanges(c, { model: "claude-sonnet-5", effort: "high" });
		assert.deepEqual(calls, [
			["setModel", "claude-sonnet-5"],
			["applyFlagSettings", { effortLevel: "high" }],
		], "changed model+effort go through the documented setters");

		// No change → no calls.
		calls.length = 0;
		await __test.applyMidToolChanges(c, { model: "claude-sonnet-5", effort: "high" });
		assert.deepEqual(calls, [], "unchanged state sends no setters");

		// Effort-only change.
		calls.length = 0;
		await __test.applyMidToolChanges(c, { model: "claude-sonnet-5", effort: "max" });
		assert.deepEqual(calls, [["applyFlagSettings", { effortLevel: "max" }]], "effort-only change goes to applyFlagSettings only");

		// No live query → truthful diagnostic path, no throw, no phantom apply.
		c.activeQuery = null;
		calls.length = 0;
		await __test.applyMidToolChanges(c, { model: "claude-opus-5", effort: "low" });
		assert.deepEqual(calls, [], "no query to apply to — nothing claimed as applied");

		// Setter rejects → logged, turn continues, the OTHER setter still gets its
		// independent attempt (partial apply is truthful — each setter reports).
		const failing = {
			setModel: async () => { throw new Error("not applicable mid-set"); },
			applyFlagSettings: async (settings) => calls.push(["applyFlagSettings", settings]),
		};
		const c2 = new (await import("../src/query-state.js")).QueryContext();
		c2.activeQuery = failing;
		calls.length = 0;
		await __test.applyMidToolChanges(c2, { model: "claude-opus-5", effort: "low" });
		assert.deepEqual(calls, [["applyFlagSettings", { effortLevel: "low" }]], "failed setModel is logged, not faked; the independent effort attempt still runs");
	});

	it("fingerprint void parity: system and metadata-free equality for tool ids (sanity)", () => {
		const a = fingerprintProjectedPriors([
			{ role: "toolResult", toolCallId: "x1", content: "same", isError: true },
		]).hash;
		const b = fingerprintProjectedPriors([
			{ role: "toolResult", toolCallId: "x1", content: "same", isError: false },
		]).hash;
		assert.notEqual(a, b, "tool result error flag is fingerprinted");
	});
});
