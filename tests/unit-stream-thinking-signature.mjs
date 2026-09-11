/**
 * Verify observability of empty or absent thinking signatures in stream-consumer.
 *
 * Ensures that when thinking blocks complete without a signature, a debug warning
 * is emitted to distinguish SDK-level omission from provider-level filtering.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QueryContext } from "../src/query-state.js";

// Enable debug logging before importing modules that evaluate process.env.CLAUDE_BRIDGE_DEBUG
process.env.CLAUDE_BRIDGE_DEBUG = "1";
const { processStreamEvent, processAssistantMessage } = await import("../src/stream-consumer.js");
const { DEBUG_LOG_PATH } = await import("../src/debug.js");

const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const toolMap = new Map();

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

describe("stream-consumer thinking signature observability", () => {
	it("logs a warning when a stream_event thinking block completes without signature", () => {
		const c = makeCtx();
		processStreamEvent({
			type: "stream_event",
			event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		}, toolMap, fakeModel, c);

		processStreamEvent({
			type: "stream_event",
			event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "unsigned stream thinking" } },
		}, toolMap, fakeModel, c);

		processStreamEvent({
			type: "stream_event",
			event: { type: "content_block_stop", index: 0 },
		}, toolMap, fakeModel, c);

		const log = readFileSync(DEBUG_LOG_PATH, "utf8");
		assert.match(log, /WARNING: thinking block completed without signature \(stream_event, length=24\)/);
		assert.equal(c.turnBlocks[0].thinkingSignature, "");
		assert.equal(c.turnBlocks[0].thinking, "unsigned stream thinking");
	});

	it("does not log a warning when stream_event thinking block has a valid signature", () => {
		const c = makeCtx();
		const beforeLength = readFileSync(DEBUG_LOG_PATH, "utf8").length;

		processStreamEvent({
			type: "stream_event",
			event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
		}, toolMap, fakeModel, c);

		processStreamEvent({
			type: "stream_event",
			event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "signed thought" } },
		}, toolMap, fakeModel, c);

		processStreamEvent({
			type: "stream_event",
			event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
		}, toolMap, fakeModel, c);

		processStreamEvent({
			type: "stream_event",
			event: { type: "content_block_stop", index: 0 },
		}, toolMap, fakeModel, c);

		const afterLog = readFileSync(DEBUG_LOG_PATH, "utf8").slice(beforeLength);
		assert.doesNotMatch(afterLog, /WARNING: thinking block completed without signature/);
		assert.equal(c.turnBlocks[0].thinkingSignature, "sig123");
	});

	it("logs a warning when an assistant message thinking block has no signature", () => {
		const c = makeCtx();
		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "thinking", thinking: "unsigned assistant thinking" }],
			},
		}, fakeModel, toolMap, c);

		const log = readFileSync(DEBUG_LOG_PATH, "utf8");
		assert.match(log, /WARNING: thinking block completed without signature \(assistant message, length=27\)/);
		assert.equal(c.turnBlocks[0].thinkingSignature, "");
		assert.equal(c.turnBlocks[0].thinking, "unsigned assistant thinking");
	});

	it("does not log a warning when an assistant message thinking block has a valid signature", () => {
		const c = makeCtx();
		const beforeLength = readFileSync(DEBUG_LOG_PATH, "utf8").length;

		processAssistantMessage({
			type: "assistant",
			message: {
				content: [{ type: "thinking", thinking: "signed assistant thinking", signature: "sig456" }],
			},
		}, fakeModel, toolMap, c);

		const afterLog = readFileSync(DEBUG_LOG_PATH, "utf8").slice(beforeLength);
		assert.doesNotMatch(afterLog, /WARNING: thinking block completed without signature/);
		assert.equal(c.turnBlocks[0].thinkingSignature, "sig456");
	});
});
