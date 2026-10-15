#!/usr/bin/env node
// Unit tests for forking CC's session when pi's history goes back to an earlier turn (tree-fork.ts).

import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, openSession } from "cc-session-io";
import { findForkPoint, fingerprint } from "../src/tree-fork.js";

const { __test } = await import("../src/index.js");

let clock = 1000;
const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: clock++ });
const assistant = (text, stopReason = "stop") => ({ role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: clock++ });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }], timestamp: clock++ });

// CC's records for the same three turns: each prompt chains off whatever CC
// recorded last, which is not always the assistant message (here, an attachment).
const prompt = (uuid, parentUuid, text) => ({ type: "user", uuid, parentUuid, message: { role: "user", content: [{ type: "text", text }] } });
const reply = (uuid, parentUuid) => ({ type: "assistant", uuid, parentUuid, message: { role: "assistant", content: [{ type: "text", text: "r" }] } });
const attachment = (uuid, parentUuid) => ({ type: "attachment", uuid, parentUuid, attachment: { type: "total_tokens_reminder" } });

const u1 = user("one"), a1 = assistant("A"), u2 = user("two"), a2 = assistant("B"), u3 = user("three");
const synced = [u1, a1, u2, a2, u3].map(fingerprint);
const records = [
	prompt("p1", null, "one"), reply("r1", "p1"), attachment("x1", "r1"),
	prompt("p2", "x1", "two"), reply("r2", "p2"),
	prompt("p3", "r2", "three"),
];

describe("findForkPoint", () => {
	it("forks at the chain entry before the first dropped prompt", () => {
		assert.deepEqual(findForkPoint([u1, a1], synced, records), { uuid: "x1" });
		assert.deepEqual(findForkPoint([u1, a1, u2, a2], synced, records), { uuid: "r2" });
	});

	it("refuses a history that is not shorter than the synced one", () => {
		assert.match(findForkPoint([u1, a1, u2, a2, u3], synced, records).reason, /not shorter/);
	});

	it("refuses a history that is not a prefix of the synced one, such as a branch summary", () => {
		assert.match(findForkPoint([u1, user("summary of the branch")], synced, records).reason, /diverges/);
	});

	it("refuses a history holding a message with no timestamp, which a fingerprint cannot identify", () => {
		const bare = { role: "assistant", content: [{ type: "text", text: "injected" }], stopReason: "stop" };
		const s = [u1, bare, u2].map(fingerprint);
		assert.match(findForkPoint([u1, bare], s, records).reason, /no timestamp/);
	});

	it("refuses a cut in the middle of a turn", () => {
		const call = assistant("calling", "toolUse");
		const result = toolResult("t1");
		const s = [u1, call, result, assistant("done"), u2].map(fingerprint);
		assert.match(findForkPoint([u1, call], s, records).reason, /mid-turn/);
		assert.match(findForkPoint([u1, call, result], s, records).reason, /mid-turn/);
	});

	it("refuses when CC's prompts do not match pi's, as when CC recorded a steer as an attachment", () => {
		const other = [prompt("p1", null, "something else"), reply("r1", "p1"), prompt("p2", "r1", "two"), reply("r2", "p2"), prompt("p3", "r2", "three")];
		assert.match(findForkPoint([u1, a1], synced, other).reason, /prompt 0 differs/);
	});

	it("refuses when CC's session does not reach the next prompt", () => {
		assert.match(findForkPoint([u1, a1], synced, records.slice(0, 3)).reason, /has 1 prompts, the synced history 3/);
	});

	// A prompt CC holds that pi does not (a steer CC recorded as a prompt, an
	// AskClaude call) shifts every later prompt: cutting by count would land a turn late.
	it("refuses when CC's session holds a prompt pi's history does not", () => {
		const extra = [
			prompt("p1", null, "one"), reply("r1", "p1"),
			prompt("steer", "r1", "also do this"), reply("rs", "steer"),
			prompt("p2", "rs", "two"), reply("r2", "p2"),
			prompt("p3", "r2", "three"),
		];
		assert.match(findForkPoint([u1, a1], synced, extra).reason, /has 4 prompts, the synced history 3/);
	});

	// An image-only prompt has no text, yet it is a turn in CC's session: skipping
	// it would match pi's next prompt against the wrong record.
	it("counts a prompt with no text", () => {
		const img = { role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: clock++ };
		const b1 = assistant("saw it"), u5 = user("five");
		const s = [img, b1, u5].map(fingerprint);
		const imgRecords = [
			{ type: "user", uuid: "pi", parentUuid: null, message: { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] } },
			reply("ri", "pi"),
			prompt("p5", "ri", "five"),
		];
		assert.deepEqual(findForkPoint([img, b1], s, imgRecords), { uuid: "ri" });
		// The image prompt is the one dropped.
		const s2 = [u1, a1, img, b1].map(fingerprint);
		assert.deepEqual(findForkPoint([u1, a1], s2, [prompt("p1", null, "one"), reply("r1", "p1"), { ...imgRecords[0], parentUuid: "r1" }, reply("ri", "pi")]), { uuid: "r1" });
	});

	it("skips tool-result records and sidechains when counting prompts", () => {
		const withTools = [
			prompt("p1", null, "one"),
			{ type: "user", uuid: "tr", parentUuid: "p1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [] }] } },
			{ ...prompt("side", "tr", "a subagent prompt"), isSidechain: true },
			reply("r1", "tr"),
			prompt("p2", "r1", "two"),
		];
		assert.deepEqual(findForkPoint([u1, a1], [u1, a1, u2].map(fingerprint), withTools), { uuid: "r1" });
	});
});

