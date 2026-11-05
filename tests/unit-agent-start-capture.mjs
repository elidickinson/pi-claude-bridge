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
import { PI_PREAMBLE, projectPromptCapture } from "../src/prompt-capture.js";
import { activateWithMockPi } from "./lib/mock-pi.mjs";

const { __test } = await import("../src/index.js");

const PRE_WIDEN = "You are pi.\n# Tools\n- read: Read a file\n\npi packages (docs/packages.md)";
// Same prefix, then the MCP tool descriptions that only appear post-connect.
const WIDENED = "You are pi.\n# Tools\n- read: Read a file\n- Agent: Launch a subagent with a very long description ... \n\npi packages (docs/packages.md)";

describe("agent_start widened-prompt capture", () => {
	it("records ctx.getSystemPrompt() so the widened prompt itself resolves", () => {
		const handlers = activateWithMockPi();
		const contextFiles = [{ path: "/AGENTS.md", content: "project rules" }];
		handlers.get("before_agent_start")({ systemPrompt: PRE_WIDEN, systemPromptOptions: { contextFiles } });

		// Before agent_start, only the pre-widen prompt is known; the widened one is not.
		assert.throws(
			() => __test.promptCaptures.resolveOrDerive(WIDENED),
			/no capture/,
			"the widened prompt must not resolve off the pre-widen record alone",
		);

		handlers.get("agent_start")({}, { getSystemPrompt: () => WIDENED });
		const capture = __test.promptCaptures.resolveOrDerive(WIDENED);
		assert.ok(capture, "after agent_start the widened prompt resolves exactly");
		assert.deepEqual(capture.contextFiles, contextFiles, "carrying the before_agent_start context files");
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
});

describe("subagent captures", () => {
	it("makes isolated subagent captures resolve via the shared registry (#64)", async () => {
		activateWithMockPi();
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

	// Tail-stripped inheritance (#88) is unsupported: a child embedding its parent prompt
	// minus pi's per-session tail (skills catalogue, cwd footer) matches no full-prompt key.
	// gotgenes/pi-subagents strips the tail; elidickinson/pi-subagents embeds verbatim.
	it("fails loudly when a recorded tail-stripped child has no inheritance edge (#88)", () => {
		const section = (name, content) => `<${name}>\n${content}\n</${name}>`;
		const parentSections = [
			`${PI_PREAMBLE}, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`,
			section("tools", "- read: Read a file\n- bash: Run commands\n\nIn addition to the tools above, you may have access to other custom tools depending on the project."),
			section("rules", "- Use bash for file operations like ls, rg, find\n- Be concise in your responses"),
			section("docs", "Pi documentation (read only when the user asks about pi itself):\n- Main documentation: /pi/README.md"),
			section("project_context", "Project-specific instructions and guidelines:\n\n<project_instructions path=\"/parent/AGENTS.md\">\nParent rules.\n</project_instructions>"),
			section("skills", "The following skills provide specialized instructions for specific tasks.\n\n<available_skills>\n  <skill>\n    <name>deploy</name>\n    <description>Deploy the application.</description>\n  </skill>\n</available_skills>"),
			section("cwd", "/parent"),
		];
		const parentPrompt = parentSections.join("\n\n");
		const strippedChild = `${parentSections.slice(0, 5).join("\n\n")}\n\n<active_agent name="Explore"/>\n\n# Environment\nWorking directory: /child\nGit repository: yes\nBranch: main\nPlatform: darwin`;

		const handlers = activateWithMockPi();
		handlers.get("before_agent_start")({ systemPrompt: parentPrompt, systemPromptOptions: {} });
		handlers.get("agent_start")({}, { getSystemPrompt: () => parentPrompt });

		// The child is recorded at both production capture boundaries, but its custom
		// prompt contains only the tail-stripped parent shape, so no edge is matched.
		handlers.get("before_agent_start")({
			systemPrompt: strippedChild,
			systemPromptOptions: { customPrompt: strippedChild },
		});
		handlers.get("agent_start")({}, { getSystemPrompt: () => strippedChild });

		const capture = __test.promptCaptures.resolve(strippedChild);
		assert.ok(capture, "the tail-stripped child must be recorded before projection");
		assert.equal(capture.inherited.length, 0, "the unsupported embedding must not invent an inheritance edge");
		assert.throws(
			() => projectPromptCapture(capture, { hasReadTool: false }),
			/prompt-capture: refusing to send this prompt/,
			"an unmatched recorded child must fail before its harness reaches Claude Code",
		);
	});
});
