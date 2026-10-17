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
import { convertPiMessages } from "../src/convert.js";
import { NARRATION_KIND, signatureBlockKind } from "../src/narration.js";

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

/** One recorded query spans a response per cycle, and the bridge ends the pi turn at the
 *  first tool call, so each later cycle is what a later pi turn receives. Splits at each
 *  response's message_start so a cycle can be replayed as a turn of its own. */
function cycles(messages) {
	const out = [];
	for (const m of messages) {
		if (m.type === "stream_event" && m.event?.type === "message_start") out.push([]);
		out.at(-1)?.push(m);
	}
	return out;
}

/** Replays a fixture through the real consumeQuery, collecting the pi-side events.
 *  With `cycle`, replays just that cycle, as the turn it would be. */
async function replay(name, { toolNames = ["read"], cycle } = {}) {
	const events = [];
	const c = new QueryContext();
	c.currentPiStream = { push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
	c.resetTurnState(model);
	// The map the provider path builds from the served tool list: SDK name → pi name.
	const customToolNameToPi = new Map(toolNames.map((n) => [`mcp__custom-tools__${n}`, n]));

	const messages = cycle === undefined ? fixture(name) : cycles(fixture(name))[cycle];
	async function* stream() { for (const m of messages) yield m; }
	const { capturedSessionId } = await __test.consumeQuery(stream(), customToolNameToPi, model, () => false, c);
	return { events, ctx: c, messages, capturedSessionId };
}

const blocks = (ctx, type) => ctx.turnOutput.content.filter((b) => b.type === type);

/** Every usage frame in a fixture, in stream order. */
function usageFrames(messages) {
	return messages
		.map((m) => m?.event?.message?.usage ?? m?.event?.usage ?? m?.message?.usage)
		.filter(Boolean);
}

/** The count this pi turn ends on: the *first* in the stream. A fixture that ends on a
 *  tool call spans several cycles, and the bridge closes the pi stream at the first
 *  tool-call boundary, so every later cycle belongs to the next pi turn. */
function turnThinkingTokens(messages) {
	for (const usage of usageFrames(messages)) {
		const thinking = usage.output_tokens_details?.thinking_tokens;
		if (thinking != null) return thinking;
	}
	return undefined;
}

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

// Regression guard: updateUsage read `reasoning_tokens ?? thinking_tokens`, neither of
// which can ever fire, so every fixture below already carried a count the bridge dropped.
describe("reasoning tokens from a recorded turn", () => {
	for (const name of ["text", "single-tool", "parallel-tools"]) {
		it(`surfaces the ${name} turn's thinking tokens as usage.reasoning`, async () => {
			const { ctx, messages } = await replay(name);
			const expected = turnThinkingTokens(messages);

			assert.ok(expected > 0, "fixture must carry a thinking-token count, else this asserts nothing");
			assert.equal(ctx.turnOutput.usage.reasoning, expected);
			assert.ok(expected <= ctx.turnOutput.usage.output, "SDK documents thinking_tokens <= output_tokens");
		});
	}

	// Guards the helper above, and with it the reason the single-cycle `text` fixture is
	// the one the cost/total assertions use: a tool-call fixture carries counts this pi
	// turn must NOT pick up, so an implementation that took the last frame would report
	// the following turn's reasoning against this one.
	it("ignores counts from cycles that belong to the next pi turn", async () => {
		const { ctx, messages } = await replay("single-tool");
		const counts = usageFrames(messages)
			.map((u) => u.output_tokens_details?.thinking_tokens)
			.filter((n) => n != null);

		assert.ok(counts.length > 1, "fixture must span more than one cycle for this to mean anything");
		assert.equal(ctx.turnOutput.stopReason, "toolUse", "the turn must have ended on the tool call");
		assert.equal(ctx.turnOutput.usage.reasoning, counts[0]);
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

// Claude 5 models write the note between tool calls as a thinking block, and under summarized
// display only its signature says it is a progress update rather than reasoning
// (src/narration.ts). narration.jsonl was recorded on Sonnet 5.5 through the bridge: three
// reads, with a note after each of the first two, and it was scrubbed like the others.
describe("replaying recorded progress updates", () => {
	// What Claude Code itself recorded, block by block, for each cycle, with its own verdict:
	// each assistant frame lists the blocks it decoded as narration, which is the reference here.
	const recorded = cycles(fixture("narration")).map((cycle) => cycle
		.filter((m) => m.type === "assistant")
		.flatMap((m) => m.message.content.map((b, i) => ({ ...b, ccNarration: m.narration_block_indexes?.includes(i) ?? false }))));
	const isProgressUpdate = (b) => b.ccNarration && b.thinking.trim() !== "";

	it("has progress updates to replay", () => {
		assert.ok(recorded.flat().filter(isProgressUpdate).length >= 2,
			"re-record: a fixture without progress updates would make everything below vacuous");
	});

	it("decodes every thinking block's kind the way Claude Code did", () => {
		for (const b of recorded.flat().filter((b) => b.type === "thinking")) {
			assert.equal(signatureBlockKind(b.signature) === NARRATION_KIND, b.ccNarration, b.signature.slice(0, 40));
		}
	});

	for (const [cycle, blocks] of recorded.entries()) {
		it(`delivers cycle ${cycle} as Claude Code recorded it, with progress updates as text`, async () => {
			const { ctx, events } = await replay("narration", { cycle });

			const expected = blocks.map((b) => {
				if (isProgressUpdate(b)) return { type: "text", text: b.thinking, textSignature: b.signature };
				if (b.type === "thinking") return { type: "thinking", thinking: b.thinking, thinkingSignature: b.signature };
				if (b.type === "tool_use") return { type: "toolCall", id: b.id, name: "read" };
				return { type: "text", text: b.text };
			});
			const delivered = ctx.turnOutput.content.map((b) => (b.type === "toolCall" ? { type: "toolCall", id: b.id, name: b.name } : { ...b }));
			assert.deepEqual(delivered, expected);

			// pi was told the same thing: every event for a block belongs to the type it ended up as.
			for (const [index, block] of ctx.turnOutput.content.entries()) {
				const prefix = block.type === "toolCall" ? "toolcall" : block.type;
				const types = events.filter((e) => e.contentIndex === index).map((e) => e.type);
				assert.ok(types.length > 0 && types.every((t) => t.startsWith(`${prefix}_`)), `block ${index} (${block.type}) saw ${JSON.stringify(types)}`);
			}
		});
	}

	it("sends a progress update back to Claude Code exactly as it arrived", async () => {
		const cycle = recorded.findIndex((blocks) => blocks.some(isProgressUpdate));
		assert.ok(cycle >= 0, "a cycle must carry a progress update");
		const { ctx } = await replay("narration", { cycle });
		const { anthropicMessages, dropped } = convertPiMessages(
			[{ role: "assistant", provider: "claude-bridge", content: ctx.turnOutput.content }],
			new Map([["read", "mcp__custom-tools__read"]]),
		);

		const sent = anthropicMessages[0].content.filter((b) => b.type === "thinking");
		const arrived = recorded[cycle].filter(isProgressUpdate).map((b) => ({ type: "thinking", thinking: b.thinking, signature: b.signature }));
		assert.deepEqual(sent, arrived);
		assert.equal(dropped.thinking, 0);
	});
});

// Reasoning must come through as before. These are Haiku 4.5 recordings, narration.jsonl is Sonnet
// 5.5: the signature of each model's reasoning names the kind "thinking".
describe("replaying recorded reasoning", () => {
	for (const name of ["text", "single-tool", "parallel-tools"]) {
		it(`keeps the ${name} turn's reasoning as thinking`, async () => {
			const { ctx } = await replay(name, { cycle: 0 });

			const thinking = blocks(ctx, "thinking");
			assert.ok(thinking.length > 0, "fixture must carry a thinking block, else this asserts nothing");
			for (const b of thinking) assert.equal(signatureBlockKind(b.thinkingSignature), "thinking");
			assert.ok(blocks(ctx, "text").every((b) => b.textSignature === undefined), "no text block should carry a signature");
		});
	}
});
