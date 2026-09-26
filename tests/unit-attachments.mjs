#!/usr/bin/env node
// Unit tests for carrying CC attachments across a rebuild (attachments.ts).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectCarriedAttachments, placeCarriedAttachments } from "../src/attachments.js";

const user = (uuid, text) => ({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] } });
const toolResultUser = (uuid) => ({
	type: "user", uuid,
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
});
const attach = (uuid, parentUuid, type, filename) => ({
	type: "attachment", uuid, parentUuid, attachment: { type, filename },
});

describe("collectCarriedAttachments", () => {
	it("keeps content-bearing kinds and drops the ones CC regenerates", () => {
		const carried = collectCarriedAttachments([
			user("u1", "review @a.js"),
			attach("a1", "u1", "file", "/a.js"),
			attach("a2", "u1", "skill_listing"),
			attach("a3", "u1", "task_reminder"),
			attach("a4", "u1", "edited_text_file", "/b.js"),
		]);
		// edited_text_file is carried too. Here it hangs off a prompt, so it keys to
		// that prompt's ordinal; off a tool result it uses the tool-result anchor
		// instead (see the edited_text_file describe block below).
		assert.deepEqual(carried.map((c) => c.attachment.filename), ["/a.js", "/b.js"]);
	});

	it("counts ordinals over prompts only, skipping tool-result user records", () => {
		const carried = collectCarriedAttachments([
			user("u1", "first"),
			toolResultUser("u2"),
			user("u3", "review @a.js"),
			attach("a1", "u3", "file", "/a.js"),
		]);
		assert.equal(carried[0].userOrdinal, 1);
		assert.equal(carried[0].parentText, "review @a.js");
	});

	it("ignores an attachment whose parent is not a prompt", () => {
		const carried = collectCarriedAttachments([
			user("u1", "first"),
			attach("a1", "missing-uuid", "file", "/a.js"),
		]);
		assert.equal(carried.length, 0);
	});
});

describe("placeCarriedAttachments", () => {
	const carried = [{ attachment: { type: "file", filename: "/a.js" }, userOrdinal: 1, parentText: "review @a.js" }];

	it("resolves the ordinal to an index in the array being imported", () => {
		const { attachments, skipped } = placeCarriedAttachments(carried, [
			{ role: "user", content: "first" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{ role: "user", content: [{ type: "text", text: "review @a.js" }] },
		]);
		assert.equal(skipped.length, 0);
		assert.deepEqual(attachments, [{ afterIndex: 2, attachment: carried[0].attachment }]);
	});

	it("drops it when that prompt changed rather than guessing", () => {
		const { attachments, skipped } = placeCarriedAttachments(carried, [
			{ role: "user", content: "first" },
			{ role: "user", content: "something else entirely" },
		]);
		assert.equal(attachments.length, 0);
		assert.match(skipped[0], /changed/);
	});

	it("drops it when history no longer reaches that prompt", () => {
		const { attachments, skipped } = placeCarriedAttachments(carried, [{ role: "user", content: "first" }]);
		assert.equal(attachments.length, 0);
		assert.match(skipped[0], /no longer in history/);
	});
});

describe("attachments anchored to tool results (edited_text_file)", () => {
	// Real CC shape: the snapshot hangs off the user record holding the tool result.
	const toolResultUser = (uuid, parentUuid, id, content, isError) => ({
		type: "user", uuid, parentUuid,
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, isError }] },
	});

	it("carries a snapshot hanging off a tool-result record", () => {
		const carried = collectCarriedAttachments([
			user("u1", "edit b.js"),
			toolResultUser("u2", "u1", "toolu_01A", "edited 3 lines"),
			attach("a1", "u2", "edited_text_file", "/b.js"),
		]);
		assert.equal(carried.length, 1);
		assert.equal(carried[0].toolUseId, "toolu_01A");
		assert.equal(carried[0].resultText, "edited 3 lines");
		assert.equal(carried[0].isError, false);
	});

	it("still does not carry a file expansion hanging off a tool result", () => {
		// @file expansions belong to prompts; the tool-result anchor path is only
		// for kinds CC records after a tool ran.
		const carried = collectCarriedAttachments([
			user("u1", "go"),
			toolResultUser("u2", "u1", "toolu_01A", "out"),
			attach("a1", "u2", "file", "/a.js"),
		]);
		assert.equal(carried.length, 0);
	});

	it("resolves up a chain of attachments to the tool result", () => {
		const carried = collectCarriedAttachments([
			user("u1", "go"),
			toolResultUser("u2", "u1", "toolu_01A", "out"),
			attach("a1", "u2", "skill_listing"),
			attach("a2", "a1", "edited_text_file", "/b.js"),
		]);
		assert.equal(carried[0].toolUseId, "toolu_01A");
	});

	it("drops the anchor when the record holds several results", () => {
		const ambiguous = {
			type: "user", uuid: "u2", parentUuid: "u1",
			message: { role: "user", content: [
				{ type: "tool_result", tool_use_id: "t1", content: "one" },
				{ type: "tool_result", tool_use_id: "t2", content: "two" },
			] },
		};
		assert.equal(collectCarriedAttachments([
			user("u1", "go"), ambiguous, attach("a1", "u2", "edited_text_file", "/b.js"),
		]).length, 0);
	});
});

describe("attachments chained to other attachments", () => {
	it("inherits the anchor up a run so the whole run keys to one prompt", () => {
		const carried = collectCarriedAttachments([
			user("u1", "first"),
			user("u2", "edit the files"),
			attach("a1", "u2", "file", "/a.js"),
			attach("a2", "a1", "edited_text_file", "/b.js"),
			attach("a3", "a2", "file", "/c.js"),
		]);
		assert.deepEqual(carried.map((c) => c.attachment.filename), ["/a.js", "/b.js", "/c.js"]);
		assert.deepEqual(carried.map((c) => c.userOrdinal), [1, 1, 1]);
	});

	it("resolves through a kind it does not carry", () => {
		const carried = collectCarriedAttachments([
			user("u1", "go"),
			attach("a1", "u1", "skill_listing"),
			attach("a2", "a1", "file", "/a.js"),
		]);
		assert.deepEqual(carried.map((c) => c.attachment.filename), ["/a.js"]);
		assert.equal(carried[0].userOrdinal, 0);
	});
});
