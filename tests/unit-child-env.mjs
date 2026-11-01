/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns. These are silent when missing: CC compacts or writes memory
 * on its own, nothing throws, and the damage shows up in the user's ~/.claude
 * rather than in a test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");
const { activateWithMockPi } = await import("./lib/mock-pi.mjs");

describe("Claude Code child environment", () => {
	it("disables auto-compaction, claude.ai MCP servers, request logging, non-essential traffic and interrupted-turn resume", () => {
		assert.deepEqual(__test.CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
			CLAUDE_CODE_ELEGANT_MEADOW: "0",
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS: "1",
		});
	});

	it("keeps the traffic flag off pi's own process, where every command pi runs would inherit it", () => {
		const saved = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		try {
			activateWithMockPi();
			assert.equal(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
		} finally {
			if (saved !== undefined) process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = saved;
		}
	});

	const config = { ANTHROPIC_API_KEY: "key", CLAUDE_CONFIG_DIR: "/cfg", CLAUDE_CODE_USE_BEDROCK: "1", AI_AGENT: "pi" };

	it("drops a parent Claude Code session's markers when pi was started from inside one, keeping config", () => {
		const parent = {
			...config,
			CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CODE_CHILD_SESSION: "1",
			CLAUDE_ENV_FILE: "/parent/env.sh", CLAUDE_AGENT_SDK_VERSION: "0.0.1", CLAUDE_CODE_SSE_PORT: "1234", TRACEPARENT: "00-parent",
		};
		const env = __test.ccChildEnv(undefined, parent);
		assert.deepEqual(env, { ...config, ...__test.CC_CHILD_ENV });
		assert.equal(parent.CLAUDECODE, "1", "pi's own environment is not modified");
	});

	it("passes everything through when pi wasn't started from Claude Code", () => {
		const parent = { ...config, CLAUDE_CODE_ENTRYPOINT: "claude-vscode", TRACEPARENT: "00-user" };
		assert.deepEqual(__test.ccChildEnv(undefined, parent), { ...parent, ...__test.CC_CHILD_ENV });
	});

	it("applies pi's provider env over pi's own, an empty value unsetting, without dropping the bridge's guards", () => {
		const env = __test.ccChildEnv({ HTTPS_PROXY: "http://proxy", ANTHROPIC_API_KEY: "", DISABLE_AUTO_COMPACT: "0" }, config);
		const { ANTHROPIC_API_KEY: _unset, ...kept } = config;
		assert.deepEqual(env, { ...kept, HTTPS_PROXY: "http://proxy", ...__test.CC_CHILD_ENV });
	});

	it("refuses a provider env that would move Claude Code's session files", () => {
		assert.throws(() => __test.ccChildEnv({ CLAUDE_CONFIG_DIR: "/elsewhere" }, config), /CLAUDE_CONFIG_DIR/);
		assert.throws(() => __test.ccChildEnv({ home: "/elsewhere" }, config), /home/);
	});

	it("passes the request's env to the isolated summary query", async () => {
		const launches = [];
		__test.setQuery(({ options }) => {
			launches.push(options);
			const q = (async function* () { yield { type: "result", subtype: "success", is_error: false, result: "ok" }; })();
			q.interrupt = async () => {};
			q.close = () => {};
			return q;
		});
		try {
			const model = { id: "claude-haiku-4-5", api: "claude-bridge", provider: "claude-bridge", reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 64_000 };
			const context = { systemPrompt: "Summarize.", messages: [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: 0 }] };
			const result = await __test.isolatedStreamFn(model, context, { cacheRetention: "none", env: { HTTPS_PROXY: "http://proxy" } }).result();
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(launches[0].env.HTTPS_PROXY, "http://proxy");
		} finally {
			__test.setQuery(null);
		}
	});

	// Deliberately not asserted here: that every `query()` call site spreads the
	// constant. The only way to check that from a unit test is to grep src/index.ts,
	// which fails on innocent indirection (`env: childEnv`) and would have to be
	// taught about it — a brittle test that reads as coverage. The three sites
	// calling ccChildEnv() are the guard, and a fourth is a review question.
});
