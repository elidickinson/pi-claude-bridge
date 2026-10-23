#!/usr/bin/env node
// Unit tests for pi-history content digests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { digestMessage, digestMessages } from "../src/message-digests.js";

const user = (content, extra = {}) => ({ role: "user", content, timestamp: 1, ...extra });
const assistant = (content, extra = {}) => ({
	role: "assistant", content, provider: "openrouter", api: "openai-completions", model: "test",
	usage: {}, stopReason: "stop", timestamp: 1, ...extra,
});
const toolCall = (id, name, args) => ({ type: "toolCall", id, name, arguments: args });
const result = (content, extra = {}) => ({
	role: "toolResult", toolCallId: "call-1", toolName: "read", content, isError: false, timestamp: 1, ...extra,
});

describe("pi message digests", () => {
	it("is deterministic, ignores metadata, and spots same-count rewrites", () => {
		const first = user("original");
		assert.equal(digestMessage(first), digestMessage({ ...first }));
		assert.equal(digestMessage(first), digestMessage({ ...first, timestamp: 99, extra: "ignored" }));
		assert.notDeepEqual(digestMessages([first]), digestMessages([user("rewritten")]));
		const reply = assistant([{ type: "text", text: "answer" }]);
		assert.equal(digestMessage(reply), digestMessage({ ...reply, model: "other", usage: { totalTokens: 999 }, stopReason: "error", provider: "anthropic" }));
	});

	it("canonicalizes argument object keys but hashes pi tool IDs and names", () => {
		const args1 = { z: 1, nested: { second: true, first: ["x", null] } };
		const args2 = { nested: { first: ["x", null], second: true }, z: 1 };
		assert.equal(digestMessage(assistant([toolCall("id", "read", args1)])), digestMessage(assistant([toolCall("id", "read", args2)])));
		assert.notEqual(digestMessage(assistant([toolCall("id", "read", args1)])), digestMessage(assistant([toolCall("other", "read", args1)])));
		assert.notEqual(digestMessage(assistant([toolCall("id", "read", args1)])), digestMessage(assistant([toolCall("id", "write", args1)])));
		assert.notEqual(digestMessage(result("same")), digestMessage(result("same", { toolCallId: "other" })));
		assert.notEqual(digestMessage(result("same")), digestMessage(result("same", { isError: true })));
	});

	it("hashes user and tool-result image data and MIME types", () => {
		const image = (data, mimeType = "image/png") => [{ type: "image", data, mimeType }];
		assert.notEqual(digestMessage(user(image("AAA"))), digestMessage(user(image("BBB"))));
		assert.notEqual(digestMessage(user(image("AAA"))), digestMessage(user(image("AAA", "image/jpeg"))));
		assert.notEqual(digestMessage(result(image("AAA"))), digestMessage(result(image("BBB"))));
	});

	it("matches tool-result flattening, markers, and the image block shape", () => {
		const text = (value) => ({ type: "text", text: value });
		const digest = (content) => digestMessage(result(content));
		assert.equal(digest([text("a\nb")]), digest([text("a"), text("b")]));
		assert.equal(digest([text("x"), { type: "audio" }]), digest([text("x\n[audio]")]));
		assert.notEqual(digest([text("x"), { type: "audio" }]), digest([text("x")]));
		assert.equal(digest([{ type: "audio" }]), digest(""));
		const withImage = (data) => [text("x"), { type: "image", data, mimeType: "image/png" }];
		assert.notEqual(digest(withImage("one")), digest([text("x")]));
		assert.notEqual(digest(withImage("one")), digest(withImage("two")));
	});

	it("replays only bridge-owned signed thinking", () => {
		const content = [{ type: "thinking", thinking: "plan", thinkingSignature: "sig" }];
		const own = assistant(content, { provider: "claude-bridge" });
		const foreign = assistant(content, { provider: "openrouter" });
		assert.notEqual(digestMessage(own), digestMessage(foreign));
		assert.equal(digestMessage(foreign), digestMessage(assistant([{ type: "text", text: "" }])));
	});

	it("distinguishes omitted assistants from conversion placeholders", () => {
		assert.notEqual(digestMessage(assistant([])), digestMessage(assistant([{ type: "text", text: "" }])));
		assert.notEqual(digestMessage(assistant([])), digestMessage(assistant([{ type: "thinking", thinking: "foreign" }])));
		assert.equal(digestMessage(assistant([{ type: "text", text: "" }])), digestMessage(assistant([{ type: "thinking", thinking: "foreign" }])));
	});

	it("frames tool IDs so newlines cannot collide with adjacent fields", () => {
		const left = assistant([toolCall("a\nb", "c", {})]);
		const right = assistant([toolCall("a", "b\nc", {})]);
		assert.notEqual(digestMessage(left), digestMessage(right));
	});
});
