/**
 * The ownership claim is resolved in before_agent_start; the provider path only
 * peeks at the cached answer and stays synchronous. When native Engram owns the
 * Pi session, the Claude Code child must not also run Claude Code's own Engram
 * plugin or MCP tools; on any other answer the query options stay as they were.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");
const { ENGRAM_PLUGIN_IDS, ENGRAM_MCP_TOOL_PREFIXES } = await import("../src/engram-ownership.js");
const { MCP_SERVER_NAME } = await import("../src/skills.js");

const CLAIM = "engram:bridge:claim:v1";
const DECISION = "engram:bridge:decision:v1";

/** Minimal pi event bus; `status` answers each claim synchronously (null = never replies). */
function makeBus(status) {
	const subs = new Map();
	const claims = [];
	const bus = {
		claims,
		on(channel, fn) {
			const set = subs.get(channel) ?? new Set();
			set.add(fn);
			subs.set(channel, set);
			return () => set.delete(fn);
		},
		emit(channel, data) {
			if (channel === CLAIM) {
				claims.push(data);
				if (status) bus.emit(DECISION, { runtimeSessionId: data.runtimeSessionId, nonce: data.nonce, operation: data.operation, status });
			}
			for (const fn of subs.get(channel) ?? []) fn(data);
		},
	};
	return bus;
}

function captureQuery(captured) {
	return ({ options }) => {
		captured.push(options);
		async function* gen() {
			yield { type: "result", subtype: "success", is_error: false, result: "ok" };
		}
		const q = gen();
		q.interrupt = async () => {};
		q.close = () => {};
		return q;
	};
}

let emit;
let clock = 0;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const MODEL = { id: "claude-sonnet-4-6", name: "s", api: "claude-bridge", provider: "claude-bridge", reasoning: true, input: ["text"], contextWindow: 200_000, maxTokens: 64_000 };

const { default: activateBridge } = await import("../src/index.js");

function activate(bus, { timeoutMs = 200 } = {}) {
	const byEvent = new Map();
	activateBridge({
		events: bus,
		on: (event, handler) => byEvent.set(event, [...(byEvent.get(event) ?? []), handler]),
		registerProvider: () => {},
		registerTool: () => {},
	});
	emit = (event, ...args) => Promise.all((byEvent.get(event) ?? []).map((h) => h(...args)));
	__test.configureEngramOwnership({ timeoutMs });
}

const ctxFor = (id, provider = "claude-bridge") => ({ ui: { notify() {} }, mode: "print", modelRegistry: { getProvider: () => ({}) }, cwd: process.cwd(), model: { provider }, sessionManager: { getSessionId: () => id } });
const beforeAgentStart = (id, provider) => emit("before_agent_start", { systemPrompt: "", systemPromptOptions: {} }, ctxFor(id, provider));

/** Starts a fresh provider query; asserts queryImpl ran synchronously. */
async function turn(sessionId) {
	const captured = [];
	__test.setQuery(captureQuery(captured));
	const stream = __test.streamClaudeAgentSdk(MODEL, { messages: [user("hi " + clock)], tools: [] }, { sessionId });
	assert.strictEqual(captured.length, 1, "queryImpl must be called synchronously");
	const result = await stream.result();
	assert.strictEqual(result.stopReason, "stop", result.errorMessage);
	return captured[0];
}

const plain = (options) => {
	assert.ok(!("enabledPlugins" in options.settings));
	assert.ok(!("disallowedTools" in options));
};

beforeEach(() => { __test.resetSharedSession(); });
afterEach(() => { __test.setQuery(null); __test.setProviderSettings({}); });

describe("engram bridge ownership in provider turns", () => {
	it("owned (after before_agent_start): disables the engram plugin and MCP tools, synchronously", async () => {
		const bus = makeBus("owned");
		activate(bus);
		await beforeAgentStart("pi-owned");
		const options = await turn("pi-owned");
		assert.deepStrictEqual(options.settings.enabledPlugins, Object.fromEntries(ENGRAM_PLUGIN_IDS.map((id) => [id, false])));
		assert.strictEqual(options.settings.enabledPlugins["engram@engram"], false);
		for (const key of ["autoMemoryEnabled", "claudeMdExcludes", "includeGitInstructions"]) {
			assert.ok(key in options.settings, `settings keeps ${key}`);
		}
		assert.deepStrictEqual(options.disallowedTools, [...ENGRAM_MCP_TOOL_PREFIXES]);
		assert.ok(ENGRAM_MCP_TOOL_PREFIXES.every((p) => !`mcp__${MCP_SERVER_NAME}`.startsWith(p)), "bridge MCP server must not match a disallowed prefix");
	});

	it("cold cache: options unchanged and the provider path emits no claim", async () => {
		const bus = makeBus("owned");
		activate(bus);
		plain(await turn("pi-cold"));
		assert.strictEqual(bus.claims.length, 0);
	});

	it("unknown: options unchanged, and the next before_agent_start claims again", async () => {
		const bus = makeBus("unknown");
		activate(bus);
		await beforeAgentStart("pi-unknown");
		plain(await turn("pi-unknown"));
		await beforeAgentStart("pi-unknown");
		assert.strictEqual(bus.claims.length, 2);
	});

	it("no responder: resolves after the timeout, options unchanged, and is not asked again", async () => {
		const bus = makeBus(null);
		activate(bus, { timeoutMs: 30 });
		const started = Date.now();
		await beforeAgentStart("pi-silent");
		assert.ok(Date.now() - started < 2_000);
		plain(await turn("pi-silent"));
		await beforeAgentStart("pi-silent");
		assert.strictEqual(bus.claims.length, 1);
	});

	it("engramOwnership:false emits nothing and leaves options unchanged", async () => {
		const bus = makeBus("owned");
		activate(bus);
		__test.setProviderSettings({ engramOwnership: false });
		await beforeAgentStart("pi-optout");
		plain(await turn("pi-optout"));
		assert.strictEqual(bus.claims.length, 0);
	});

	it("does not claim when the active model is not a bridge model", async () => {
		const bus = makeBus("owned");
		activate(bus);
		await beforeAgentStart("pi-other", "anthropic");
		assert.strictEqual(bus.claims.length, 0);
	});

	it("session_start resets the memo so the next before_agent_start claims again", async () => {
		const bus = makeBus("owned");
		activate(bus);
		await beforeAgentStart("pi-reset");
		await beforeAgentStart("pi-reset");
		assert.strictEqual(bus.claims.length, 1);
		await emit("session_start", { reason: "new" }, ctxFor("pi-reset"));
		plain(await turn("pi-reset"));
		await beforeAgentStart("pi-reset");
		assert.strictEqual(bus.claims.length, 2);
	});

	it("session_shutdown resets the memo too", async () => {
		const bus = makeBus("owned");
		activate(bus);
		await beforeAgentStart("pi-shut");
		await emit("session_shutdown", {}, ctxFor("pi-shut"));
		plain(await turn("pi-shut"));
	});

	it("the claim carries the session manager's session id", async () => {
		const bus = makeBus("owned");
		activate(bus);
		await beforeAgentStart("pi-session-xyz");
		assert.strictEqual(bus.claims.length, 1);
		assert.strictEqual(bus.claims[0].runtimeSessionId, "pi-session-xyz");
	});

	it("applies only to the claimed session id", async () => {
		const bus = makeBus("owned");
		activate(bus);
		await beforeAgentStart("pi-a");
		assert.ok((await turn("pi-a")).disallowedTools);
		plain(await turn("pi-b"));
	});
});
