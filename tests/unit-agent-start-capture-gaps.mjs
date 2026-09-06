#!/usr/bin/env node

/**
 * Gaps the agent_start capture does NOT close, pinned so the boundary is explicit.
 *
 * The agent_start record keys the prompt pi renders from the final before_agent_start
 * options (ctx.getSystemPrompt()), carrying the stashed portable parts. That fixes the
 * widened-dispatch case (see unit-agent-start-capture.mjs), and tail-stripped inheritance
 * (issue #88) is fixed by matching children that embed a stripped parent — see
 * unit-tail-stripped-inheritance.mjs. The reported failure shapes that still fall
 * outside it:
 *
 * 1. A prompt composed entirely outside pi's before_agent_start pipeline (issue #102's
 *    pi-web-ui shape) is neither a rendered-options key, a handler-returned force
 *    (which agent_start does capture — see the force test below), nor an embedding.
 * 2. A prompt that changes AFTER turn_start (issue #91's remaining shape): turn_start
 *    re-keys every turn (first included), but a prompt rewritten between turn_start and
 *    the stream call — an extension context-event handler or a forced-prompt projection
 *    on newer pi — is seen by no boundary.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi(activateFn) {
	const handlers = new Map();
	(activateFn ?? activate)({
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: () => {},
		registerTool: () => {},
	});
	return handlers;
}

describe("agent_start capture — documented gaps", () => {
	it("makes isolated subagent captures resolve via the shared registry (#64)", async () => {
		const parent = activateWithMockPi();
		// An isolated agent re-evaluates the module; its records land in the same
		// process-wide registry the pinned stream resolves against.
		const { default: activateFresh, __test: freshTest } = await import("../src/index.js?isolated-child");
		const child = activateWithMockPi(activateFresh);

		const isolatedPrompt = "You are an isolated smoke-test agent. Respond with ZZ_ISO_OK.";
		child.get("before_agent_start")({ systemPrompt: isolatedPrompt, systemPromptOptions: {} });
		child.get("agent_start")({}, { getSystemPrompt: () => isolatedPrompt });

		assert.ok(freshTest.promptCaptures.resolve(isolatedPrompt), "the child instance recorded its own prompt");
		assert.ok(
			__test.promptCaptures.resolveOrDerive(isolatedPrompt),
			"the shared registry the pinned stream resolves against resolves the child's prompt",
		);
		assert.equal(freshTest.promptCaptures, __test.promptCaptures, "both instances share one capture registry");
	});

	it("does capture a handler-returned wholesale replacement: it resolves via the agent_start key", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: "pi rendered prompt", systemPromptOptions: {} });
		// A before_agent_start handler that RETURNS a system prompt forces it as the request
		// head, and pi renders ctx.getSystemPrompt() as exactly that forced text
		// (buildSystemPromptState returns forceSystemPrompt verbatim).
		handlers.get("agent_start")({}, { getSystemPrompt: () => "forced replacement prompt owning the request head" });

		const capture = __test.promptCaptures.resolve("forced replacement prompt owning the request head");
		assert.ok(capture, "the forced text becomes a capture key at agent_start");
		// Caveat pinned by design: only the portable parts are projected for Claude Code;
		// the forced text's own novel prose is not forwarded (forwarding pi-harness-shaped
		// prose would trip the server's third-party gate).
	});

	it("does not rescue a prompt composed outside the before_agent_start pipeline (#102 shape)", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: "pi rendered prompt", systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => "pi rendered prompt" });

		// A host composing the prompt from its own template outside pi's pipeline —
		// neither a rendered-options key, a handler-returned force, nor an embedding.
		assert.throws(
			() => __test.promptCaptures.resolveOrDerive("host-composed prompt owning the request head"),
			/no capture/,
			"out-of-pipeline composition is neither a recorded key nor an embedding of one",
		);
	});

	it("does not see a prompt replaced between turn_start and the stream call (#91 remaining shape)", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: "turn-1 prompt", systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => "turn-1 prompt" });
		handlers.get("turn_start")({}, { getSystemPrompt: () => "turn-2 rendered prompt" });
		assert.ok(__test.promptCaptures.resolveOrDerive("turn-2 rendered prompt"), "the turn_start record resolves");

		// A rewrite landing after turn_start — a context-event handler replacing the
		// system message, or a forced-prompt projection on newer pi — is seen by no
		// recording boundary. When it neither is nor embeds a known key, it throws.
		assert.throws(
			() => __test.promptCaptures.resolveOrDerive("replacement head installed by a context handler"),
			/no capture/,
			"post-turn_start rewrites are seen by no recording boundary",
		);
	});
});
