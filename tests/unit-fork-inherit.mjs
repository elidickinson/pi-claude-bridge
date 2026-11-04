// A forked or cloned pi session inherits its parent's bridge state when its
// prompt fingerprint matches (src/fork-inherit.ts), so its first sync forks the
// parent's CC session at a cut (row 6 or 7) instead of writing a new one (row 2).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";
import { stateFor } from "./lib/session-state.mjs";
import { inheritedState, inheritParentState, loadFingerprint, parentSessionId, pendingParents, promptFingerprint, rememberParentSession, saveFingerprint } from "../src/fork-inherit.js";

// Before the import: index.ts reads the flag once, and the rows are checked in its debug log.
process.env.CLAUDE_BRIDGE_DEBUG = "1";
const mod = await import("../src/index.js");
const { __test } = mod;
const handlers = {};
let provider;
mod.default({ on: (name, fn) => { (handlers[name] ??= []).push(fn); }, registerProvider: (_id, value) => { provider = value; }, registerTool: () => {} });

const user = (content) => ({ role: "user", content, timestamp: 1 });
const say = (text) => ({ role: "assistant", content: [{ type: "text", text }], provider: "claude-bridge", timestamp: 1 });
const history = [user("one"), say("a1"), user("two"), say("a2"), user("three"), say("a3")];
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];
const fingerprint = promptFingerprint("system prompt", tools);
const stateOf = (id) => __test.getSharedSession(id);
const setStateOf = (id, state) => __test.setSharedSession(id, state);

