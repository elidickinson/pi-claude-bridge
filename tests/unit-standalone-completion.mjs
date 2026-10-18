#!/usr/bin/env node

/**
 * One option: provider.allowExtensionSystemPrompts serves an extension's one-shot call
 * — a permission reviewer sends its own policy as the system prompt, no tools, one user
 * message — which by default no agent boundary recorded, so the capture resolver refuses
 * it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");
const { isStandaloneCompletion, servesAsStandalone } = __test;

const user = (content) => ({ role: "user", content, timestamp: 0 });
const reviewer = { systemPrompt: "You are a security reviewer.", messages: [user("verdict?")] };
const read = { name: "read", description: "Read a file", parameters: {} };

describe("standalone completion shape", () => {
	it("matches a tool-less, single-user-message call with a system prompt", () => {
		assert.equal(isStandaloneCompletion(reviewer), true);
		assert.equal(isStandaloneCompletion({ ...reviewer, tools: [] }), true);
	});

	it("leaves agent turns to prompt capture", () => {
		assert.equal(isStandaloneCompletion({ ...reviewer, tools: [read] }), false, "an agent turn has tools");
		assert.equal(
			isStandaloneCompletion({ ...reviewer, messages: [user("a"), { role: "assistant", content: [] }, user("b")] }),
			false,
			"history means an agent conversation",
		);
		assert.equal(isStandaloneCompletion({ ...reviewer, systemPrompt: undefined }), false, "nothing to forward");
	});
});

describe("standalone completion opt-in", () => {
	it("routes only when the extension option is on", () => {
		assert.equal(servesAsStandalone(reviewer, true), true);
		assert.equal(servesAsStandalone(reviewer, false), false, "off by default keeps the refusal");
		assert.equal(servesAsStandalone({ ...reviewer, tools: [read] }, true), false);
	});
});
