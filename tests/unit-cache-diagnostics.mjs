import { test } from "node:test";
import assert from "node:assert/strict";
import { assessMutationAttribution, compareCacheUsage } from "../diag/lib/cache-effect.mjs";
import { compareRequestBodies } from "../diag/lib/request-diff.mjs";
import { mutateSessionJsonl, mutateSessionRecords } from "../diag/lib/session-mutations.mjs";

const toolResult = (content) => ({ type: "tool_result", tool_use_id: "t1", content, is_error: false });
const body = (messages, system = [{ type: "text", text: "stable" }]) => ({
	tools: [{ name: "probe", input_schema: {} }], system, messages,
});
const blockMessage = (texts) => ({ role: "assistant", content: texts.map((text) => ({ type: "text", text })) });

const validInvariants = {
	modelSame: true, toolsSame: true, thinkingSame: true, normalizedSystemSame: true,
	controlHistoryComplete: true, changedHistoryComplete: true, resumeSessionSame: true,
};

test("raw and normalized comparisons retain nested shape, key order, and original system indices", () => {
	const before = body([{ role: "user", content: "plain" }, { role: "user", content: [toolResult("text")] }]);
	before.system.unshift({ type: "text", text: "x-anthropic-billing-header: before" });
	before.system[1].cache_control = { type: "ephemeral" };
	const after = body([{ role: "user", content: [{ type: "text", text: "plain" }] }, { role: "user", content: [toolResult([{ type: "text", text: "text" }])] }]);
	after.system.unshift({ type: "text", text: "x-anthropic-billing-header: after" });
	after.system[1].cache_control = { type: "ephemeral" };
	after.system[1].text = "changed stable block";
	const diff = compareRequestBodies(before, after);
	assert.ok(diff.raw.aligned.length > diff.normalized.aligned.length);
	assert.deepEqual(diff.normalized.aligned.map((item) => [item.kind, item.path]), [
		["value", "system[1].text"], ["type-or-shape", "messages[1].content[0].content"],
	]);
	const withToolDiff = body([{ role: "user", content: "changed" }]);
	withToolDiff.tools[0].name = "changed";
	const earliest = compareRequestBodies(body([{ role: "user", content: "old" }]), withToolDiff).normalized.aligned[0];
	assert.equal(earliest.path, "tools[0].name");
});

test("middle deletions and insertions retain original before/after paths", () => {
	const removed = compareRequestBodies(
		body([blockMessage(["a", "b", "c", "d"])]),
		body([blockMessage(["a", "d"])]),
	).normalized.aligned;
	assert.deepEqual(removed.map((item) => [item.kind, item.path]), [
		["missing-array-item", "messages[0].content[1]"],
		["missing-array-item", "messages[0].content[2]"],
	]);
	const inserted = compareRequestBodies(
		body([blockMessage(["a", "c"])]),
		body([blockMessage(["a", "b", "c"])]),
	).normalized.aligned;
	assert.equal(inserted.length, 1);
	assert.equal(inserted[0].kind, "added-array-item");
	assert.equal(inserted[0].path, "messages[0].content[1]");
	assert.equal(inserted[0].afterPath, "messages[0].content[1]");
});

test("captured drop-context alignment matches the 7-to-2 block shape without invented substitutions", () => {
	const old = ["block0", "block1", "block2", "surviving block", "block4", "block5", "last block"];
	const after = ["surviving block!", "last block"];
	const diffs = compareRequestBodies(body([blockMessage(old)]), body([blockMessage(after)])).normalized.aligned;
	assert.deepEqual(diffs.map((item) => item.kind), [
		"missing-array-item", "missing-array-item", "missing-array-item", "value", "missing-array-item", "missing-array-item",
	]);
	assert.deepEqual(diffs.filter((item) => item.kind === "missing-array-item").map((item) => item.path), [
		"messages[0].content[0]", "messages[0].content[1]", "messages[0].content[2]", "messages[0].content[4]", "messages[0].content[5]",
	]);
	assert.equal(diffs[3].path, "messages[0].content[3].text");
	assert.equal(diffs[3].afterPath, "messages[0].content[0].text");
	assert.ok(compareRequestBodies(body([blockMessage(old)]), body([blockMessage(after)])).normalized.alignments.some((item) =>
		item.path === "messages[0].content[6]" && item.afterPath === "messages[0].content[1]" && item.unchanged));
});

