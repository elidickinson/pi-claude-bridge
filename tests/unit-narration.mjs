/**
 * Progress updates. On Claude 5 models the short notes the model writes between tool
 * calls ("found X, now checking Y") come back as their own `thinking` blocks, not
 * `text`. Under `display: "summarized"` — which the bridge requests whenever a thinking
 * level is set — nothing
 * in the block says so except its signature, whose envelope header carries the block
 * kind: "narration" for a progress update, "thinking" for reasoning. Claude Code
 * decodes the same tag. Mapped block type to block type, pi shows a progress update as
 * reasoning (the TUI folds adjacent thinking blocks into one italic block, and hides
 * them all behind "Thinking..." when thinking is hidden).
 *
 * The bridge now delivers a narration block as text, holding short thinking blocks
 * until their signature arrives to tell the two apart, and keeps the signature on the
 * block so a rebuilt session sends the API back the exact signed block.
 *
 * The signatures here are built from the envelope layout alone — version, a sealed
 * message whose first field is a plaintext header naming the kind, then payload the
 * bridge never reads.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";
import { convertPiMessages } from "../src/convert.js";
import { NARRATION_HOLD_CHARS, isNarrationBlock, signatureBlockKind } from "../src/narration.js";

const { __test } = await import("../src/index.js");

// --- signatures ---

const varint = (n) => {
	const out = [];
	for (; n > 127; n = Math.floor(n / 128)) out.push((n % 128) | 128);
	out.push(n);
	return Buffer.from(out);
};
const varintField = (num, n) => Buffer.concat([varint(num * 8), varint(n)]);
const bytesField = (num, buf) => Buffer.concat([varint(num * 8 + 2), varint(buf.length), buf]);

/** An envelope shaped like the API's, with the given block kind in its header. */
function signature(kind, payloadBytes = 200) {
	const header = Buffer.concat([varintField(1, 18), varintField(3, 2), varintField(7, 1), bytesField(8, Buffer.from(kind))]);
	const sealed = Buffer.concat([
		bytesField(1, header),
		bytesField(2, Buffer.alloc(12, 1)),
		bytesField(3, Buffer.alloc(12, 2)),
		bytesField(4, Buffer.alloc(48, 3)),
		bytesField(5, Buffer.alloc(payloadBytes, 4)),
	]);
	return Buffer.concat([varintField(1, 4), bytesField(2, sealed), varintField(3, 1)]).toString("base64");
}

const NARRATION = signature("narration");
const THINKING = signature("thinking");

// --- stream plumbing, as in unit-nonstreaming-fallback.mjs ---

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const toolMap = new Map([["mcp__custom-tools__bash", "bash"]]);

async function run(messages) {
	const c = new QueryContext();
	const events = [];
	c.currentPiStream = { push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
	c.resetTurnState(fakeModel);
	async function* gen() { for (const m of messages) yield m; }
	await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);
	return { c, events, content: c.turnOutput.content };
}

const streamEvent = (event) => ({ type: "stream_event", event });
const messageStart = () => streamEvent({ type: "message_start", message: { id: "msg_1" } });
const messageEnd = (stop) => [streamEvent({ type: "message_delta", delta: { stop_reason: stop } }), streamEvent({ type: "message_stop" })];

/** A thinking block as streamed: `chunk`-char deltas, then the signature, then the stop. */
function thinkingBlock(index, text, sig, { chunk = 40, close = true } = {}) {
	const out = [streamEvent({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } })];
	for (let i = 0; i < text.length; i += chunk) {
		out.push(streamEvent({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text.slice(i, i + chunk) } }));
	}
	if (close) {
		out.push(
			streamEvent({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: sig } }),
			streamEvent({ type: "content_block_stop", index }),
		);
	}
	return out;
}
const textBlock = (index, text) => [
	streamEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } }),
	streamEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text } }),
	streamEvent({ type: "content_block_stop", index }),
];
const toolBlock = (index) => [
	streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_1", input: {} } }),
	streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' } }),
	streamEvent({ type: "content_block_stop", index }),
];

/** Event types with their block index, e.g. "text_start#1"; `start`/`done`/`end` have none. */
const shape = (events) => events.map((e) => (e.contentIndex === undefined ? e.type : `${e.type}#${e.contentIndex}`));

const REASONING = "Checking the retry path before touching anything.";
const UPDATE = "Confirmed the retry path never refreshes the expired token. Editing auth.py to add the refresh call.\n\n";

