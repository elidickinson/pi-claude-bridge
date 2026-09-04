#!/usr/bin/env node

/**
 * agent_start records the fully-widened system prompt.
 *
 * MCP tool descriptions merge into the system prompt only after their servers
 * connect — after before_agent_start. So event.systemPrompt there is the pre-widen
 * prompt, while the prompt the provider actually queries with (and that pi-subagents
 * embeds verbatim into a child via ctx.getSystemPrompt() at dispatch) is the widened
 * one. If only the pre-widen prompt is a capture key, a subagent's turn resolves
 * against nothing, falls to a verbatim side request, and ships pi's harness — which
 * trips the server's third-party plan-eligibility check ("out of extra usage").
 *
 * These pin that agent_start records ctx.getSystemPrompt(), so the widened prompt
 * resolves directly and a child embedding it resolves by inheritance.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test } = await import("../src/index.js");

function activateWithMockPi() {
	const handlers = new Map();
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {}, registerTool: () => {} });
	return handlers;
}

const PRE_WIDEN = "You are pi.\n# Tools\n- read: Read a file\n\npi packages (docs/packages.md)";
// Same prefix, then the MCP tool descriptions that only appear post-connect.
const WIDENED = "You are pi.\n# Tools\n- read: Read a file\n- Agent: Launch a subagent with a very long description ... \n\npi packages (docs/packages.md)";

describe("agent_start widened-prompt capture", () => {
	it("records ctx.getSystemPrompt() so the widened prompt itself resolves", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: PRE_WIDEN, systemPromptOptions: {} });

		// Before agent_start, only the pre-widen prompt is known; the widened one is not.
		assert.throws(
			() => __test.promptCaptures.resolveOrDerive(WIDENED),
			/no capture/,
			"the widened prompt must not resolve off the pre-widen record alone",
		);

		handlers.get("agent_start")({}, { getSystemPrompt: () => WIDENED });
		assert.ok(
			__test.promptCaptures.resolveOrDerive(WIDENED),
			"after agent_start the widened prompt resolves exactly",
		);
	});

	it("lets a child embedding the widened parent resolve by inheritance", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: PRE_WIDEN, systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => WIDENED });

		// pi-subagents embeds the widened parent prompt verbatim as the child's prefix.
		const child = `${WIDENED}\n\n<sub_agent_context>be concise</sub_agent_context>\n\n<active_agent name="worker"/>`;
		const resolved = __test.promptCaptures.resolveOrDerive(child);
		assert.ok(resolved, "child embedding the widened parent must resolve, not fall to a side request");
		assert.ok(
			resolved.inherited.length >= 1,
			"resolution must be via an inheritance edge onto the widened parent capture",
		);
	});
});