test("whole-message removal and reordering are reported without substitutions", () => {
	const before = body([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }]);
	const removed = compareRequestBodies(before, body([before.messages[0], before.messages[2]])).normalized.aligned;
	assert.deepEqual(removed.map((item) => [item.kind, item.path]), [["missing-element", "messages[1]"]]);
	const reordered = compareRequestBodies(
		body([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]),
		body([{ role: "assistant", content: "b" }, { role: "user", content: "a" }]),
	).normalized;
	assert.deepEqual(reordered.reordered.map(({ path, from, to }) => [path, from, to]), [["messages[0]", 0, 1], ["messages[1]", 1, 0]]);
	assert.equal(reordered.aligned.length, 2);
	assert.ok(reordered.aligned.every((item) => item.kind === "reordered"));
});

test("prefix alignment retains deletions inside history but excludes generated tails", () => {
	const cached = body([{ role: "user", content: "start" }, { role: "assistant", content: "to delete" }, { role: "user", content: "end" }]);
	const control = body([...cached.messages, { role: "assistant", content: "generated A" }, { role: "user", content: "continuation A" }]);
	const changed = body([cached.messages[0], cached.messages[2], { role: "assistant", content: "generated B" }, { role: "user", content: "continuation B" }]);
	const diff = compareRequestBodies(control, changed, { prefixBody: cached }).normalized.aligned;
	assert.deepEqual(diff.map((item) => [item.kind, item.path]), [["missing-element", "messages[1]"]]);
	const reordered = compareRequestBodies(
		body([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]),
		body([{ role: "assistant", content: "b" }, { role: "user", content: "a" }, { role: "user", content: "new tail" }]),
		{ prefixOnly: true },
	).normalized;
	assert.deepEqual(reordered.reordered.map((item) => [item.from, item.to]), [[0, 1], [1, 0]]);
	assert.equal(reordered.aligned.length, 2);
});

test("nested tool_result key order stays visible while aligned content changes are complete", () => {
	const before = body([{ role: "user", content: [toolResult("old")] }]);
	const after = body([{ role: "user", content: [{ is_error: false, content: "new", tool_use_id: "t1", type: "tool_result" }] }]);
	const changes = compareRequestBodies(before, after).normalized.aligned;
	assert.deepEqual(changes.map((item) => item.kind), ["key-order", "value"]);
	assert.equal(changes[0].path, "messages[0].content[0]");
	assert.equal(changes[1].path, "messages[0].content[0].content");
});

test("cache read loss is capped to the seed prefix and every positive loss is retained", () => {
	const expected = 7914;
	const drop = compareCacheUsage(
		{ cacheRead: 7914, cacheWrite: 57, expected },
		{ cacheRead: 6202, cacheWrite: 1714, expected },
		true,
	);
	assert.equal(drop.status, "measured-cache-read-loss");
	assert.equal(drop.readLoss, 1712);
	assert.equal(drop.rawReadDifference, 1712);
	const shape = compareCacheUsage(
		{ cacheRead: 7971, cacheWrite: 0, expected },
		{ cacheRead: 7811, cacheWrite: 160, expected },
		true,
	);
	assert.equal(shape.readLoss, 103);
	assert.equal(shape.rawReadDifference, 160);
	assert.equal(shape.status, "measured-cache-read-loss");
	const readOnly = compareCacheUsage({ cacheRead: 7914, cacheWrite: null, expected }, { cacheRead: 7000, cacheWrite: null, expected }, true);
	assert.equal(readOnly.status, "measured-cache-read-loss");
	assert.equal(readOnly.writeIncrease, null);
	assert.equal(compareCacheUsage({ cacheRead: 7900, cacheWrite: 0, expected }, { cacheRead: 6200, cacheWrite: 0, expected }, true).status,
		"inconclusive-control-prefix-incomplete");
	const confounded = compareCacheUsage({ cacheRead: 7914, cacheWrite: 0, expected }, { cacheRead: 7000, cacheWrite: 914, expected }, true,
		{ validityIssues: ["normalized-history-changes-outside-target"] });
	assert.equal(confounded.status, "confounded");
	assert.equal(confounded.readLoss, 914);
	assert.equal(compareCacheUsage({ cacheRead: 7914, cacheWrite: 0, expected }, { cacheRead: 6200, cacheWrite: 0, expected }, false).status,
		"not-attributed-no-target-wire-change");
});