describe("syncSharedSession on a trimmed history", () => {
	const cwd = mkdtempSync(join(tmpdir(), "tree-fork-"));
	after(() => rmSync(cwd, { recursive: true, force: true }));
	afterEach(() => __test.resetSharedSession());

	const history = [user("one"), assistant("A"), user("two"), assistant("B"), user("three")];
	const branch = [history[0], history[1], user("other branch")];

	/** A CC session holding `history` plus a `file` attachment on its first prompt. */
	function seed() {
		const sessionId = randomUUID();
		const session = createSession({ sessionId, projectPath: cwd });
		session.importMessages(history.map(({ role, content }) => ({ role, content })));
		session.save();
		const first = session.records.find((r) => r.type === "user");
		appendFileSync(session.jsonlPath, JSON.stringify({
			type: "attachment", uuid: randomUUID(), parentUuid: first.uuid, isSidechain: false, sessionId,
			attachment: { type: "file", filename: "/a.js", content: { type: "text", file: { filePath: "/a.js", content: "x" } } },
		}) + "\n");
		return { sessionId, secondPrompt: openSession({ sessionId, projectPath: cwd }).records.filter((r) => r.type === "user")[1] };
	}

	it("forks the session at the cut and records the source until CC writes the fork", () => {
		const { sessionId, secondPrompt } = seed();
		__test.setSharedSession(null, { sessionId, cursor: 4, cwd, needsRebuild: true, synced: history.map(fingerprint) });
		const result = __test.syncSharedSession(branch, cwd, undefined, undefined, null, true);
		assert.equal(result.sessionId, sessionId);
		assert.equal(result.fork?.at, secondPrompt.parentUuid);
		const state = __test.getSharedSession(null);
		assert.equal(state.sessionId, result.fork.sessionId);
		assert.deepEqual(state.forkedFrom, { sessionId });
		assert.equal(state.needsRebuild, undefined);
	});

	it("rebuilds instead when forking is not allowed", () => {
		const { sessionId } = seed();
		__test.setSharedSession(null, { sessionId, cursor: 4, cwd, needsRebuild: true, synced: history.map(fingerprint) });
		const result = __test.syncSharedSession(branch, cwd, undefined, undefined, null, false);
		assert.equal(result.fork, undefined);
		assert.equal(result.sessionId, sessionId);
	});

	// The fork's query failed before CC wrote it: resuming its id would find no
	// conversation, so rebuild it, carrying attachments from the source session.
	it("rebuilds a fork CC never wrote, with the source session's attachments", () => {
		const { sessionId } = seed();
		__test.setSharedSession(null, { sessionId, cursor: 4, cwd, needsRebuild: true, synced: history.map(fingerprint) });
		const forkedId = __test.syncSharedSession(branch, cwd, undefined, undefined, null, true).fork.sessionId;
		const result = __test.syncSharedSession([...branch, assistant("C"), user("again")], cwd, undefined, undefined, null, true);
		assert.equal(result.fork, undefined);
		// A new id: the fork's CC process may still write the old one.
		assert.notEqual(result.sessionId, forkedId);
		assert.notEqual(result.sessionId, sessionId);
		assert.equal(__test.getSharedSession(null).forkedFrom, undefined);
		const records = openSession({ sessionId: result.sessionId, projectPath: cwd }).records;
		assert.ok(records.some((r) => r.type === "attachment" && r.attachment.filename === "/a.js"), "the source's attachment is carried");
	});

	it("keeps a fork CC wrote and resumes it", () => {
		const { sessionId } = seed();
		__test.setSharedSession(null, { sessionId, cursor: 4, cwd, needsRebuild: true, synced: history.map(fingerprint) });
		const forkedId = __test.syncSharedSession(branch, cwd, undefined, undefined, null, true).fork.sessionId;
		const written = createSession({ sessionId: forkedId, projectPath: cwd });
		written.importMessages([...branch, assistant("C")].map(({ role, content }) => ({ role, content })));
		written.save();
		const result = __test.syncSharedSession([...branch, assistant("C"), user("again")], cwd, undefined, undefined, null, true);
		assert.equal(result.sessionId, forkedId);
		assert.equal(__test.getSharedSession(null).forkedFrom, undefined);
	});
});
