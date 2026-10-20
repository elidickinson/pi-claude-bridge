/**
 * Per-child environment hook (src/child-env.ts).
 *
 * The SDK's options.env replaces the Claude Code subprocess environment, so the
 * environment a listener publishes for one session's child must reach exactly
 * that child and nothing else — not a concurrent session's child, not an
 * auxiliary summary/AskClaude child the listener declined, and never the parent's
 * process.env. A wrong route fails silently, so these pin it.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import activate, { __test } from "../src/index.js";
import { CHILD_ENV_CHANNEL, bindChildEnvSession, buildChildEnv, unbindChildEnvSession } from "../src/child-env.js";

const GUARDS = __test.CC_CHILD_ENV;
const ROUTE = "CLAUDE_BRIDGE_TEST_ROUTE";
const target = (sessionId, purpose = "provider") => ({ purpose, sessionId, model: { id: "m", provider: "p", contextWindow: 1 } });
const bus = () => {
	const handlers = [];
	return { handlers, emit: (channel, data) => { for (const h of handlers) if (channel === CHILD_ENV_CHANNEL) h(data); } };
};
const snapshot = () => JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)));

describe("buildChildEnv", () => {
	const owner = {};
	afterEach(() => unbindChildEnvSession("s", owner));

	it("applies registered transforms to a copy of the base and re-applies guards last", () => {
		assert.deepEqual(buildChildEnv({ A: "1", U: undefined }, GUARDS, target("s")), { A: "1", ...GUARDS }, "no binding: base plus guards");
		const b = bus();
		const seen = [];
		b.handlers.push((req) => {
			seen.push({ purpose: req.purpose, sessionId: req.sessionId, model: req.model });
			req.register((env) => {
				const { A: _drop, ...rest } = env;
				return { ...rest, [ROUTE]: "r", DISABLE_AUTO_COMPACT: "0" };
			});
		});
		bindChildEnvSession("s", b, owner);
		const base = { A: "1" };
		const before = snapshot();
		assert.deepEqual(buildChildEnv(base, GUARDS, target("s", "summary")), { [ROUTE]: "r", ...GUARDS });
		assert.deepEqual(base, { A: "1" }, "the base record is never touched");
		assert.equal(snapshot(), before, "process.env is never touched");
		assert.deepEqual(seen, [{ purpose: "summary", sessionId: "s", model: { id: "m", provider: "p", contextWindow: 1 } }]);
	});

	it("a failing bus or transform keeps the previous environment and reports a fixed diagnostic", () => {
		const SECRET = "sk-ant-dummy-sentinel-0123456789";
		const errors = [];
		bindChildEnvSession("s", { emit: () => { throw new Error(SECRET); } }, owner);
		assert.deepEqual(buildChildEnv({ A: "1" }, GUARDS, target("s"), (m) => errors.push(m)), { A: "1", ...GUARDS });

		const b = bus();
		b.handlers.push((req) => req.register((env) => { env[ROUTE] = "leak"; delete env.A; throw new Error(SECRET); }));
		b.handlers.push((req) => req.register(async (env) => ({ ...env, [ROUTE]: "async" })));
		b.handlers.push((req) => req.register((env) => ({ ...env, [ROUTE]: 1 })));
		b.handlers.push((req) => req.register(() => ["A=2"]));
		b.handlers.push((req) => req.register((env) => ({ ...env, SEEN: env[ROUTE] ?? "clean" })));
		bindChildEnvSession("s", b, owner);
		assert.deepEqual(buildChildEnv({ A: "1" }, GUARDS, target("s"), (m) => errors.push(m)), { A: "1", SEEN: "clean", ...GUARDS });
		assert.deepEqual(errors, [
			"emit failed; using the base environment",
			"transform 0 threw; result ignored",
			"transform 1 returned an invalid environment; ignored",
			"transform 2 returned an invalid environment; ignored",
			"transform 3 returned an invalid environment; ignored",
		]);
	});

	it("pins storage variables to the base through every transform and the guards", () => {
		const base = { A: "1", CLAUDE_CONFIG_DIR: "/dummy/parent-claude", Home: "/dummy/parent-home", USERPROFILE: "" };
		const b = bus();
		const seen = [];
		// Change, add case variants of, and remove storage variables.
		b.handlers.push((req) => req.register((env) => ({
			...env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9/dummy-proxy",
			CLAUDE_CONFIG_DIR: "/dummy/x", HOME: "/dummy/x", claude_config_dir: "/dummy/x",
		})));
		b.handlers.push((req) => req.register((env) => {
			seen.push({ ...env });
			const { USERPROFILE: _drop, ...rest } = env;
			return rest;
		}));
		b.handlers.push((req) => req.register((env) => { seen.push({ ...env }); return env; }));
		bindChildEnvSession("s", b, owner);
		const errors = [];
		const guards = { ...GUARDS, CLAUDE_CONFIG_DIR: "/dummy/guard", USERPROFILE: "/dummy/guard" };
		const expected = { ...base, ANTHROPIC_BASE_URL: "http://127.0.0.1:9/dummy-proxy", ...GUARDS };
		assert.deepEqual(buildChildEnv(base, guards, target("s"), (m) => errors.push(m)), expected, "absent stays absent, empty stays empty");
		assert.deepEqual(seen, [expected, expected], "no transform sees a changed value");
		assert.deepEqual(errors, [
			"transform 0 changed Claude Code storage variables; restored the base values",
			"transform 1 changed Claude Code storage variables; restored the base values",
		]);
	});

	it("closes registration when emit returns and detaches the committed record", async () => {
		const b = bus();
		let held, lateRegister;
		b.handlers.push(async (req) => {
			req.register((env) => (held = { ...env, [ROUTE]: "committed" }));
			await Promise.resolve();
			try { req.register((env) => env); } catch (err) { lateRegister = err; }
		});
		bindChildEnvSession("s", b, owner);
		const env = buildChildEnv({ A: "1" }, GUARDS, target("s"));
		await new Promise((r) => setImmediate(r));
		held[ROUTE] = "mutated";
		assert.match(String(lateRegister), /after the request closed/);
		assert.deepEqual(env, { A: "1", [ROUTE]: "committed", ...GUARDS });
	});

	it("the latest bind wins, and only the current owner's unbind removes it", () => {
		const first = bus(), second = bus(), otherOwner = {};
		const hits = [];
		first.handlers.push(() => hits.push("first"));
		second.handlers.push(() => hits.push("second"));
		const request = () => buildChildEnv({}, GUARDS, target("s"));
		bindChildEnvSession("s", first, owner);
		bindChildEnvSession("s", second, owner);
		request();
		bindChildEnvSession("s", first, otherOwner);
		request();
		unbindChildEnvSession("s", owner);
		request();
		unbindChildEnvSession("s", otherOwner);
		request();
		assert.deepEqual(hits, ["second", "first", "first"]);
	});

	it("separate module instances share one registry", async () => {
		const other = await import("../src/child-env.ts?instance=second");
		assert.notEqual(other.buildChildEnv, buildChildEnv, "a distinct module instance");
		const b = bus();
		b.handlers.push((req) => req.register((env) => ({ ...env, [ROUTE]: "shared" })));
		other.bindChildEnvSession("s", b, owner);
		assert.equal(buildChildEnv({}, GUARDS, target("s"))[ROUTE], "shared");
	});
});

const model = { id: "claude-sonnet-4-6", name: "Controlled bridge", api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const ev = (event) => ({ type: "stream_event", event });

describe("child env at real query construction", () => {
	const queries = [];
	const sessions = [];
	let beforeYield;
	let result;
	beforeEach(() => {
		queries.length = 0;
		beforeYield = async () => {};
		result = "ok";
		__test.setQuery(({ options }) => {
			queries.push(options);
			const gen = (async function* () {
				await beforeYield();
				yield { type: "system", subtype: "init", session_id: options.resume ?? `cc-${queries.length}` };
				yield ev({ type: "message_start", message: { id: `msg_${queries.length}`, usage: {} } });
				yield ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				yield ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: result } });
				yield ev({ type: "content_block_stop", index: 0 });
				yield ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} });
				yield ev({ type: "message_stop" });
				yield { type: "result", subtype: "success", is_error: false, result };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
	});
	afterEach(async () => {
		for (const s of sessions.splice(0)) {
			await s.session.extensionRunner.emit({ type: "session_shutdown" });
			s.session.dispose();
			rmSync(s.root, { recursive: true, force: true });
		}
		__test.setQuery(null);
		__test.resetSharedSession();
	});

	async function openSession({ listener, history = false, sessionModel = model } = {}) {
		const root = mkdtempSync(join(tmpdir(), "claude-bridge-child-env-"));
		const manager = SessionManager.inMemory(root);
		if (history) {
			for (let turn = 0; turn < 4; turn++) {
				manager.appendMessage({ role: "user", content: `turn ${turn} ` + "context ".repeat(200), timestamp: turn * 2 });
				manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "answer ".repeat(200) }], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", usage: { input: 2000, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 2200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: turn * 2 + 1 });
			}
		}
		const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 50 }, retry: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, settingsManager: settings,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: listener ? [activate, listener] : [activate],
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		const { session } = await createAgentSession({ cwd: root, agentDir: process.env.PI_CODING_AGENT_DIR, resourceLoader: loader, sessionManager: manager, settingsManager: settings, noTools: "all", model: sessionModel });
		await session.bindExtensions({ onError: (error) => { throw new Error(error.error); } });
		const s = { session, sessionId: manager.getSessionId(), root };
		sessions.push(s);
		return s;
	}

	// Routes the purposes it is given, recording every request it sees.
	const routingListener = (requests, purposes = ["provider"]) => (pi) => {
		pi.events.on(CHILD_ENV_CHANNEL, (req) => {
			requests.push({ purpose: req.purpose, sessionId: req.sessionId, model: req.model });
			if (purposes.includes(req.purpose)) req.register((env) => ({ ...env, [ROUTE]: req.sessionId }));
		});
	};

	it("overlapping sessions each get their own route and model; process.env is untouched", { timeout: 20000 }, async () => {
		const requests = [];
		const opus = { ...model, id: "claude-opus-4-6", name: "Controlled bridge (opus)" };
		const a = await openSession({ listener: routingListener(requests) });
		const b = await openSession({ listener: routingListener(requests), sessionModel: opus });
		const plain = await openSession();
		const before = snapshot();
		// No query may finish until all three are constructed.
		let release;
		const allBuilt = new Promise((r) => { release = r; });
		beforeYield = async () => { if (queries.length === 3) release(); await allBuilt; };
		await Promise.all([a, b, plain].map((s) => s.session.prompt("hello")));
		const envOf = (s) => queries.find((o) => o.cwd === s.root).env;
		assert.equal(envOf(a)[ROUTE], a.sessionId);
		assert.equal(envOf(b)[ROUTE], b.sessionId);
		assert.equal(envOf(plain)[ROUTE], undefined, "a session without a listener gets the base env");
		for (const s of [a, b, plain]) assert.equal(envOf(s).DISABLE_AUTO_COMPACT, "1");
		assert.equal(snapshot(), before);
		// Each listener sees only its own session's request, naming that request's model.
		const modelOf = (m) => ({ id: m.id, provider: m.provider, contextWindow: m.contextWindow });
		const bySession = (x, y) => x[0].localeCompare(y[0]);
		assert.deepEqual(
			requests.map((r) => [r.sessionId, r.model]).sort(bySession),
			[[a.sessionId, modelOf(model)], [b.sessionId, modelOf(opus)]].sort(bySession),
		);
	});

	it("summary and AskClaude children carry their own purpose; a provider-only listener leaves them on the base env", { timeout: 20000 }, async () => {
		const requests = [];
		const s = await openSession({ listener: routingListener(requests), history: true });
		result = "Controlled summary";
		await s.session.compact();
		await __test.promptAndWait("ask", "none", new Map(), undefined, { piSessionId: s.sessionId, model: "opus", isolated: true, appendSkills: false });
		assert.ok(queries.length >= 2);
		assert.deepEqual([...new Set(requests.map((r) => r.purpose))].sort(), ["askclaude", "summary"]);
		for (const r of requests) assert.equal(r.sessionId, s.sessionId);
		for (const options of queries) assert.equal(options.env[ROUTE], undefined);
		assert.match(requests.find((r) => r.purpose === "askclaude").model.id, /opus/);
	});
});

describe("bridge session lifecycle and the child-env binding", () => {
	it("a session switch moves the binding to the new id, and session_shutdown removes it", () => {
		const handlers = {};
		const events = bus();
		// Its own activation; whether it registers the provider or defers to
		// session_start (modelRegistry already has it), the binding is the same.
		activate({ on: (name, h) => { (handlers[name] ??= []).push(h); }, events, registerProvider: () => {}, registerTool: () => {} });
		const emit = (name, event, id) => {
			const ctx = { cwd: process.cwd(), sessionManager: { getSessionId: () => id }, modelRegistry: { getProvider: () => ({}) } };
			for (const h of handlers[name] ?? []) h(event, ctx);
		};
		const seen = [];
		events.handlers.push((req) => seen.push(req.sessionId));
		const request = (id) => buildChildEnv({}, GUARDS, target(id));
		emit("session_start", { reason: "startup" }, "host-a");
		request("host-a");
		emit("session_start", { reason: "new" }, "host-b");
		request("host-a");
		request("host-b");
		emit("session_shutdown", {}, "host-b");
		request("host-b");
		assert.deepEqual(seen, ["host-a", "host-b"]);
		__test.resetSharedSession();
	});
});
