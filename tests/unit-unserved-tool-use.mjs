/**
 * Claude sometimes calls a Claude Code builtin by its bare name (`bash`, `Bash`,
 * `Edit`) instead of the `mcp__custom-tools__*` name we serve. The provider runs
 * CC with `tools: []`, so CC rejects those itself ("No such tool available") and
 * retries in the same query with a *fresh* tool_use id — it never dispatches the
 * bogus call to our MCP server.
 *
 * Forwarding one to pi therefore ran a tool CC never asked for and deadlocked the
 * turn: pi's result came back keyed to the dead id, so the handler waiting on the
 * retry's id was never released and CC stalled until it aborted.
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
	await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c, []);
}

const streamEvent = (event) => ({ type: "stream_event", event });

const toolUseTurn = (name, id) => [
	streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name, id, input: {} } }),
	streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
	streamEvent({ type: "content_block_stop", index: 0 }),
	streamEvent({ type: "message_stop" }),
];

describe("tool_use for a tool we do not serve", () => {
	it("is skipped, and only the retry under the served name reaches pi", async () => {
		const c = makeCtx();
		await consume(c, [
			...toolUseTurn("bash", "toolu_phantom"),
			...toolUseTurn("mcp__custom-tools__bash", "toolu_retry"),
		]);

		const toolCalls = c.turnOutput.content.filter((b) => b.type === "toolCall");
		assert.deepStrictEqual(toolCalls.map((b) => [b.name, b.id]), [["bash", "toolu_retry"]]);
		assert.deepStrictEqual(c.turnToolCallIds, ["toolu_retry"]);
		assert.deepStrictEqual(toolCalls[0].arguments, { command: "ls", timeout: 120 });
	});

	it("does not end the pi stream, so the turn continues into the retry", async () => {
		const c = makeCtx();
		await consume(c, toolUseTurn("Bash", "toolu_phantom"));

		assert.strictEqual(c.turnSawToolCall, false);
		assert.deepStrictEqual(c.turnOutput.content, []);
		const terminal = c.currentPiStream.events.filter((e) => e.type === "done" || e.type === "end");
		assert.deepStrictEqual(terminal, []);
	});

	// The assistant-message fallback path (no stream_events for the turn) has to
	// make the same call, or the deadlock comes back through the other door.
	it("is skipped on the assistant-message path too", async () => {
		const c = makeCtx();
		await consume(c, [{
			type: "assistant",
			message: { content: [
				{ type: "tool_use", name: "bash", id: "toolu_phantom", input: { command: "ls" } },
				{ type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_retry", input: { command: "ls" } },
			] },
		}]);

		const toolCalls = c.turnOutput.content.filter((b) => b.type === "toolCall");
		assert.deepStrictEqual(toolCalls.map((b) => [b.name, b.id]), [["bash", "toolu_retry"]]);
	});
});
