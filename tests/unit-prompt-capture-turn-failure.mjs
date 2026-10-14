/**
 * A system prompt the bridge refuses to forward fails the turn through the returned
 * stream instead of throwing out of streamSimple: both the unresolvable prompt
 * (resolveOrDerive) and the sendability guard (projectPromptCapture). No query starts
 * and no stream is left claimed, so the next turn is unaffected.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The failure path writes a diag entry to pi's agent dir, which the bridge resolves
// at import time: point it at a throwaway dir so the real diag log is untouched.
// The agent dir itself does not exist yet, so a diag write that cannot create it
// would throw out of streamSimple instead of failing the turn. Debug stays off: with
// CLAUDE_BRIDGE_DEBUG=1 the bridge creates the dir at import and hides that throw.
const tmpRoot = mkdtempSync(join(tmpdir(), "claude-bridge-turn-failure-"));
const agentDir = join(tmpRoot, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.CLAUDE_BRIDGE_DEBUG;
process.on("exit", () => rmSync(tmpRoot, { recursive: true, force: true }));

const { default: activate, __test } = await import("../src/index.js");
const { PI_PREAMBLE } = await import("../src/prompt-capture.js");

let providerConfig;
activate({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});
const model = providerConfig.models[0];
const turn = (systemPrompt) => providerConfig.streamSimple(
	model,
	{ systemPrompt, messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] },
	{ sessionId: "pi-session" },
);

let queries;
beforeEach(() => {
	queries = 0;
	__test.setQuery(() => { queries++; throw new Error("no query should start"); });
});
afterEach(() => __test.setQuery(null));

describe("a prompt the bridge refuses", () => {
	it("fails the turn on the stream when no capture accounts for a pi-assembled prompt", async () => {
		const result = await turn(`${PI_PREAMBLE}, but this key was never recorded at before_agent_start`).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /prompt-capture: no capture/);
		assert.equal(queries, 0);
		assert.equal(__test.activeQueryContexts.size, 0);
		assert.ok(existsSync(join(agentDir, "claude-bridge-diag.log")));
	});

	it("fails the turn on the stream when the sendability guard refuses the capture", async () => {
		const prompt = `${PI_PREAMBLE}, recorded with pi's harness in its custom prompt.`;
		__test.promptCaptures.record(prompt, { custom: prompt, contextFiles: [], skills: [] });
		const result = await turn(prompt).result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage, /prompt-capture: refusing to send this prompt/);
		assert.equal(queries, 0);
	});
});

describe("unresolved non-pi system prompts", () => {
	it("routes side-channel custom prompts to the isolated one-shot path", async () => {
		let seen;
		__test.setQuery(({ prompt, options }) => {
			seen = { prompt, systemPrompt: options.systemPrompt, persistSession: options.persistSession };
			async function* gen() {
				yield { type: "result", subtype: "success", is_error: false, result: "advice" };
			}
			const q = gen();
			q.interrupt = async () => {};
			q.close = () => {};
			return q;
		});

		const custom = "You are the Advisor: a senior engineer giving a brief second opinion.";
		const result = await turn(custom).result();
		assert.equal(result.stopReason, "stop");
		assert.equal(seen.systemPrompt, custom);
		assert.equal(seen.persistSession, false);
		assert.equal(seen.prompt, "hi");
		assert.equal(__test.activeQueryContexts.size, 0);
		assert.ok(existsSync(join(agentDir, "claude-bridge-diag.log")));
	});
});
