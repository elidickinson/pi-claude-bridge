#!/usr/bin/env node

/**
 * A lane whose request carries another lane's history is seeded from that lane's
 * session file, not rebuilt from pi's messages.
 *
 * The prompt cache is keyed on the request prefix, and Claude Code rebuilds its request
 * from whatever JSONL it resumes. A session built by importing pi's message array
 * serialises the same conversation differently from one Claude Code appended to itself,
 * so an imported copy shares only the system prompt and tool table with the original
 * and re-writes the whole conversation at cache-write price. A byte copy of the
 * original file resumes with the original's exact prefix.
 *
 * These pin the seeding rule: by content, never by length alone; re-seeded when the
 * donor has moved on; the lane's own id kept unless an abort said to rotate; and a
 * donor that cannot be read falls through to the rebuild that ran before.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, deleteSession, getSessionPath, openSession } from "cc-session-io";

const { __test } = await import("../src/index.js");

const CONVERSATION = "00000000-0000-4000-8000-000000000001";
const SIDE = `${CONVERSATION}-notes`;

// A record shape only Claude Code writes, never an import. Its presence in a lane's file
// proves the file was copied rather than rebuilt.
const DONOR_MARKER = JSON.stringify({ type: "summary", summary: "DONOR-MARKER", leafUuid: "00000000-0000-4000-8000-0000000000aa" });

const turn = (n) => [
	{ role: "user", content: `question ${n}`, timestamp: 1000 + n },
	{ role: "assistant", content: [{ type: "text", text: `answer ${n}` }], timestamp: 1001 + n },
];

/** A conversation lane with a real session file holding `turns` turns. */
function seedConversation(cwd, turns) {
	const history = Array.from({ length: turns }, (_, i) => turn(i)).flat();
	const sessionId = randomUUID();
	const session = createSession({ sessionId, projectPath: cwd });
	session.importMessages(history.map(({ role, content }) => ({ role, content })));
	session.save();
	appendFileSync(getSessionPath(sessionId, cwd), `${DONOR_MARKER}\n`);
	__test.setSharedSession({ sessionId, cursor: history.length, cwd, history }, CONVERSATION);
	return { sessionId, history };
}

function fileOf(sessionId, cwd) {
	return readFileSync(getSessionPath(sessionId, cwd), "utf8");
}

