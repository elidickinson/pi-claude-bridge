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
		// edited_text_file is deliberately not carried: the edit is already in pi's
		// history as a tool call, and it usually hangs off a tool-result record that
		// has no prompt ordinal. See diag/attachment-coverage.mjs.
		assert.deepEqual(carried.map((c) => c.attachment.filename), ["/a.js"]);
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

	it("keeps session-start context in its original position, so a rebuilt prefix stays cacheable", () => {
		// Dropped, CC re-attaches these to the NEWEST prompt on the rebuilt session,
		// so the request differs at messages[0] and the whole history misses the
		// prompt cache. Carried, they stay on the first prompt as in the live session.
		const kinds = ["environment", "model", "output_style_instructions", "total_tokens_reminder",
			"output_style", "instructions", "session_context", "date", "credential_org"];
		const records = [user("u1", "first")];
		let parent = "u1";
		kinds.forEach((k, i) => { records.push(attach(`c${i}`, parent, k)); parent = `c${i}`; });
		records.push(attach("snap", parent, "prompt_snapshot"));
		const carried = collectCarriedAttachments(records);
		assert.deepEqual(carried.map((c) => c.attachment.type), kinds);
		assert.ok(carried.every((c) => c.userOrdinal === 0 && c.parentText === "first"));
	});

	it("carries the instruction-file block whole, so the rebuilt prompt shows the model the same memory", () => {
		// Only present in folders with a memory dir or instruction files; before it was
		// carried, CC re-attached it after credential_org on the newest prompt and the
		// rebuilt history missed the cache (live: 12,776 read / 14,677 written).
		const files = [{ path: "/p/memory/MEMORY.md", type: "AutoMem", content: "# Memory Index\n- [Fact](fact.md)" }];
		const carried = collectCarriedAttachments([
			user("u1", "first"),
			{ type: "attachment", uuid: "i1", parentUuid: "u1", attachment: { type: "instructions", files } },
		]);
		assert.equal(carried.length, 1);
		assert.deepEqual(carried[0].attachment, { type: "instructions", files });
		assert.equal(carried[0].userOrdinal, 0);
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

describe("attachments chained to other attachments", () => {
	it("inherits the ordinal up a run so the whole run keys to one prompt", () => {
		const carried = collectCarriedAttachments([
			user("u1", "first"),
			user("u2", "edit the files"),
			attach("a1", "u2", "file", "/a.js"),
			attach("a2", "a1", "edited_text_file", "/b.js"),
			attach("a3", "a2", "file", "/c.js"),
		]);
		// The uncarried kind still has to resolve, or the run breaks after it.
		assert.deepEqual(carried.map((c) => c.attachment.filename), ["/a.js", "/c.js"]);
		assert.deepEqual(carried.map((c) => c.userOrdinal), [1, 1]);
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