test("attribution gates reject unrelated changes and expose surviving-text side effects", () => {
	const shape = assessMutationAttribution("tool-result-content-shape", [
		{ kind: "type-or-shape", path: "messages[2].content[0].content" },
	], validInvariants);
	assert.equal(shape.status, "valid");
	const shapeWithOtherChange = assessMutationAttribution("tool-result-content-shape", [
		{ kind: "type-or-shape", path: "messages[2].content[0].content" },
		{ kind: "value", path: "messages[0].content[3].text", before: { length: 3296 }, after: { length: 3297 } },
	], validInvariants);
	assert.equal(shapeWithOtherChange.status, "confounded");
	assert.equal(shapeWithOtherChange.sideEffects[0].before.length, 3296);
	const drop = assessMutationAttribution("drop-context-attachments", [
		{ kind: "missing-array-item", path: "messages[0].content[0]" },
		{ kind: "value", path: "messages[0].content[3].text", before: { length: 3296 }, after: { length: 3297 } },
	], validInvariants);
	assert.equal(drop.status, "confounded");
	assert.equal(drop.sideEffects[0].path, "messages[0].content[3].text");
	assert.equal(assessMutationAttribution("tool-result-key-order", [{ kind: "key-order", path: "messages[2].content[0]" }],
		{ ...validInvariants, toolsSame: false }).status, "confounded");
});

test("context attachment mutation repairs parent links", () => {
	const records = [
		{ type: "user", uuid: "u", parentUuid: null, message: { content: "prompt" } },
		{ type: "attachment", uuid: "a1", parentUuid: "u", attachment: { type: "environment" } },
		{ type: "attachment", uuid: "a2", parentUuid: "a1", attachment: { type: "date" } },
		{ type: "attachment", uuid: "snap", parentUuid: "a2", attachment: { type: "prompt_snapshot" } },
		{ type: "assistant", uuid: "r", parentUuid: "snap", message: { content: "reply" } },
	];
	const mutation = mutateSessionRecords(records, "drop-context-attachments");
	assert.equal(mutation.changed, 2);
	assert.deepEqual(mutation.records.map((record) => record.uuid), ["u", "snap", "r"]);
	assert.equal(mutation.records[1].parentUuid, "u");
	assert.equal(mutation.records[2].parentUuid, "snap");
});

test("tool-result mutations change representation and preserve key order", () => {
	const records = [{ type: "user", uuid: "u", parentUuid: "a", message: { content: [toolResult("result")] } }];
	const shape = mutateSessionRecords(records, "tool-result-content-shape");
	assert.equal(shape.changed, 1);
	assert.deepEqual(shape.details.transitions, [{ from: "string", to: "array" }]);
	assert.deepEqual(shape.records[0].message.content[0].content, [{ type: "text", text: "result" }]);
	const order = mutateSessionRecords(records, "tool-result-key-order");
	assert.deepEqual(Object.keys(order.records[0].message.content[0]), ["is_error", "content", "tool_use_id", "type"]);
	const parsed = mutateSessionJsonl(`${JSON.stringify(records[0])}\n`, "tool-result-key-order");
	assert.deepEqual(Object.keys(JSON.parse(parsed.jsonl).message.content[0]), ["is_error", "content", "tool_use_id", "type"]);
});
