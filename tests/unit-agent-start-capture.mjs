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
	activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {}, registerTool: () => {}, registerCommand: () => {} });
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

	it("carries the stashed portable parts onto the widened key", () => {
		const handlers = activateWithMockPi();
		const contextFiles = [{ path: "/AGENTS.md", content: "project rules" }];
		handlers.get("before_agent_start")({
			systemPrompt: PRE_WIDEN,
			systemPromptOptions: { contextFiles, skills: [], selectedTools: ["read"] },
		});
		handlers.get("agent_start")({}, { getSystemPrompt: () => WIDENED });

		const capture = __test.promptCaptures.resolve(WIDENED);
		assert.ok(capture, "widened key must be recorded");
		assert.deepEqual(capture.contextFiles, [{ path: "/AGENTS.md", content: "project rules" }],
			"the widened capture must carry the before_agent_start context files, not empty ones");
	});
});

describe("turn_start prompt capture", () => {
	it("re-keys a prompt rebuilt between turns with the stashed portable parts", () => {
		const handlers = activateWithMockPi();
		const contextFiles = [{ path: "/AGENTS.md", content: "project rules" }];
		handlers.get("before_agent_start")({
			systemPrompt: PRE_WIDEN,
			systemPromptOptions: { contextFiles, skills: [], selectedTools: ["read"] },
		});
		handlers.get("agent_start")({}, { getSystemPrompt: () => WIDENED });

		// A later in-run turn renders a new prompt (mid-run tool-loadout change,
		// section re-render). turn_start re-keys it.
		const turnTwo = `${WIDENED}\n# Tools\n- git_status: Report repo state\n`;
		handlers.get("turn_start")({}, { getSystemPrompt: () => turnTwo });

		const capture = __test.promptCaptures.resolve(turnTwo);
		assert.ok(capture, "the rebuilt prompt must resolve after turn_start");
		assert.deepEqual(capture.contextFiles, [{ path: "/AGENTS.md", content: "project rules" }],
			"the mid-run capture must carry the stashed portable parts");
	});

	it("is idempotent when the same prompt is re-fired", () => {
		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: PRE_WIDEN, systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => WIDENED });

		const before = __test.promptCaptures.size;
		handlers.get("turn_start")({}, { getSystemPrompt: () => WIDENED });
		handlers.get("turn_start")({}, { getSystemPrompt: () => WIDENED });

		assert.ok(__test.promptCaptures.resolve(WIDENED), "the prompt still resolves");
		assert.equal(__test.promptCaptures.size, before, "re-firing an unchanged prompt must not grow the registry");
	});
});
