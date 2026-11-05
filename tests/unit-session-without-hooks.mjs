#!/usr/bin/env node

/**
 * A host can serve a session with this provider without loading the extension in it:
 * pi-subagent-manager and pi-subagents children inherit the parent's provider registry
 * but no extensions, so before_agent_start/agent_start/turn_start never run for them and
 * no capture exists for their prompt. The bridge then projects the system message's own
 * sections. A session that did load the extension, whose prompt nothing accounts for,
 * still fails the turn.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-no-hooks-"));
process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");
delete process.env.CLAUDE_BRIDGE_DEBUG;
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

const PI_SYSTEM_PROMPT = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url));
assert.ok(existsSync(PI_SYSTEM_PROMPT), `pi's system prompt module is not at ${PI_SYSTEM_PROMPT}; if pi moved it, update this test`);
const { buildSystemPromptState } = await import(PI_SYSTEM_PROMPT);

const { default: activate, __test } = await import("../src/index.js");
const { PI_PREAMBLE, projectSystemMessage, PromptCaptures } = await import("../src/prompt-capture.js");

const systemMessage = (state) => ({ role: "system", content: "", ...state, timestamp: 0 });
const skill = {
	name: "demo", description: "A demo skill", filePath: "/skills/demo/SKILL.md",
	baseDir: "/skills/demo", disableModelInvocation: false,
};
const CONTEXT_FILES = [{ path: "/repo/AGENTS.md", content: "operator rules" }];

describe("projectSystemMessage", () => {
	it("forwards a custom prompt and nothing pi renders for itself or the host", () => {
		const message = systemMessage(buildSystemPromptState({ customPrompt: "You are a tasker.", cwd: "/work" }));
		assert.equal(projectSystemMessage(message, { skillReadTool: "mcp" }), "You are a tasker.");
	});

	it("forwards project context, skills, append, then custom sections, in the order projectCapture uses", () => {
		const message = systemMessage(buildSystemPromptState({
			customPrompt: "You are a tasker.",
			appendSystemPrompt: "Be brief.",
			contextFiles: CONTEXT_FILES,
			skills: [skill],
			selectedTools: ["read"],
			sections: { mcp_servers: "server list" },
			cwd: "/work",
		}));
		const projected = projectSystemMessage(message, { skillReadTool: "mcp" });
		const at = (needle) => projected.indexOf(needle);
		assert.ok(at("operator rules") !== -1 && at("operator rules") < at("<skills>"));
		assert.ok(at("<skills>") < at("You are a tasker."));
		assert.ok(at("You are a tasker.") < at("Be brief."));
		assert.ok(at("Be brief.") < at("<mcp_servers>"));
		assert.match(projected, /Use the read tool \(mcp__custom-tools__read\) to load a skill's file/);
		assert.ok(!projected.includes("<cwd>"), "cwd is Claude Code's own to supply");
	});

	it("leaves out the skills block when Claude Code has no way to read a skill file", () => {
		const message = systemMessage(buildSystemPromptState({ customPrompt: "x", skills: [skill], selectedTools: ["read"], cwd: "/w" }));
		assert.ok(!projectSystemMessage(message, { skillReadTool: "none" }).includes("<skills>"));
	});

	it("drops pi's own preamble, tools, rules and docs when there is no custom prompt", () => {
		const message = systemMessage(buildSystemPromptState({ contextFiles: CONTEXT_FILES, cwd: "/work" }));
		const projected = projectSystemMessage(message, { skillReadTool: "mcp" });
		assert.ok(projected.includes("operator rules"));
		assert.ok(!projected.includes(PI_PREAMBLE));
		assert.ok(!projected.includes("<tools>") && !projected.includes("<docs>") && !projected.includes("<rules>"));
	});

	it("forwards a forced prompt, which has no sections, from the message content", () => {
		const message = systemMessage(buildSystemPromptState({ forceSystemPrompt: "forced prompt", cwd: "/w" }));
		assert.equal(projectSystemMessage(message, { skillReadTool: "mcp" }), "forced prompt");
	});

	it("refuses a custom prompt that carries pi's harness", () => {
		const message = systemMessage(buildSystemPromptState({ customPrompt: `${PI_PREAMBLE}, a coding agent harness.`, cwd: "/w" }));
		assert.throws(() => projectSystemMessage(message, { skillReadTool: "mcp" }), /refusing to send this prompt/);
	});
});

describe("PromptCaptures.resolveOrDerive with throwOnMiss: false", () => {
	it("returns undefined on a miss, and still resolves an exact or inherited prompt", () => {
		const captures = new PromptCaptures();
		const parent = "parent prompt, long enough to be an unambiguous key";
		captures.record(parent, { contextFiles: [], skills: [] }, "agent_start");
		assert.equal(captures.resolveOrDerive("nothing like it", { throwOnMiss: false }), undefined);
		assert.equal(captures.resolveOrDerive(parent, { throwOnMiss: false })?.assembledPrompt, parent);
		assert.equal(captures.resolveOrDerive(`wrapper\n\n${parent}`, { throwOnMiss: false })?.inherited.length, 1);
	});
});

describe("provider turn for a session", () => {
	let providerConfig;
	let queryOptions;
	const sentinel = "query reached";

	activate({ on: () => {}, registerProvider: (_name, config) => { providerConfig = config; }, registerTool: () => {} });
	const turn = (sessionId, state) => providerConfig.streamSimple(
		providerConfig.models[0],
		{ messages: [systemMessage(state), { role: "user", content: "hi", timestamp: 0 }] },
		{ sessionId },
	);

	beforeEach(() => {
		queryOptions = undefined;
		__test.setQuery(({ options }) => { queryOptions = options; throw new Error(sentinel); });
	});
	afterEach(() => __test.setQuery(null));

	it("that never ran the bridge's hooks sends its sections instead of failing", async () => {
		const result = await turn("session-without-hooks", buildSystemPromptState({ customPrompt: "You are a tasker.", cwd: "/work" })).result();
		assert.doesNotMatch(result.errorMessage ?? "", /prompt-capture/);
		assert.equal(queryOptions.systemPrompt.append, "You are a tasker.");
	});

	it("that ran session_start still fails when nothing accounts for its prompt", async () => {
		const sessionStart = [];
		activate({
			on: (event, handler) => { if (event === "session_start") sessionStart.push(handler); },
			registerProvider: () => {},
			registerTool: () => {},
		});
		const ctx = {
			ui: undefined, mode: "print", cwd: "/work",
			modelRegistry: { getProvider: () => ({}) },
			sessionManager: { getSessionId: () => "session-with-hooks" },
		};
		for (const handler of sessionStart) handler({ reason: "startup" }, ctx);
		const result = await turn("session-with-hooks", buildSystemPromptState({ customPrompt: "unrecorded", cwd: "/work" })).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /prompt-capture: no capture/);
		assert.equal(queryOptions, undefined);
	});
});