describe("signatureBlockKind", () => {
	it("reads the block kind from the envelope header", () => {
		assert.equal(signatureBlockKind(NARRATION), "narration");
		assert.equal(signatureBlockKind(THINKING), "thinking");
		assert.equal(signatureBlockKind(signature("narration", 20_000)), "narration");
	});

	it("skips fixed-width and ten-byte varint fields ahead of the kind, as Claude Code does", () => {
		const fixed = (num, wire, size) => Buffer.concat([varint(num * 8 + wire), Buffer.alloc(size, 0xff)]);
		// An int32 of -1: a negative number takes all ten varint bytes.
		const minusOne = Buffer.concat([varint(4 * 8), Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])]);
		const header = Buffer.concat([fixed(2, 1, 8), fixed(5, 5, 4), minusOne, bytesField(8, Buffer.from("narration"))]);
		assert.equal(signatureBlockKind(bytesField(2, bytesField(1, header)).toString("base64")), "narration");
	});

	it("has no kind for anything it cannot parse", () => {
		const truncated = NARRATION.slice(0, 20);
		const lengthPastEnd = Buffer.from([0x12, 0xff, 0xff, 0xff, 0xff, 0x0f]).toString("base64");
		for (const bad of [undefined, "", "not base64 !!", "AAAA", truncated, lengthPastEnd]) {
			assert.equal(signatureBlockKind(bad), undefined, String(bad));
		}
	});

	it("treats a block as narration only when it has text to show", () => {
		assert.equal(isNarrationBlock({ thinking: UPDATE, signature: NARRATION }), true);
		assert.equal(isNarrationBlock({ thinking: UPDATE, signature: THINKING }), false);
		assert.equal(isNarrationBlock({ thinking: UPDATE, signature: undefined }), false);
		// A progress update can come back empty (display omitted); there is nothing to render.
		assert.equal(isNarrationBlock({ thinking: " \n", signature: NARRATION }), false);
	});
});

describe("progress updates in the stream", () => {
	it("shows a progress update after reasoning as text, and keeps reasoning as thinking", async () => {
		const { c, events, content } = await run([
			messageStart(),
			...thinkingBlock(0, REASONING, THINKING),
			...thinkingBlock(1, UPDATE, NARRATION),
			...toolBlock(2),
			...messageEnd("tool_use"),
		]);

		assert.deepStrictEqual(content.map((b) => b.type), ["thinking", "text", "toolCall"]);
		assert.strictEqual(content[0].thinking, REASONING);
		assert.strictEqual(content[0].thinkingSignature, THINKING);
		// Exactly as received: the API checks the text and signature it gets back.
		assert.strictEqual(content[1].text, UPDATE);
		assert.strictEqual(content[1].textSignature, NARRATION);
		assert.deepStrictEqual(Object.keys(content[1]).sort(), ["text", "textSignature", "type"]);
		assert.deepStrictEqual(Object.keys(content[0]).sort(), ["thinking", "thinkingSignature", "type"]);

		assert.deepStrictEqual(shape(events), [
			"start",
			"thinking_start#0", "thinking_delta#0", "thinking_end#0",
			"text_start#1", "text_delta#1", "text_end#1",
			"toolcall_start#2", "toolcall_delta#2", "toolcall_end#2",
			"done", "end",
		]);
		assert.strictEqual(events.find((e) => e.type === "text_end").content, UPDATE);
		assert.ok(events.every((e) => !e.partial || e.partial === c.turnOutput));
	});

	it("shows a progress update with no reasoning before it as text", async () => {
		const { content, events } = await run([
			messageStart(),
			...thinkingBlock(0, UPDATE, NARRATION),
			...toolBlock(1),
			...messageEnd("tool_use"),
		]);

		assert.deepStrictEqual(content.map((b) => b.type), ["text", "toolCall"]);
		assert.deepStrictEqual(shape(events).filter((t) => t.startsWith("thinking")), []);
	});

	it("holds a short reasoning block until it closes, then shows it whole and in order", async () => {
		const { content, events } = await run([
			messageStart(),
			...thinkingBlock(0, REASONING, THINKING, { chunk: 10 }),
			...textBlock(1, "Done."),
			...messageEnd("end_turn"),
		]);

		assert.deepStrictEqual(content.map((b) => b.type), ["thinking", "text"]);
		assert.deepStrictEqual(shape(events), [
			"start", "thinking_start#0", "thinking_delta#0", "thinking_end#0", "text_start#1", "text_delta#1", "text_end#1",
		]);
		assert.strictEqual(events.find((e) => e.type === "thinking_delta").delta, REASONING);
	});

	it("streams a long reasoning block live once it passes the hold, losing and repeating nothing", async () => {
		const text = "Weighing the retry path against the refresh path again. ".repeat(40);
		const chunk = 50;
		assert.ok(text.length > NARRATION_HOLD_CHARS * 2);

		const { content, events } = await run([
			messageStart(),
			...thinkingBlock(0, text, THINKING, { chunk }),
			...toolBlock(1),
			...messageEnd("tool_use"),
		]);

		assert.strictEqual(content[0].type, "thinking");
		assert.strictEqual(content[0].thinking, text);
		const thinking = events.filter((e) => e.type.startsWith("thinking"));
		assert.strictEqual(thinking[0].type, "thinking_start");
		assert.strictEqual(thinking.at(-1).type, "thinking_end");
		assert.strictEqual(thinking.filter((e) => e.type === "thinking_start").length, 1);
		const deltas = thinking.filter((e) => e.type === "thinking_delta").map((e) => e.delta);
		assert.strictEqual(deltas.join(""), text);
		// Released on the first delta past the hold, carrying everything gathered so far;
		// every later delta is its own event.
		assert.ok(deltas[0].length > NARRATION_HOLD_CHARS && deltas[0].length <= NARRATION_HOLD_CHARS + chunk);
		assert.strictEqual(deltas.length, 1 + Math.ceil((text.length - deltas[0].length) / chunk));
	});

	it("announces and closes an empty block without a delta, whatever kind it is", async () => {
		for (const sig of [THINKING, NARRATION]) {
			const { content, events } = await run([messageStart(), ...thinkingBlock(0, "", sig), ...toolBlock(1), ...messageEnd("tool_use")]);
			assert.deepStrictEqual(content.map((b) => b.type), ["thinking", "toolCall"]);
			assert.deepStrictEqual(shape(events).filter((t) => t.endsWith("#0")), ["thinking_start#0", "thinking_end#0"]);
		}
	});

	it("drops a thinking block cut off before it closed, which pi never heard of", async () => {
		const { content, events } = await run([
			messageStart(),
			...thinkingBlock(0, "half a thou", "", { chunk: 4, close: false }),
			...messageEnd("end_turn"),
		]);

		assert.deepStrictEqual(content, []);
		assert.deepStrictEqual(shape(events).filter((t) => t.startsWith("thinking")), []);
	});

	it("leaves ordinary text streaming live and untouched", async () => {
		const { content, events } = await run([messageStart(), ...textBlock(0, "Hello"), ...messageEnd("end_turn")]);

		assert.deepStrictEqual(content.map((b) => ({ ...b })), [{ type: "text", text: "Hello" }]);
		assert.deepStrictEqual(shape(events), ["start", "text_start#0", "text_delta#0", "text_end#0"]);
	});
});

