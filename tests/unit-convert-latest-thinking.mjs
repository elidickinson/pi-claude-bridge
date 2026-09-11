#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { repairToolPairing } from "cc-session-io";
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

	it("drops the whole turn when the latest assistant message has unreplayable thinking mixed with text", () => {
		const withMixedText = [
			...history,
			{ role: "assistant", provider: PROVIDER_ID, content: [
				{ type: "thinking", thinking: "cut off mid-thought" },
				{ type: "text", text: "partial response before interruption" },
			] },
		];
		const { anthropicMessages, dropped } = convertPiMessages(withMixedText);

		assert.equal(dropped.unreplayableLatest, 1);
		assert.equal(dropped.thinking, 0);
		assert.deepEqual(anthropicMessages.at(-1), {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: "t1", content: "body", is_error: undefined }],
		});
	});

	it("keeps the message and preserves text when a later turn follows", () => {
		const withFollowUpText = [
			...history,
			{ role: "assistant", provider: PROVIDER_ID, content: [
				{ type: "thinking", thinking: "cut off mid-thought" },
				{ type: "text", text: "text from earlier turn" },
			] },
			{ role: "user", content: "continue" },
			{ role: "assistant", provider: PROVIDER_ID, content: [{ type: "text", text: "done" }] },
		];
		const { anthropicMessages, dropped } = convertPiMessages(withFollowUpText);

		assert.equal(dropped.unreplayableLatest, 0);
		assert.equal(dropped.thinking, 1);
		const midTurn = anthropicMessages.find((m) =>
			m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "text" && b.text === "text from earlier turn"),
		);
		assert.ok(midTurn, "expected the historical turn to keep its text block");
		assert.equal(midTurn.content.filter((b) => b.type === "thinking").length, 0);
	});

	it("preserves the turn and drops only thinking when mixed with tool calls and followed by tool results", () => {
		const withTools = [
			{ role: "user", content: "read file" },
			{ role: "assistant", provider: PROVIDER_ID, content: [
				{ type: "thinking", thinking: "need to read" },
				{ type: "text", text: "reading file" },
				{ type: "toolCall", id: "t_read", name: "read", arguments: { path: "foo.txt" } },
			] },
			{ role: "toolResult", toolCallId: "t_read", content: "content of foo" },
		];
		const { anthropicMessages, dropped } = convertPiMessages(withTools);

		assert.equal(dropped.unreplayableLatest, 0);
		assert.equal(dropped.thinking, 1);

		const assistantMsg = anthropicMessages.find((m) => m.role === "assistant");
		assert.ok(assistantMsg, "assistant message must be preserved");
		assert.equal(assistantMsg.content.length, 2);
		assert.deepEqual(assistantMsg.content[0], { type: "text", text: "reading file" });
		assert.equal(assistantMsg.content[1].type, "tool_use");
		assert.equal(assistantMsg.content[1].id, "t_read");

		const repaired = repairToolPairing(anthropicMessages);
		assert.equal(repaired.length, 3);
		assert.equal(repaired[0].role, "user");
		assert.equal(repaired[1].role, "assistant");
		const userResult = repaired[2];
		assert.equal(userResult.role, "user");
		assert.equal(userResult.content[0].type, "tool_result");
		assert.equal(userResult.content[0].tool_use_id, "t_read");
		assert.equal(userResult.content[0].content, "content of foo");
	});

	it("preserves the turn when unreplayable thinking is mixed with tool calls even if no result followed", () => {
		const withUnresolvedTool = [
			...history,
			{ role: "assistant", provider: PROVIDER_ID, content: [
				{ type: "thinking", thinking: "deciding to call tool" },
				{ type: "toolCall", id: "t_pending", name: "write", arguments: { path: "out.txt" } },
			] },
		];
		const { anthropicMessages, dropped } = convertPiMessages(withUnresolvedTool);

		assert.equal(dropped.unreplayableLatest, 0);
		assert.equal(dropped.thinking, 1);
		const lastMsg = anthropicMessages.at(-1);
		assert.equal(lastMsg.role, "assistant");
		assert.equal(lastMsg.content[0].type, "tool_use");
		assert.equal(lastMsg.content[0].id, "t_pending");

		const repaired = repairToolPairing(anthropicMessages);
		const lastRepaired = repaired.at(-1);
		assert.equal(lastRepaired.role, "user");
		assert.equal(lastRepaired.content[0].type, "tool_result");
		assert.equal(lastRepaired.content[0].tool_use_id, "t_pending");
	});

	it("preserves signed thinking and drops unsigned thinking when mixed with tool calls", () => {
		const mixedThinking = [
			{ role: "user", content: "fetch" },
			{ role: "assistant", provider: PROVIDER_ID, content: [
				{ type: "thinking", thinking: "valid thought", thinkingSignature: "sig_valid" },
				{ type: "thinking", thinking: "unsigned thought" },
				{ type: "toolCall", id: "t_fetch", name: "read", arguments: { path: "f" } },
			] },
			{ role: "toolResult", toolCallId: "t_fetch", content: "f content" },
		];
		const { anthropicMessages, dropped } = convertPiMessages(mixedThinking);

		assert.equal(dropped.unreplayableLatest, 0);
		assert.equal(dropped.thinking, 1);
		const assistantMsg = anthropicMessages.find((m) => m.role === "assistant");
		assert.ok(assistantMsg);
		assert.equal(assistantMsg.content.length, 2);
		assert.deepEqual(assistantMsg.content[0], { type: "thinking", thinking: "valid thought", signature: "sig_valid" });
		assert.equal(assistantMsg.content[1].type, "tool_use");

		const repaired = repairToolPairing(anthropicMessages);
		assert.equal(repaired.length, 3);
		assert.equal(repaired[0].role, "user");
		assert.equal(repaired[1].role, "assistant");
		assert.equal(repaired[2].role, "user");
		assert.equal(repaired[2].content[0].tool_use_id, "t_fetch");
	});
});
