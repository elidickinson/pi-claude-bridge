#!/usr/bin/env node
// Live round trip for the standalone-prompt route against the installed Claude Code:
// a text reply, and a tool call that comes back to pi unexecuted. Pins the behavior
// the route rests on: with maxTurns 1, CC dispatches the turn's tool calls and then
// stops with error_max_turns before a second model call.
//
// Calls the provider directly (no pi process); Haiku keeps it cheap.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const TIMEOUT = 120_000;

const { default: activate } = await import("../src/index.js");

let providerConfig;
activate({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const model = providerConfig.models.find((m) => m.id.includes("haiku"));
const options = { sessionId: "int-standalone", metadata: { promptKind: "standalone" } };
const user = (content) => ({ role: "user", content, timestamp: Date.now() });

const decisionTool = {
	name: "classifier_decision",
	description: "Report whether the action is allowed.",
	parameters: { type: "object", properties: { allowed: { type: "boolean" } }, required: ["allowed"] },
};

describe("standalone prompt live", { timeout: TIMEOUT }, () => {
	it("returns text reply for unrecorded prompt", async () => {
		const result = await providerConfig.streamSimple(model, {
			systemPrompt: "You classify shell commands. Answer with a single digit: 0 for safe, 1 for unsafe.",
			messages: [user("Command: ls"), user("Answer now.")],
			tools: [],
		}, options).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		const text = result.content.filter((b) => b.type === "text").map((b) => b.text).join("");
		assert.match(text, /[01]/);
		assert.ok(result.usage.output > 0);
	});

	it("returns tool call without running it", async () => {
		const result = await providerConfig.streamSimple(model, {
			systemPrompt: "You classify shell commands. Always answer by calling classifier_decision exactly once, with no text.",
			messages: [user("Command: ls")],
			tools: [decisionTool],
		}, options).result();
		assert.equal(result.stopReason, "toolUse", result.errorMessage);
		const calls = result.content.filter((b) => b.type === "toolCall");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].name, "classifier_decision");
		assert.equal(typeof calls[0].arguments.allowed, "boolean");
		assert.match(calls[0].id, /^toolu_/);
	});
});
