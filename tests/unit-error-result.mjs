/**
 * CC reports API failures (429 capacity, overload, prompt-too-long) as a result with
 * is_error set while subtype stays "success", after streaming the text as a <synthetic>
 * assistant message. Shape verified against claude-agent-sdk 0.2.141. Without this the
 * turn finalizes as a normal stop and the failure never reaches pi.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };

function fakeStream() {
	const events = [];
	return { events, push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
}

function makeCtx() {
	const c = new QueryContext();
	c.currentPiStream = fakeStream();
	c.resetTurnState(fakeModel);
	return c;
}

async function consume(c, messages) {
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), new Map(), fakeModel, () => false, c, []);
}

const errorResult = {
	type: "result", subtype: "success", is_error: true, api_error_status: 429,
	result: "API Error: Server is temporarily limiting requests (not your usage limit): Rate limited",
	terminal_reason: "model_error",
};

// Shared by the provider turn and the isolated compact summary — the summary path used to
// accept an errored result as a valid summary, writing "Prompt is too long" into history.
describe("resultErrorText", () => {
	it("treats is_error on a success-shaped result as a failure", () => {
		assert.strictEqual(__test.resultErrorText(errorResult), errorResult.result);
	});

	it("returns undefined for a genuine success", () => {
		assert.strictEqual(__test.resultErrorText({ type: "result", subtype: "success", is_error: false, result: "a summary" }), undefined);
	});

	it("joins errors[] for the dedicated error subtypes", () => {
		assert.strictEqual(__test.resultErrorText({ type: "result", subtype: "error_during_execution", errors: ["boom", "bang"] }), "boom\nbang");
	});

	it("never returns an empty message for a failure", () => {
		assert.ok(__test.resultErrorText({ type: "result", subtype: "success", is_error: true, result: "" }));
		assert.ok(__test.resultErrorText({ type: "result", subtype: "error_max_budget_usd" }));
		// errors[] is typed string[], with no promise of being non-empty; joining an
		// empty one marks the turn errored with nothing to show the user.
		assert.ok(__test.resultErrorText({ type: "result", subtype: "error_during_execution", errors: [] }));
	});
});

describe("error results", () => {
	it("marks the turn errored and finalizes with an error event", async () => {
		const c = makeCtx();
		await consume(c, [errorResult]);

		assert.strictEqual(c.turnOutput.stopReason, "error");
		assert.strictEqual(c.turnOutput.errorMessage, errorResult.result);

		const stream = c.currentPiStream;
		__test.finalizeCurrentStream(c, c.turnOutput.stopReason);
		const terminal = stream.events.at(-2);
		assert.strictEqual(terminal.type, "error");
		assert.strictEqual(terminal.reason, "error");
		assert.strictEqual(terminal.error.errorMessage, errorResult.result);
	});

	it("does not re-emit text the synthetic assistant message already delivered", async () => {
		const c = makeCtx();
		await consume(c, [
			{ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: errorResult.result }] } },
			errorResult,
		]);

		const texts = c.turnOutput.content.filter((b) => b.type === "text");
		assert.deepStrictEqual(texts.map((b) => b.text), [errorResult.result]);
	});

	it("still streams and finalizes a successful result normally", async () => {
		const c = makeCtx();
		await consume(c, [{ type: "result", subtype: "success", is_error: false, result: "done" }]);

		assert.strictEqual(c.turnOutput.stopReason, "stop");
		assert.strictEqual(c.turnOutput.errorMessage, undefined);
		assert.deepStrictEqual(c.turnOutput.content, [{ type: "text", text: "done" }]);

		const stream = c.currentPiStream;
		__test.finalizeCurrentStream(c, c.turnOutput.stopReason);
		assert.strictEqual(stream.events.at(-2).type, "done");
	});

	// A turn that ended on a tool call has already closed its pi stream, and the
	// guard that suppresses content events for a closed stream used to swallow the
	// result message with it — so a 429 mid-tool set no stopReason, no
	// errorMessage, and logged nothing at all.
	it("records a failure that arrives after the turn ended on a tool call", async () => {
		const c = makeCtx();
		c.currentPiStream = null; // what the tool boundary leaves behind

		await consume(c, [errorResult]);

		assert.strictEqual(c.turnOutput.stopReason, "error");
		assert.strictEqual(c.turnOutput.errorMessage, errorResult.result);
	});

	it("reports the dedicated error subtypes", async () => {
		const c = makeCtx();
		await consume(c, [{ type: "result", subtype: "error_max_turns", is_error: true, errors: ["hit the cap"] }]);

		assert.strictEqual(c.turnOutput.stopReason, "error");
		assert.strictEqual(c.turnOutput.errorMessage, "hit the cap");
	});
});
