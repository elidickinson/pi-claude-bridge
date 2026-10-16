/**
 * Claude Code re-runs a request its safeguards flag on a fallback model and reports
 * it only in the reply: a `fallback` block and the served `model`. Later requests
 * can route to the fallback directly, with only `model` telling. pi must be told.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "claude-opus-5-5" };

function makeCtx() {
	const c = new QueryContext();
	c.currentPiStream = { events: [], push() {}, end() {} };
	c.resetTurnState(fakeModel);
	return c;
}

function captureNotices() {
	const notices = [];
	__test.setPiUI({ notify: (msg, level) => notices.push({ msg, level }) });
	return notices;
}

async function consume(c, messages) {
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), new Map(), fakeModel, () => false, c);
}

const reply = (id, model, content = [{ type: "text", text: "ok" }]) =>
	({ type: "assistant", message: { id, model, content } });
const fallbackBlock = { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-4-8" } };

describe("served model differs from the requested one", () => {
	it("warns once per switch and names the safeguard fallback", async () => {
		const notices = captureNotices();
		const c = makeCtx();
		await consume(c, [
			reply("m1", "claude-opus-4-8", [fallbackBlock]),
			reply("m2", "claude-opus-4-8"),
		]);
		assert.strictEqual(notices.length, 1);
		assert.strictEqual(notices[0].level, "warning");
		assert.match(notices[0].msg, /claude-opus-4-8 instead of claude-opus-5-5/);
		assert.match(notices[0].msg, /safeguards flagged/);
		assert.deepStrictEqual(c.turnOutput.content.map((b) => b.type), ["text"], "fallback block stays off the stream");
	});

	it("warns again after the requested model served in between", async () => {
		const notices = captureNotices();
		const c = makeCtx();
		await consume(c, [
			reply("m1", "claude-opus-4-8"),
			reply("m2", "claude-opus-5-5"),
			reply("m3", "claude-opus-4-8"),
		]);
		assert.strictEqual(notices.length, 2);
		assert.doesNotMatch(notices[0].msg, /safeguards/, "no fallback block: sticky routing");
	});

	it("stays quiet for the requested model, its [1m] variant, and synthetic reports", async () => {
		const notices = captureNotices();
		const c = makeCtx();
		await consume(c, [
			reply("m1", "claude-opus-5-5"),
			reply("m2", "claude-opus-5-5[1m]"),
			reply("m3", "<synthetic>"),
		]);
		assert.deepStrictEqual(notices, []);
	});
});