let root, cwd, logPath, logged;
const saved = {};
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "fork-inherit-"));
	cwd = join(root, "project");
	mkdirSync(cwd);
	for (const key of ["CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "CLAUDE_BRIDGE_DEBUG_PATH"]) saved[key] = process.env[key];
	process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.CLAUDE_BRIDGE_DEBUG_PATH = logPath = join(root, "bridge.log");
	__test.resetSharedSession();
	pendingParents.clear();
	logged = [];
});
afterEach(() => {
	__test.resetSharedSession();
	__test.setQuery(null);
	pendingParents.clear();
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

const log = (message) => logged.push(message);
const rows = () => existsSync(logPath) ? [...readFileSync(logPath, "utf8").matchAll(/syncResult: .* row=(\d)/g)].map((m) => Number(m[1])) : [];
function piSessionFile(name, header) {
	const path = join(root, `${name}.jsonl`);
	writeFileSync(path, `${typeof header === "string" ? header : JSON.stringify(header)}\n${JSON.stringify({ type: "message", id: "e1" })}\n`);
	return path;
}
function seedParent(messages = history) {
	const session = createSession({ projectPath: cwd, model: "sonnet" });
	const state = stateFor(session, messages, "sonnet");
	session.save();
	setStateOf("parent", state);
	saveFingerprint("parent", fingerprint);
	return { session, state, bytes: readFileSync(session.jsonlPath) };
}
function assertParentUnchanged({ session, state, bytes }) {
	const now = stateOf("parent");
	assert.strictEqual(now, state, "the parent's state object is still the registered one");
	assert.equal(now.ccSessionId, session.sessionId);
	assert.equal(now.dirtyTail, false);
	for (const key of ["digests", "uuids", "cuttable"]) assert.equal(now[key].length, history.length, key);
	assert.deepEqual(readFileSync(session.jsonlPath), bytes, "the parent's CC file is untouched");
}
function inheritAndSync(messages, childFingerprint = fingerprint) {
	pendingParents.set("child", "parent");
	inheritParentState("child", childFingerprint, stateOf, setStateOf, log);
	return __test.syncSharedSession(messages, cwd, undefined, "sonnet", "child");
}

describe("parentSessionId", () => {
	it("returns the id in the parent file's session header", () => {
		const parentSession = piSessionFile("parent", { type: "session", version: 3, id: "parent-id", timestamp: "t", cwd });
		assert.equal(parentSessionId({ type: "session", id: "child-id", timestamp: "t", cwd, parentSession }), "parent-id");
	});
	it("returns undefined without a usable parent header", () => {
		const header = (parentSession) => ({ type: "session", id: "child-id", timestamp: "t", cwd, parentSession });
		assert.equal(parentSessionId(undefined), undefined, "no header");
		assert.equal(parentSessionId(null), undefined, "null header");
		assert.equal(parentSessionId(header(undefined)), undefined, "no parentSession");
		assert.equal(parentSessionId(header(join(root, "missing.jsonl"))), undefined, "missing file");
		assert.equal(parentSessionId(header(piSessionFile("bad", "{not json"))), undefined, "invalid JSON");
		assert.equal(parentSessionId(header(piSessionFile("entry", { type: "message", id: "parent-id" }))), undefined, "not a session header");
		assert.equal(parentSessionId(header(piSessionFile("noid", { type: "session", id: "" }))), undefined, "empty id");
		assert.equal(parentSessionId(header(piSessionFile("self", { type: "session", id: "child-id" }))), undefined, "the child's own id");
		assert.equal(parentSessionId(header(root)), undefined, "a directory");
	});
});

describe("promptFingerprint", () => {
	it("is equal for equal inputs and changes with the prompt, a description or a schema", () => {
		const copy = JSON.parse(JSON.stringify(tools));
		assert.equal(promptFingerprint("system prompt", copy), fingerprint);
		assert.match(fingerprint, /^[0-9a-f]{64}$/);
		const changed = [
			promptFingerprint("system prompt.", tools),
			promptFingerprint(undefined, tools),
			promptFingerprint("system prompt", [{ ...tools[0], description: "Read a file." }]),
			promptFingerprint("system prompt", [{ ...tools[0], parameters: { type: "object", properties: { file: { type: "string" } } } }]),
			promptFingerprint("system prompt", [{ ...tools[0], name: "view" }]),
			promptFingerprint("system prompt", []),
			promptFingerprint("system prompt", [...tools, ...tools]),
		];
		assert.equal(new Set([fingerprint, ...changed]).size, changed.length + 1);
	});
});

describe("fingerprint store", () => {
	const fingerprintFile = () => {
		const dir = join(root, "agent", "claude-bridge", "fork-inherit");
		const files = readdirSync(dir).filter((name) => name.startsWith("f-"));
		assert.equal(files.length, 1, `one fingerprint file in ${dir}`);
		return join(dir, files[0]);
	};
	it("round-trips with a private file and skips rewriting an equal value", () => {
		assert.equal(loadFingerprint("s1"), undefined);
		saveFingerprint("s1", fingerprint);
		assert.equal(loadFingerprint("s1"), fingerprint);
		assert.equal(loadFingerprint("s2"), undefined);
		const path = fingerprintFile();
		assert.equal(statSync(path).mode & 0o777, 0o600);
		const inode = statSync(path).ino;
		saveFingerprint("s1", fingerprint);
		assert.equal(statSync(path).ino, inode, "an equal value is not rewritten");
		const other = promptFingerprint("other", []);
		saveFingerprint("s1", other);
		assert.notEqual(statSync(path).ino, inode);
		assert.equal(loadFingerprint("s1"), other);
	});
	for (const [name, contents] of [
		["invalid JSON", "{"],
		["a wrong version", JSON.stringify({ version: 2, fingerprint })],
		["a non-hex value", JSON.stringify({ version: 1, fingerprint: "x" })],
		["no object", "null"],
	]) it(`loads ${name} as undefined`, () => {
		saveFingerprint("s1", fingerprint);
		writeFileSync(fingerprintFile(), contents);
		assert.equal(loadFingerprint("s1"), undefined);
	});
});

describe("inheritance and sync", () => {
	it("a clone forks the parent's CC session at its last slot (row 6)", () => {
		const parent = seedParent();
		const synced = inheritAndSync([...history, user("next")]);
		assert.deepEqual(rows(), [6]);
		assert.equal(synced.sessionId, parent.state.ccSessionId);
		assert.notEqual(synced.targetSessionId, parent.state.ccSessionId);
		assert.equal(synced.created, true);
		assert.equal(synced.forkAt, parent.state.uuids.at(-1));
		assert.equal(parent.state.cuttable.at(-1), true);
		assertParentUnchanged(parent);
		assert.match(logged.join("\n"), /fork-inherit: child inherits CC session \w{8} from parent, 6 slots/);
		assert.equal(pendingParents.has("child"), false, "one attempt per session start");
		assert.equal(loadFingerprint("child"), fingerprint, "the child records its own fingerprint");
	});
	it("a fork at the third user message forks at the end of the shared prefix (row 6)", () => {
		const parent = seedParent();
		const synced = inheritAndSync([...history.slice(0, 4), user("three, rephrased")]);
		assert.deepEqual(rows(), [6]);
		assert.equal(synced.sessionId, parent.state.ccSessionId);
		assert.notEqual(synced.targetSessionId, parent.state.ccSessionId);
		assert.equal(synced.created, true);
		assert.equal(synced.forkAt, parent.state.uuids[3]);
		assertParentUnchanged(parent);
	});
	it("a fork with a different later message copies the shared prefix (row 7)", () => {
		const parent = seedParent();
		const synced = inheritAndSync([...history.slice(0, 4), user("other"), say("b3"), user("next")]);
		assert.deepEqual(rows(), [7]);
		assert.equal(synced.forkAt, undefined);
		assert.equal(synced.sessionId, synced.targetSessionId);
		assert.notEqual(synced.sessionId, parent.state.ccSessionId);
		const records = readFileSync(getSessionPath(synced.targetSessionId, cwd, process.env.CLAUDE_CONFIG_DIR), "utf8");
		assert.ok(records.includes(parent.state.uuids[3]), "the new session keeps the parent's record at the cut");
		assertParentUnchanged(parent);
	});
	it("the inherited copy shares no arrays with the parent", () => {
		const { state } = seedParent();
		const copy = inheritedState(state);
		assert.equal(copy.dirtyTail, true);
		assert.equal(copy.ccSessionId, state.ccSessionId);
		for (const key of ["digests", "uuids", "cuttable"]) {
			assert.deepEqual(copy[key], state[key]);
			assert.notStrictEqual(copy[key], state[key]);
		}
	});
	it("a child with its own state keeps it", () => {
		seedParent();
		const own = stateFor(createSession({ projectPath: cwd }), [user("mine")], "sonnet");
		setStateOf("child", own);
		pendingParents.set("child", "parent");
		inheritParentState("child", fingerprint, stateOf, setStateOf, log);
		assert.strictEqual(stateOf("child"), own);
		assert.match(logged.join("\n"), /not inherited from parent: child has state/);
	});
	for (const [name, setup, childFingerprint, reason] of [
		["the parent has no state", () => saveFingerprint("parent", fingerprint), fingerprint, "parent has no state"],
		["the prompt differs", () => seedParent(), promptFingerprint("subagent prompt", tools), "prompt differs"],
		["the parent has no fingerprint", () => {
			const session = createSession({ projectPath: cwd, model: "sonnet" });
			setStateOf("parent", stateFor(session, history, "sonnet"));
			session.save();
		}, fingerprint, "parent has no prompt fingerprint"],
	]) it(`nothing is inherited when ${name} (row 2)`, () => {
		setup();
		inheritAndSync([...history, user("next")], childFingerprint);
		assert.deepEqual(rows(), [2]);
		assert.notEqual(stateOf("child")?.ccSessionId, stateOf("parent")?.ccSessionId ?? "none");
		assert.match(logged.join("\n"), new RegExp(`fork-inherit: child not inherited from parent: ${reason}`));
	});
	it("a session without a pending parent only records its fingerprint", () => {
		seedParent();
		inheritParentState("child", fingerprint, stateOf, setStateOf, log);
		assert.equal(stateOf("child"), null);
		assert.deepEqual(logged, []);
		assert.equal(loadFingerprint("child"), fingerprint);
	});
	it("rememberParentSession records the header's parent, never the child itself", () => {
		const parentSession = piSessionFile("parent", { type: "session", id: "parent" });
		rememberParentSession("child", { type: "session", id: "child", timestamp: "t", cwd, parentSession }, log);
		assert.equal(pendingParents.get("child"), "parent");
		rememberParentSession("parent", { type: "session", id: "other", timestamp: "t", cwd, parentSession }, log);
		assert.equal(pendingParents.has("parent"), false);
		rememberParentSession("solo", undefined, log);
		assert.equal(pendingParents.has("solo"), false);
	});
});

// The hooks in index.ts, driven through the registered session_start handler
// and provider, with a scripted SDK that appends CC's records like the CLI.
describe("hooks in session_start and the provider", () => {
	const model = () => provider.models.find((m) => m.id.includes("haiku")) ?? provider.models[0];
	let launches;
	beforeEach(() => {
		launches = [];
		__test.setQuery(({ prompt, options }) => {
			launches.push(options);
			const sessionId = options.sessionId ?? options.resume;
			const path = getSessionPath(sessionId, options.cwd, process.env.CLAUDE_CONFIG_DIR);
			let parentUuid = null;
			const record = (role, content, uuid) => {
				const builder = createSession({ projectPath: options.cwd, sessionId });
				if (role === "assistant") builder.addAssistantMessage(content);
				else builder.addUserMessage(content);
				const value = { ...builder.records[0], ...(uuid ? { uuid } : {}), parentUuid };
				parentUuid = value.uuid;
				mkdirSync(dirname(path), { recursive: true });
				appendFileSync(path, JSON.stringify(value) + "\n");
				return value;
			};
			const gen = (async function* () {
				const input = prompt[Symbol.asyncIterator]();
				const initial = (await input.next()).value;
				void input.next().catch(() => {});
				record("user", initial.message.content, initial.uuid);
				yield { type: "system", subtype: "init", session_id: sessionId };
				yield { type: "user", isReplay: true, parent_tool_use_id: null, uuid: initial.uuid, session_id: sessionId, message: initial.message };
				const content = [{ type: "text", text: "answer" }];
				const value = record("assistant", content);
				yield { type: "assistant", parent_tool_use_id: null, uuid: value.uuid, session_id: sessionId, message: { id: `msg_${launches.length}`, model: model().id, content } };
				yield { type: "result", subtype: "success", is_error: false, result: "answer", session_id: sessionId };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
	});
	const start = (id, header, reason = "fork") => {
		for (const fn of handlers.session_start) fn({ type: "session_start", reason }, { cwd, sessionManager: { getSessionId: () => id, getHeader: () => header } });
	};
	async function turn(id, messages, turnTools = tools) {
		const output = await provider.streamSimple(model(), { messages, tools: turnTools }, { sessionId: id }).result();
		assert.equal(output.stopReason, "stop", output.errorMessage);
		return output;
	}
	async function parentWithTwoTurns() {
		start("hook-parent", { type: "session", id: "hook-parent", timestamp: "t", cwd }, "startup");
		const first = [user("one")];
		const second = [...first, await turn("hook-parent", first), user("two")];
		const parentHistory = [...second, await turn("hook-parent", second)];
		const state = stateOf("hook-parent");
		assert.equal(state.dirtyTail, false);
		const ccPath = getSessionPath(state.ccSessionId, state.cwd, process.env.CLAUDE_CONFIG_DIR);
		return { state, parentHistory, ccPath, bytes: readFileSync(ccPath), parentSession: piSessionFile("hook-parent", { type: "session", id: "hook-parent", timestamp: "t", cwd }) };
	}

	it("a clone's first query forks the parent's CC session", { timeout: 30_000 }, async () => {
		const parent = await parentWithTwoTurns();
		start("hook-child", { type: "session", id: "hook-child", timestamp: "t", cwd, parentSession: parent.parentSession });
		await turn("hook-child", [...parent.parentHistory, user("three")]);
		const launch = launches.at(-1);
		assert.equal(launch.resume, parent.state.ccSessionId);
		assert.equal(launch.forkSession, true);
		assert.equal(launch.resumeSessionAt, parent.state.uuids.at(-1));
		assert.notEqual(launch.sessionId, parent.state.ccSessionId);
		assert.strictEqual(stateOf("hook-parent"), parent.state);
		assert.deepEqual(readFileSync(parent.ccPath), parent.bytes);
		const text = readFileSync(logPath, "utf8");
		assert.match(text, /fork-inherit: hook-child inherits CC session \w{8} from hook-parent, 4 slots/);
		assert.deepEqual(rows().slice(-1), [6]);
	});
	it("a child with different tools writes its own session", { timeout: 30_000 }, async () => {
		const parent = await parentWithTwoTurns();
		start("hook-subagent", { type: "session", id: "hook-subagent", timestamp: "t", cwd, parentSession: parent.parentSession }, "startup");
		await turn("hook-subagent", [...parent.parentHistory, user("three")], [{ ...tools[0], description: "Subagent read" }]);
		const launch = launches.at(-1);
		assert.notEqual(launch.resume, parent.state.ccSessionId);
		assert.equal(launch.forkSession, undefined);
		assert.match(readFileSync(logPath, "utf8"), /fork-inherit: hook-subagent not inherited from hook-parent: prompt differs/);
		assert.deepEqual(rows().slice(-1), [2]);
		assert.deepEqual(readFileSync(parent.ccPath), parent.bytes);
	});
	it("hook failures leave session_start and the turn working", { timeout: 30_000 }, async () => {
		for (const fn of handlers.session_start) fn({ type: "session_start", reason: "fork" }, { cwd, sessionManager: { getSessionId: () => "hook-broken", getHeader: () => { throw new Error("no header"); } } });
		mkdirSync(join(root, "agent", "claude-bridge"), { recursive: true });
		writeFileSync(join(root, "agent", "claude-bridge", "fork-inherit"), "not a directory");
		await turn("hook-broken", [user("one")]);
		const text = readFileSync(logPath, "utf8");
		assert.match(text, /fork-inherit: session_start skipped: no header/);
		assert.match(text, /fork-inherit: hook-broken skipped: /);
	});
});
