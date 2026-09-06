#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { convertPiMessages, PROVIDER_ID } from "../src/convert.js";

const history = [
	{ role: "user", content: "start" },
	{ role: "assistant", provider: PROVIDER_ID, content: [
		{ type: "thinking", thinking: "step one", thinkingSignature: "sig1" },
		{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } },
	] },
	{ role: "toolResult", toolCallId: "t1", content: "body" },
];

const unreplayableTail = [
	{ type: "thinking", thinking: "settled", thinkingSignature: "sig2" },
	{ type: "thinking", thinking: "settled too", thinkingSignature: "sig3" },
	{ type: "thinking", thinking: "cut off mid-thought" },
];

describe("latest-assistant-message thinking guard", () => {
	it("drops the whole turn when the latest assistant message has an unreplayable thinking block", () => {
		const withAnomaly = [...history, { role: "assistant", provider: PROVIDER_ID, content: unreplayableTail }];
		const { anthropicMessages, dropped } = convertPiMessages(withAnomaly);

		assert.equal(dropped.unreplayableLatest, 1);
		assert.deepEqual(anthropicMessages.at(-1), { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "body", is_error: undefined }] });
	});

	it("drops the turn even when a trailing empty aborted turn follows it", () => {
		const withTrailingAborted = [
			...history,
			{ role: "assistant", provider: PROVIDER_ID, content: unreplayableTail },
			{ role: "assistant", provider: PROVIDER_ID, content: [] },
		];
		const { anthropicMessages, dropped } = convertPiMessages(withTrailingAborted);

		assert.equal(dropped.unreplayableLatest, 1);
		assert.equal(dropped.abortedTurns, 1);
		assert.deepEqual(anthropicMessages.at(-1), { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "body", is_error: undefined }] });
	});

	it("keeps the message and only drops the anomalous block once a later turn follows", () => {
		const withFollowUp = [
			...history,
			{ role: "assistant", provider: PROVIDER_ID, content: unreplayableTail },
			{ role: "user", content: "continue" },
			{ role: "assistant", provider: PROVIDER_ID, content: [{ type: "text", text: "done" }] },
		];
		const { anthropicMessages, dropped } = convertPiMessages(withFollowUp);

		assert.equal(dropped.unreplayableLatest, 0);
		assert.equal(dropped.thinking, 1);
		const midTurn = anthropicMessages.find((m) => m.role === "assistant" && Array.isArray(m.content) &&
			m.content.some((b) => b.type === "thinking" && b.signature === "sig2"));
		assert.ok(midTurn, "expected the historical turn to keep its signed thinking blocks");
		assert.equal(midTurn.content.filter((b) => b.type === "thinking").length, 2);
	});

	it("does not touch a fully signed latest assistant message", () => {
		const clean = [...history, { role: "assistant", provider: PROVIDER_ID, content: [
			{ type: "thinking", thinking: "fine", thinkingSignature: "sig9" },
			{ type: "text", text: "done" },
		] }];
		const { anthropicMessages, dropped } = convertPiMessages(clean);

		assert.equal(dropped.unreplayableLatest, 0);
		assert.equal(anthropicMessages.at(-1).role, "assistant");
		assert.equal(anthropicMessages.at(-1).content.length, 2);
	});
});