describe("progress updates in the non-streaming fallback", () => {
	it("shows them as text there too", async () => {
		const { content, events } = await run([{
			type: "assistant",
			message: { id: "msg_fallback", content: [
				{ type: "thinking", thinking: REASONING, signature: THINKING },
				{ type: "thinking", thinking: UPDATE, signature: NARRATION },
				{ type: "tool_use", name: "mcp__custom-tools__bash", id: "toolu_a", input: { command: "ls" } },
			] },
		}]);

		assert.deepStrictEqual(content.map((b) => b.type), ["thinking", "text", "toolCall"]);
		assert.strictEqual(content[1].text, UPDATE);
		assert.strictEqual(content[1].textSignature, NARRATION);
		assert.deepStrictEqual(shape(events).filter((t) => t.endsWith("#1")), ["text_start#1", "text_delta#1", "text_end#1"]);
	});
});

describe("progress updates on replay", () => {
	const toSdk = new Map([["bash", "mcp__custom-tools__bash"]]);
	const replay = (content, provider = "claude-bridge") => convertPiMessages([{ role: "assistant", provider, content }], toSdk);

	it("sends one back as the exact signed thinking block it arrived as", () => {
		const { anthropicMessages, dropped } = replay([
			{ type: "thinking", thinking: REASONING, thinkingSignature: THINKING },
			{ type: "text", text: UPDATE, textSignature: NARRATION },
			{ type: "toolCall", id: "toolu_1", name: "bash", arguments: { command: "ls" } },
		]);

		// The API wants a turn's thinking blocks returned verbatim, and reads the full
		// note from the signature — so neither the text nor its trailing newlines change.
		assert.deepStrictEqual(anthropicMessages[0].content, [
			{ type: "thinking", thinking: REASONING, signature: THINKING },
			{ type: "thinking", thinking: UPDATE, signature: NARRATION },
			{ type: "tool_use", id: "toolu_1", name: "mcp__custom-tools__bash", input: { command: "ls" } },
		]);
		assert.strictEqual(dropped.thinking, 0);
	});

	it("never turns other text into thinking", () => {
		const cases = [
			{ type: "text", text: "Hello" },
			{ type: "text", text: "Hello", textSignature: JSON.stringify({ v: 1, id: "msg_abc", phase: "commentary" }) },
			{ type: "text", text: "Hello", textSignature: THINKING },
		];
		for (const block of cases) {
			assert.deepStrictEqual(replay([block]).anthropicMessages[0].content, [{ type: "text", text: "Hello" }]);
		}
	});

	it("does not hand another provider's message a signature as if it were ours", () => {
		const block = { type: "text", text: UPDATE, textSignature: NARRATION };
		assert.deepStrictEqual(replay([block], "anthropic").anthropicMessages[0].content, [{ type: "text", text: UPDATE }]);
	});
});