describe("seeding a lane from a matching history", () => {
	let cwd;
	afterEach(() => {
		__test.resetSharedSession();
		__test.setPiUI(null);
		if (cwd) rmSync(cwd, { recursive: true, force: true });
		cwd = undefined;
	});

	it("copies the donor's file under the new lane's own id, donor untouched", () => {
		cwd = mkdtempSync(join(tmpdir(), "lane-copy-"));
		const donor = seedConversation(cwd, 2);
		const donorFileBefore = fileOf(donor.sessionId, cwd);

		const result = __test.syncSharedSession(
			[...donor.history, { role: "user", content: "Summarize the conversation above.", timestamp: 9 }],
			cwd, undefined, "claude-haiku-4-5", SIDE,
		);

		assert.ok(result.sessionId, "the lane must resume a session");
		assert.notEqual(result.sessionId, donor.sessionId, "a copy, not the donor's own file");
		const copied = fileOf(result.sessionId, cwd);
		assert.match(copied, /DONOR-MARKER/, "the file is the donor's bytes, not a rebuild from pi's messages");
		assert.ok(copied.includes(`"sessionId":"${result.sessionId}"`), "sessionId rewritten to the lane's id");
		assert.ok(!copied.includes(donor.sessionId), "no record still names the donor");
		assert.equal(fileOf(donor.sessionId, cwd), donorFileBefore, "the donor's file is not modified");
		assert.equal(__test.getSharedSession(CONVERSATION).sessionId, donor.sessionId, "nor its lane state");
		assert.equal(__test.getSharedSession(SIDE).cursor, donor.history.length);
	});

	it("does not seed from a lane whose history merely has the same length", () => {
		cwd = mkdtempSync(join(tmpdir(), "lane-copy-"));
		const donor = seedConversation(cwd, 2);
		const other = [turn(7), turn(8)].flat();
		assert.equal(other.length, donor.history.length);

		const result = __test.syncSharedSession(
			[...other, { role: "user", content: "next", timestamp: 9 }],
			cwd, undefined, "claude-haiku-4-5", SIDE,
		);

		assert.ok(result.sessionId);
		assert.doesNotMatch(fileOf(result.sessionId, cwd), /DONOR-MARKER/, "a different conversation must be rebuilt, not copied");
		assert.equal(openSession({ sessionId: result.sessionId, projectPath: cwd }).messages.length, other.length);
	});

	it("tolerates the donor's trailing assistant reply, as reuse does", () => {
		cwd = mkdtempSync(join(tmpdir(), "lane-copy-"));
		const donor = seedConversation(cwd, 2);
		// The donor's lane cursor lags one assistant message behind the file, exactly the
		// drift REUSE advances over without a rebuild.
		__test.setSharedSession({ ...__test.getSharedSession(CONVERSATION), cursor: donor.history.length - 1 }, CONVERSATION);

		const result = __test.syncSharedSession(
			[...donor.history, { role: "user", content: "next", timestamp: 9 }],
			cwd, undefined, "claude-haiku-4-5", SIDE,
		);

		assert.match(fileOf(result.sessionId, cwd), /DONOR-MARKER/);
	});

	it("re-seeds when the donor has moved on, keeping the lane's own id", () => {
		cwd = mkdtempSync(join(tmpdir(), "lane-copy-"));
		const donor = seedConversation(cwd, 1);
		const first = __test.syncSharedSession(
			[...donor.history, { role: "user", content: "pass 1", timestamp: 9 }],
			cwd, undefined, "claude-haiku-4-5", SIDE,
		);
		assert.match(fileOf(first.sessionId, cwd), /DONOR-MARKER/);

		// The conversation takes another turn; the donor's file and cursor advance.
		const grown = seedConversation(cwd, 3);
		deleteSession(donor.sessionId, cwd);

		const second = __test.syncSharedSession(
			[...grown.history, { role: "user", content: "pass 2", timestamp: 9 }],
			cwd, undefined, "claude-haiku-4-5", SIDE,
		);

		assert.equal(second.sessionId, first.sessionId, "same lane, same id: no file left behind per pass");
		assert.equal(__test.getSharedSession(SIDE).cursor, grown.history.length);
		assert.equal(openSession({ sessionId: second.sessionId, projectPath: cwd }).messages.length, grown.history.length, "the copy is the grown file");
	});

	it("rotates the id after an abort instead of overwriting a file a dead process may still write", () => {
		cwd = mkdtempSync(join(tmpdir(), "lane-copy-"));
		const donor = seedConversation(cwd, 1);
		const first = __test.syncSharedSession(
			[...donor.history, { role: "user", content: "pass 1", timestamp: 9 }],
			cwd, undefined, "claude-haiku-4-5", SIDE,
		);
		__test.setSharedSession({ ...__test.getSharedSession(SIDE), needsRebuild: true, forceRotate: true }, SIDE);

		const second = __test.syncSharedSession(
			[...donor.history, { role: "user", content: "pass 2", timestamp: 9 }],
			cwd, undefined, "claude-haiku-4-5", SIDE,
		);

		assert.notEqual(second.sessionId, first.sessionId);
		assert.match(fileOf(second.sessionId, cwd), /DONOR-MARKER/, "still a copy, just under a fresh id");
		assert.ok(!existsSync(getSessionPath(first.sessionId, cwd)), "the rotated-away file is this lane's own and is never resumed again: not left behind");
		assert.ok(existsSync(getSessionPath(donor.sessionId, cwd)), "the donor's file is not what rotation drops");
	});

	it("falls through to a rebuild when the donor's file cannot be read", () => {
		cwd = mkdtempSync(join(tmpdir(), "lane-copy-"));
		const donor = seedConversation(cwd, 2);
		rmSync(getSessionPath(donor.sessionId, cwd));
		assert.ok(!existsSync(getSessionPath(donor.sessionId, cwd)));

		const result = __test.syncSharedSession(
			[...donor.history, { role: "user", content: "next", timestamp: 9 }],
			cwd, undefined, "claude-haiku-4-5", SIDE,
		);

		assert.ok(result.sessionId, "the request is still served");
		assert.equal(openSession({ sessionId: result.sessionId, projectPath: cwd }).messages.length, donor.history.length, "rebuilt from pi's messages");
	});
});
