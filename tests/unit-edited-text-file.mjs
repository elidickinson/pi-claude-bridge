#!/usr/bin/env node
// Unit tests for carrying edited_text_file file snapshots across a rebuild:
// collect → convert → repair → place, end to end at unit level.
//
// Note: tests/int-attachment-rebuild.mjs seeds a synthetic "file" attachment via
// the RPC; that pattern is not native edited_text_file evidence. These tests use
// the shapes Claude Code actually writes: an attachment record parented to the
// user record holding the tool_result (or chained through other attachments).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertPiMessages } from "../src/convert.js";
import { collectCarriedAttachments, placeCarriedAttachments } from "../src/attachments.js";

const user = (uuid, text) => ({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text }] } });
// Claude Code's live writer: one tool_result per user record.
const toolResultUser = (uuid, parentUuid, id, content, isError = false) => ({
	type: "user", uuid, parentUuid,
	message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, isError }] },
});
const attach = (uuid, parentUuid, type, filename) => ({
	type: "attachment", uuid, parentUuid, attachment: { type, filename },
});
// The pi-history shape that produced the tool result above.
const piEdit = (id, result) => [
	{ role: "assistant", provider: "claude-bridge", content: [{ type: "toolCall", id, name: "edit", arguments: {} }] },
	{ role: "toolResult", toolCallId: id, content: [{ type: "text", text: result }], isError: false },
];

// Full pipeline: CC records → carried → pi history → repaired messages → placement.
function run(records, history) {
	const carried = collectCarriedAttachments(records);
	const { anthropicMessages, sanitizedIds } = convertPiMessages(history);
	return { carried, sanitizedIds, placed: placeCarriedAttachments(carried, anthropicMessages, sanitizedIds) };
}

describe("edited_text_file carried across a rebuild", () => {
	it("lands after the rebuilt tool result, id translated through sanitization", () => {
		const { placed } = run(
			[user("u1", "edit b.js"), toolResultUser("u2", "u1", "toolu_01A", "done"), attach("a1", "u2", "edited_text_file", "/b.js")],
			[...piEdit("toolu_01A", "done"), user("u3", "next")],
		);
		assert.equal(placed.skipped.length, 0);
		// [0] assistant tool_use, [1] user tool_result, [2] next prompt.
		assert.deepEqual(placed.attachments.map((a) => a.afterIndex), [1]);
	});

	it("keeps working when sanitization rewrites the id", () => {
		const id = "toolu_01A+b/ad";
		const { placed } = run(
			[user("u1", "edit b.js"), toolResultUser("u2", "u1", id, "done"), attach("a1", "u2", "edited_text_file", "/b.js")],
			[...piEdit(id, "done")],
		);
		assert.equal(placed.skipped.length, 0);
		assert.equal(placed.attachments[0].afterIndex, 1);
	});

	it("attaches after the merged message when parallel results collapse into one", () => {
		const records = [
			user("u1", "edit both"),
			toolResultUser("u2", "u1", "toolu_01A", "first edit"),
			toolResultUser("u3", "u2", "toolu_01B", "second edit"),
			attach("a1", "u2", "edited_text_file", "/a.js"),
			attach("a2", "u3", "edited_text_file", "/b.js"),
		];
		// One parallel turn: one assistant message with both calls, two results after.
		const history = [
			{ role: "assistant", provider: "claude-bridge", content: [
				{ type: "toolCall", id: "toolu_01A", name: "edit", arguments: {} },
				{ type: "toolCall", id: "toolu_01B", name: "edit", arguments: {} },
			] },
			{ role: "toolResult", toolCallId: "toolu_01A", content: [{ type: "text", text: "first edit" }], isError: false },
			{ role: "toolResult", toolCallId: "toolu_01B", content: [{ type: "text", text: "second edit" }], isError: false },
		];
		const { placed } = run(records, history);
		assert.equal(placed.skipped.length, 0);
		// Both results merge into message [1]; each snapshot follows that message.
		// Information is preserved; CC's original record interleaving is not.
		assert.deepEqual(placed.attachments.map((a) => a.afterIndex), [1, 1]);
		assert.deepEqual(placed.attachments.map((a) => a.attachment.filename), ["/a.js", "/b.js"]);
	});

	it("drops the snapshot when the tool result changed under the same id", () => {
		const { placed } = run(
			[user("u1", "edit b.js"), toolResultUser("u2", "u1", "toolu_01A", "done"), attach("a1", "u2", "edited_text_file", "/b.js")],
			[...piEdit("toolu_01A", "rewritten differently")],
		);
		assert.equal(placed.attachments.length, 0);
		assert.match(placed.skipped[0], /changed/);
	});

	it("drops the snapshot when the result's error flag changed", () => {
		const history = [
			{ role: "assistant", provider: "claude-bridge", content: [{ type: "toolCall", id: "toolu_01A", name: "edit", arguments: {} }] },
			{ role: "toolResult", toolCallId: "toolu_01A", content: [{ type: "text", text: "done" }], isError: true },
		];
		const { placed } = run(
			[user("u1", "edit b.js"), toolResultUser("u2", "u1", "toolu_01A", "done"), attach("a1", "u2", "edited_text_file", "/b.js")],
			history,
		);
		assert.equal(placed.attachments.length, 0);
		assert.match(placed.skipped[0], /changed/);
	});

	it("drops the snapshot when the edit was pruned from history", () => {
		const { placed } = run(
			[user("u1", "edit b.js"), toolResultUser("u2", "u1", "toolu_01A", "done"), attach("a1", "u2", "edited_text_file", "/b.js")],
			[user("u9", "unrelated history only")],
		);
		assert.equal(placed.attachments.length, 0);
		assert.match(placed.skipped[0], /no longer in history/);
	});

	it("drops the snapshot when the tool call was pruned but the result id survives nowhere", () => {
		// Anchor's id present in neither history nor conversion map.
		const carried = collectCarriedAttachments([
			user("u1", "edit b.js"), toolResultUser("u2", "u1", "toolu_ZZZ", "done"), attach("a1", "u2", "edited_text_file", "/b.js"),
		]);
		const { anthropicMessages, sanitizedIds } = convertPiMessages([...piEdit("toolu_other", "done")]);
		const placed = placeCarriedAttachments(carried, anthropicMessages, sanitizedIds);
		assert.equal(placed.attachments.length, 0);
	});

	it("drops the snapshot when two tool calls sanitize to the same id", () => {
		const records = [
			user("u1", "edit"), toolResultUser("u2", "u1", "a.b", "done"), attach("a1", "u2", "edited_text_file", "/b.js"),
		];
		const history = [...piEdit("a.b", "done"), ...piEdit("a_b", "done")];
		const { placed } = run(records, history);
		assert.equal(placed.attachments.length, 0);
		assert.match(placed.skipped[0], /ambiguous/);
	});

	it("emits no duplicates across repeated rebuilds of the same history", () => {
		const records = [user("u1", "edit b.js"), toolResultUser("u2", "u1", "toolu_01A", "done"), attach("a1", "u2", "edited_text_file", "/b.js")];
		const history = [...piEdit("toolu_01A", "done")];
		const first = run(records, history).placed;
		const second = run(records, history).placed;
		assert.deepEqual(second, first);
		assert.equal(second.attachments.length, 1);
	});
});
