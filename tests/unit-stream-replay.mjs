/**
 * consumeQuery against real recorded SDK streams.
 *
 * The fixtures in tests/fixtures/sdk-streams/ are verbatim message sequences from
 * live Claude Code turns, captured by tests/lib/record-sdk-streams.mjs. Nothing
 * here is hand-authored, so these cover the message shapes CC actually emits —
 * including ones we would not have thought to write, like the `system/status`
 * frames and the `rate_limit_event` every turn carries. Re-record on an SDK bump
 * and the diff is the contract change.
 *
 * The synthetic streams in unit-error-result.mjs and unit-unserved-tool-use.mjs
 * stay synthetic on purpose: a 429 and a hallucinated tool name cannot be recorded
 * on demand.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

// `cost` matters: a recorded stream carries real usage, so consumeQuery reaches
// pi-ai's cost calculation, which the hand-built streams never exercise. Zeros are
// what buildModels ships (src/models.ts) since Claude Code billing is per-plan.
const model = {
	api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function fixture(name) {
	const path = new URL(`./fixtures/sdk-streams/${name}.jsonl`, import.meta.url);
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Replays a fixture through the real consumeQuery, collecting the pi-side events. */
async function replay(name, { toolNames = ["read"] } = {}) {
	const events = [];
	const c = new QueryContext();
	c.currentPiStream = { push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
	c.resetTurnState(model);
	// The map the provider path builds from the served tool list: SDK name → pi name.
	const customToolNameToPi = new Map(toolNames.map((n) => [`mcp__custom-tools__${n}`, n]));

	const messages = fixture(name);
	async function* stream() { for (const m of messages) yield m; }
	const { capturedSessionId } = await __test.consumeQuery(stream(), customToolNameToPi, model, () => false, c, []);
	return { events, ctx: c, messages, capturedSessionId };
}

const blocks = (ctx, type) => ctx.turnOutput.content.filter((b) => b.type === type);

describe("replaying a recorded text-only turn", () => {
	it("produces the assistant text and a clean stop", async () => {
		const { ctx, events } = await replay("text");

		assert.equal(blocks(ctx, "text").map((b) => b.text).join("").trim(), "ALPHA");
		assert.equal(ctx.turnOutput.stopReason, "stop");
		assert.equal(ctx.turnSawToolCall, false);
		assert.ok(events.some((e) => e.type === "text_delta"), "pi should have seen streaming deltas");
	});

	it("reports usage and captures the session id", async () => {
		const { ctx, capturedSessionId } = await replay("text");

		assert.ok(ctx.turnOutput.usage.output > 0, "output tokens");
		assert.ok(ctx.turnOutput.usage.input + ctx.turnOutput.usage.cacheRead + ctx.turnOutput.usage.cacheWrite > 0, "prompt tokens");
		assert.match(capturedSessionId ?? "", /^[0-9a-f-]{36}$/);
	});
});

describe("replaying a recorded single-tool turn", () => {
	it("surfaces the tool call under its pi name and ends the turn on it", async () => {
		const { ctx } = await replay("single-tool");

		const calls = blocks(ctx, "toolCall");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].name, "read", "SDK's mcp__custom-tools__read must arrive as pi's read");
		assert.ok(calls[0].id.startsWith("toolu_"));
		assert.equal(ctx.turnSawToolCall, true);
		assert.deepEqual(ctx.turnToolCallIds, [calls[0].id]);
	});
});

describe("replaying a recorded parallel-tool turn", () => {
	it("keeps every parallel call, in emission order", async () => {
		const { ctx } = await replay("parallel-tools");

		const calls = blocks(ctx, "toolCall");
		assert.ok(calls.length >= 2, `expected a parallel batch, got ${calls.length}`);
		assert.deepEqual(ctx.turnToolCallIds, calls.map((c) => c.id), "routing ids must match the emitted calls, in order");
		assert.equal(new Set(calls.map((c) => c.id)).size, calls.length, "no duplicate ids");
		for (const call of calls) assert.equal(call.name, "read");
	});

	// The bug in 122914dd was a tool_use surviving into pi under a name the bridge
	// does not serve. Recorded streams are the check that the names CC really sends
	// are the ones the map is keyed on.
	it("leaves nothing unmapped when the served tool list is empty", async () => {
		const { ctx } = await replay("parallel-tools", { toolNames: [] });

		assert.equal(blocks(ctx, "toolCall").length, 0, "unserved names must not reach pi");
		assert.equal(ctx.turnSawToolCall, false);
	});
});
