#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi() {
	const handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {} });
	return handlers;
}

describe("extension prompt capture lifecycle", () => {
	it("records structured inputs against the prompt finalized by later extensions", async () => {
		const handlers = activateWithMockPi();
		const intermediatePrompt = "prompt before a later extension rewrites it";
		const finalPrompt = "completely replaced prompt";

		await handlers.get("before_agent_start")({
			systemPrompt: intermediatePrompt,
			systemPromptOptions: {
				contextFiles: [{ path: "/AGENTS.md", content: "project rules" }],
				skills: [],
				selectedTools: ["read"],
			},
		}, {});

		assert.equal(__test.resolvePromptCapture(intermediatePrompt), undefined);

		await handlers.get("agent_start")({}, { getSystemPrompt: () => finalPrompt });

		const capture = __test.resolvePromptCapture(finalPrompt);
		assert.ok(capture);
		assert.equal(capture.assembledPrompt, finalPrompt);
		assert.deepEqual(capture.contextFiles, [{ path: "/AGENTS.md", content: "project rules" }]);
	});
});
