/**
 * CC reports API failures (429 capacity, overload, prompt-too-long) as a result with
 * is_error set while subtype stays "success", after streaming the text as a <synthetic>
 * assistant message. The result shape (is_error with subtype "success") is pinned
 * live against the installed SDK in tests/int-cc-contracts.mjs. Without this the
 * turn finalizes as a normal stop and the failure never reaches pi.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const toolMap = new Map([["mcp__custom-tools__bash", "bash"]]);

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
	await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);
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

// pi carries a failure only as errorMessage text, so every consumer that reacts to a rate
// limit pattern-matches it. These mirror pi-subagents' gate (model-fallback.ts): one pattern
// from its retryable list, and the tool-failure shape it refuses to retry.
const RETRYABLE = /rate\s*limit/i;
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i;

describe("a rate-limited failure", () => {
	// Claude Code words a subscription limit with none of the vocabulary anyone matches on,
	// and sends the rejection as its own message just before the failure it caused.
	const rejection = {
		type: "rate_limit_event",
		rate_limit_info: { status: "rejected", resetsAt: 1786141800, rateLimitType: "five_hour" },
	};
	const limitResult = {
		type: "result", subtype: "success", is_error: true,
		result: "You're out of extra usage \u00b7 resets 6:30pm (America/New_York)",
	};

	it("is named as a rate limit so fallback chains fire", async () => {
		const c = makeCtx();
		await consume(c, [rejection, limitResult]);

		assert.match(c.turnOutput.errorMessage, RETRYABLE);
		assert.doesNotMatch(c.turnOutput.errorMessage, TOOL_FAILURE_PREFIX);
		assert.ok(c.turnOutput.errorMessage.includes(limitResult.result), "keeps Claude Code's own wording");
		assert.ok(c.turnOutput.errorMessage.includes("five_hour"));
	});

	it("labels only the failure it caused, not a later one", async () => {
		const c = makeCtx();
		await consume(c, [rejection, limitResult, errorResult]);

		assert.strictEqual(c.turnOutput.errorMessage, errorResult.result);
	});

	it("leaves an unrelated failure alone", async () => {
		const c = makeCtx();
		await consume(c, [errorResult]);
		assert.strictEqual(c.turnOutput.errorMessage, errorResult.result);
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

	// A consumer that fails over only before output commits, such as
	// pi-model-fallback-alias, cannot reach the next provider if Claude Code's own
	// failure report counts as output. Such a consumer commits on anything that is
	// not a start or thinking event, so only that prefix may precede the terminal
	// error.
	it("keeps a synthetic report off the stream, so failover is still possible", async () => {
		const c = makeCtx();
		await consume(c, [
			{ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: errorResult.result }] } },
			errorResult,
		]);

		const stream = c.currentPiStream;
		__test.finalizeCurrentStream(c, c.turnOutput.stopReason);

		const beforeTerminal = stream.events.slice(0, -2);
		assert.ok(
			beforeTerminal.every((e) => e.type === "start" || e.type.startsWith("thinking_")),
			`synthetic report must not commit output, got: ${stream.events.map((e) => e.type).join(",")}`,
		);
		assert.strictEqual(stream.events.at(-2).type, "error");
		assert.strictEqual(stream.events.at(-2).error.errorMessage, errorResult.result);
		// The wording still reaches pi's transcript as the failed turn's content.
		assert.deepStrictEqual(c.turnOutput.content, [{ type: "text", text: errorResult.result }]);
	});

	// A stalled stream whose non-streaming retry also fails: the synthetic failure
	// report arrives while the dead stream's partial blocks (unsigned thinking, a tool
	// call CC will never dispatch) are still open. The report must drop them the same
	// way the fallback path does — convertPiMessages would otherwise replay the
	// abandoned tool call as one awaiting a result.
	it("synthetic report after a stalled stream drops the abandoned partial blocks", async () => {
		const c = makeCtx();
		// A stream that reached a thinking block and the start of a tool call, then stalled.
		const stalledStream = (id) => [
			{ type: "stream_event", event: { type: "message_start", message: { id } } },
			{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } },
			{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me look" } } },
			{ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_dead", input: {} } } },
			{ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"comm" } } },
		];
		await consume(c, [
			...stalledStream("msg_stalled"),
			{ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: errorResult.result }] } },
			errorResult,
		]);

		assert.deepStrictEqual(c.turnOutput.content, [{ type: "text", text: errorResult.result }]);
		assert.strictEqual(c.turnSawToolCall, false);
		assert.strictEqual(c.turnStreamOpen, false);
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
