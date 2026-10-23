// Script only the external SDK; use real child exits and cc-session-io files.
import { it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";
import { digestMessages } from "../src/message-digests.js";
import { loadSessionState, saveSessionState } from "../src/session-store.js";
import { diagLogPath } from "../src/log-paths.js";
const root = mkdtempSync(join(tmpdir(), "query-lifecycle-"));
process.env.CLAUDE_CONFIG_DIR = root;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const mod = await import("../src/index.js");
const { __test } = mod;
let provider;
const handlers = {};
mod.default({ on: (name, fn) => { (handlers[name] ??= []).push(fn); }, registerProvider: (_id, value) => { provider = value; }, registerTool: () => {} });
const model = provider.models[0];
const tools = [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }];
const user = (content) => ({ role: "user", content, timestamp: 1 });
const toolResult = { role: "toolResult", toolCallId: "X", content: [{ type: "text", text: "file" }], timestamp: 1 };
const call = (messages, signal, sessionId = "pi", callModel = model) => provider.streamSimple(callModel, { messages, tools }, { sessionId, signal });
const say = (text) => ({ role: "assistant", content: [{ type: "text", text }], provider: model.provider, timestamp: 1 });
const sessionsDir = () => join(process.env.PI_CODING_AGENT_DIR, "claude-bridge", "sessions");
const persisted = (id = "pi") => loadSessionState(id, assert.fail);
const stored = (state) => ({ ...state, dirtyTail: true });
const tick = () => new Promise(setImmediate);
let scripts, calls;

beforeEach(() => {
	__test.resetSharedSession();
	__test.activeQueryContexts.clear();
	scripts = [];
	calls = [];
	__test.setQuery(fakeQuery);
});
function fakeQuery({ options, prompt }) {
	const script = scripts.shift();
	assert.ok(script, "queued external SDK script");
	const id = options.sessionId ?? options.resume;
	const path = getSessionPath(id, options.cwd, root);
	let parent = null;
	if (options.forkSession) {
		const source = readFileSync(getSessionPath(options.resume, options.cwd, root), "utf8").trim().split("\n").map(JSON.parse);
		const cut = source.findIndex((r) => r.uuid === options.resumeSessionAt);
		assert.ok(cut >= 0);
		const kept = source.slice(0, cut + 1).map((r) => ({ ...r, sessionId: id }));
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, kept.map((r) => JSON.stringify(r) + "\n").join(""));
	}
	if (existsSync(path)) parent = readFileSync(path, "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.uuid).at(-1)?.uuid;
	// A deferred record reaches the file only when the child handles SIGTERM.
	const pending = `${path}.pending`;
	const record = (role, content, uuid, deferred = false) => {
		const builder = createSession({ projectPath: options.cwd, sessionId: id });
		if (role === "assistant") builder.addAssistantMessage(content);
		else builder.addUserMessage(content);
		const value = { ...builder.records[0], ...(uuid ? { uuid } : {}), parentUuid: parent };
		parent = value.uuid;
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(deferred ? pending : path, JSON.stringify(value) + "\n");
		return value;
	};
	const childCode = `const fs=require('fs'),crypto=require('crypto'); process.on('SIGTERM',()=>{if(${Boolean(script.hang)})return;setTimeout(()=>{const q=${JSON.stringify(pending)};if(fs.existsSync(q)){fs.appendFileSync(${JSON.stringify(path)},fs.readFileSync(q));fs.unlinkSync(q);}if(${Boolean(script.late)}){const p=${JSON.stringify(path)};const r=fs.readFileSync(p,'utf8').trim().split('\\n').map(JSON.parse).filter(r=>r.uuid).at(-1);fs.appendFileSync(p,JSON.stringify({type:'attachment',uuid:crypto.randomUUID(),parentUuid:r.uuid,sessionId:${JSON.stringify(id)},attachment:{type:'interrupted',text:'late-exit-marker'}})+'\\n');}process.exit(0)},${script.late ? 60 : 0})});process.stdout.write('READY\\n');setInterval(()=>{},1000);`;
	const child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", childCode], cwd: root, env: process.env, signal: new AbortController().signal });
	const ready = once(child.stdout, "data");
	const exited = once(child, "close");
	let release, stopped = false;
	const parked = new Promise((r) => { release = r; });
	const entry = { options, path, exited, child };
	calls.push(entry);
	const gen = (async function* () {
		await ready;
		const input = typeof prompt === "string" ? null : prompt[Symbol.asyncIterator]();
		const initial = input ? (await input.next()).value : { message: { content: prompt } };
		if (input) void input.next().catch(() => {});
		entry.pulled = true;
		// CC pulled the prompt from stdin, then dies booting: no record, no replay.
		if (script.boot) { await parked; return; }
		record("user", initial.message.content, initial.uuid);
		if (!script.preInit) yield { type: "system", subtype: "init", session_id: id };
		if (!script.preInit && input) yield { type: "user", isReplay: true, parent_tool_use_id: null, uuid: initial.uuid, session_id: id, message: initial.message };
		if (script.tool) {
			const value = record("assistant", [{ type: "tool_use", id: "X", name: "mcp__custom-tools__read", input: {} }], undefined, script.deferTool);
			yield { type: "assistant", parent_tool_use_id: null, uuid: value.uuid, message: { id: "tool-api", model: model.id, content: value.message.content } };
			await parked;
			if (stopped) return;
		}
		if (!script.error) {
			const value = record("assistant", [{ type: "text", text: "answer" }]);
			yield { type: "assistant", parent_tool_use_id: null, uuid: value.uuid, message: { id: `answer-${id}`, model: model.id, content: value.message.content } };
		}
		yield { type: "result", subtype: "success", is_error: Boolean(script.error), result: script.error ?? "answer", session_id: id };
	})();
	gen.interrupt = async () => {};
	gen.close = () => { stopped = true; release(); if (!child.killed) child.kill("SIGTERM"); };
	return gen;
}
afterEach(async () => {
	__test.setQuery(null);
	for (const call of calls) if (call.child.exitCode === null && call.child.signalCode === null) call.child.kill("SIGKILL");
	await Promise.all(calls.map((c) => c.exited));
	await tick();
});

it("quota retries delete each new file only after the child finishes its late writes", async () => {
	const prior = [user("prior"), { role: "assistant", content: [{ type: "text", text: "prior answer" }], provider: model.provider, timestamp: 1 }];
	for (let i = 0; i < 3; i++) {
		scripts.push({ error: "API Error: quota exceeded", late: true });
		const output = await call([...prior, user("retry")]).result();
		assert.equal(output.stopReason, "error");
		const current = calls.at(-1);
		assert.ok(existsSync(current.path), "iterator settlement must not delete a live child's file");
		assert.equal(__test.getSharedSession("pi"), null);
		assert.equal(persisted(), null, "a no-progress failure persists nothing");
		await current.exited;
		await tick();
		assert.equal(existsSync(current.path), false, "cleanup follows actual exit, including late writes");
	}
});

it("a no-progress fork failing before init deletes only its pre-minted target", async () => {
	const ask = user("warm");
	scripts.push({});
	const answer = await call([ask]).result();
	const prior = __test.getSharedSession("pi");
	const ancestor = getSessionPath(prior.ccSessionId, prior.cwd, root);
	await calls[0].exited;
	const before = readFileSync(ancestor);
	__test.markRebuildForSession("pi", "test");
	scripts.push({ preInit: true, error: "API Error: quota exceeded", late: true });
	await call([ask, answer, user("retry")]).result();
	const failed = calls.at(-1);
	assert.equal(failed.options.forkSession, true);
	assert.ok(failed.options.sessionId);
	assert.notEqual(failed.options.sessionId, prior.ccSessionId);
	assert.ok(existsSync(failed.path));
	assert.equal(__test.getSharedSession("pi").ccSessionId, prior.ccSessionId);
	await failed.exited;
	await tick();
	assert.equal(existsSync(failed.path), false);
	assert.deepEqual(readFileSync(ancestor), before);
});

it("abort commits contiguous tool progress synchronously and waits for exit before prefix-writing its source", async () => {
	const ask = user("tool"), controller = new AbortController();
	scripts.push({ tool: true, late: true });
	const tool = await call([ask], controller.signal).result();
	controller.abort();
	const captured = __test.getSharedSession("pi");
	assert.ok(captured, "onAbort synchronously publishes complete progress");
	assert.equal(captured.dirtyTail, true);
	assert.deepEqual(captured.digests, digestMessages([ask, tool]));
	assert.equal(persisted(), null, "the pointer is saved only after the child exits");
	scripts.push({});
	const next = call([ask, tool, toolResult, user("continue")]);
	await tick();
	assert.equal(calls.length, 1, "source may not be read or forked before the killed child exits");
	await next.result();
	assert.equal(calls.length, 2);
	assert.notEqual(calls[1].options.resume, captured.ccSessionId);
	assert.match(readFileSync(calls[0].path, "utf8"), /late-exit-marker/);
	assert.doesNotMatch(readFileSync(calls[1].path, "utf8"), /late-exit-marker/);
	assert.equal(calls[1].options.sessionId, undefined, "a prefix write resumes its own written id");
	assert.equal(__test.getSharedSession("pi").ccSessionId, calls[1].options.resume);
});

it("abort publishes memory at once but saves the pointer only after exit lands its deferred record", async () => {
	const ask = user("tool"), controller = new AbortController();
	scripts.push({ tool: true, late: true, deferTool: true });
	const tool = await call([ask], controller.signal).result();
	controller.abort();
	const captured = __test.getSharedSession("pi");
	assert.deepEqual(captured.digests, digestMessages([ask, tool]));
	const toolUuid = new RegExp(captured.uuids[1]);
	await tick();
	assert.doesNotMatch(readFileSync(calls[0].path, "utf8"), toolUuid, "the replayed record is not on disk yet");
	assert.equal(persisted(), null, "no pointer names an unflushed uuid");
	await calls[0].exited;
	await tick();
	assert.match(readFileSync(calls[0].path, "utf8"), toolUuid);
	assert.deepEqual(persisted(), stored(captured));
});

it("a reloaded module shares state and stopping writers, and the old finalizer never overwrites its replacement", { timeout: 5000 }, async () => {
	const ask = user("tool"), controller = new AbortController();
	scripts.push({ tool: true, hang: true });
	const tool = await call([ask], controller.signal).result();
	controller.abort();
	const committed = __test.getSharedSession("pi");
	for (const fn of handlers.session_shutdown) fn({}, { sessionManager: { getSessionId: () => "pi" } });
	const fresh = await import(`../src/index.js?reload=${Date.now()}`);
	let freshProvider;
	fresh.default({ on() {}, registerProvider: (_id, value) => { freshProvider = value; }, registerTool() {} });
	fresh.__test.setQuery(fakeQuery);
	assert.strictEqual(fresh.__test.getSharedSession("pi"), committed, "the newer memory state, not the empty disk");
	const waiting = new AbortController();
	const next = freshProvider.streamSimple(model, { messages: [ask, tool, toolResult, user("next")], tools }, { sessionId: "pi", signal: waiting.signal });
	await tick();
	assert.equal(calls.length, 1, "the fresh instance waits on the old instance's stopping child");
	waiting.abort();
	assert.equal((await next.result()).stopReason, "aborted");
	const replacement = { digests: [], uuids: [], cuttable: [], ccSessionId: "cc-replacement", cwd: root, model: "replacement-model", dirtyTail: false };
	fresh.__test.setSharedSession("pi", replacement);
	saveSessionState("pi", replacement);
	calls[0].child.kill("SIGKILL");
	await calls[0].exited;
	await tick();
	assert.strictEqual(__test.getSharedSession("pi"), replacement);
	assert.deepEqual(persisted(), stored(replacement));
});

it("a fresh same-session query discards a parked query and retains its progress under CAS", async () => {
	const ask = user("tool");
	scripts.push({ tool: true, late: true });
	const tool = await call([ask]).result();
	const parked = [...__test.activeQueryContexts][0];
	scripts.push({});
	const next = call([ask, tool, user("fresh")]);
	assert.equal(parked.discarded, true);
	assert.equal(__test.getSharedSession("pi").dirtyTail, true);
	assert.deepEqual(__test.getSharedSession("pi").digests, digestMessages([ask, tool]));
	await next.result();
	assert.equal(__test.getSharedSession("pi").ccSessionId, calls[1].options.resume);
});


it("a synthetic durable-host continuation is grouped with its next assistant, not fabricated as a pi slot", async () => {
	const ask = user("tool"), controller = new AbortController();
	scripts.push({ tool: true });
	const tool = await call([ask], controller.signal).result();
	controller.abort();
	scripts.push({});
	const answer = await call([ask, tool, toolResult]).result();
	const state = __test.getSharedSession("pi");
	assert.deepEqual(state.digests, digestMessages([ask, tool, toolResult, answer]));
	const { readTranscript, resolveRecordingCut } = await import("../src/session-transcript.js");
	const records = readTranscript(state);
	const resultCut = resolveRecordingCut(records, state, 3);
	assert.doesNotMatch(JSON.stringify(records.slice(0, resultCut.index + 1)), /Your session was interrupted and resumed/);
	assert.match(JSON.stringify(records.slice(resultCut.index + 1)), /Your session was interrupted and resumed/);
	assert.equal(resolveRecordingCut(records, state, 4).uuid, state.uuids[3]);
});

it("AskClaude forks the same model and imports a changed model without writing provider state", async () => {
	const ask = user("warm");
	scripts.push({});
	const answer = await call([ask]).result();
	const state = __test.getSharedSession("pi");
	const storedBefore = persisted();
	await calls[0].exited;
	const before = readFileSync(calls[0].path);
	scripts.push({});
	await __test.promptAndWait("delegated", "none", new Map(), undefined, { model: model.id, appendSkills: false, context: [ask, answer], piSessionId: "pi" });
	assert.equal(calls[1].options.forkSession, true);
	assert.equal(calls[1].options.resume, state.ccSessionId);
	assert.notEqual(calls[1].options.sessionId, state.ccSessionId);
	assert.strictEqual(__test.getSharedSession("pi"), state);
	scripts.push({});
	await __test.promptAndWait("other model", "none", new Map(), undefined, { model: "other-model", appendSkills: false, context: [ask, answer], piSessionId: "pi" });
	assert.equal(calls[2].options.forkSession, undefined);
	assert.notEqual(calls[2].options.resume, state.ccSessionId);
	assert.strictEqual(__test.getSharedSession("pi"), state);
	assert.deepEqual(readFileSync(calls[0].path), before);
	assert.deepEqual(persisted(), storedBefore, "AskClaude never writes the provider's persisted state");
	scripts.push({});
	await __test.promptAndWait("no state", "none", new Map(), undefined, { model: model.id, appendSkills: false, context: [ask, answer], piSessionId: "pi-ask" });
	assert.equal(calls[3].options.sessionId, undefined, "an imported session resumes its own written id");
	assert.ok(calls[3].options.resume);
	assert.equal(persisted("pi-ask"), null);
});

it("a restart reloads the persisted pointer dirty and forks at its last valid cut", async () => {
	const ask = user("warm");
	scripts.push({});
	const answer = await call([ask]).result();
	const saved = __test.getSharedSession("pi");
	await calls[0].exited;
	__test.forgetSessionMemory();
	const loaded = __test.getSharedSession("pi");
	assert.notStrictEqual(loaded, saved);
	assert.deepEqual(loaded, { ...saved, dirtyTail: true });
	scripts.push({});
	await call([ask, answer, user("next")]).result();
	assert.equal(calls[1].options.forkSession, true);
	assert.equal(calls[1].options.resume, saved.ccSessionId);
	assert.equal(calls[1].options.resumeSessionAt, saved.uuids.at(-1));
	assert.equal(persisted().ccSessionId, calls[1].options.sessionId);
	assert.equal(__test.getSharedSession("pi").dirtyTail, false);
});

it("a restart on another model imports pi's history instead of reusing the pointer", async () => {
	const other = provider.models.find((m) => m.id !== model.id);
	const ask = user("warm");
	scripts.push({});
	const answer = await call([ask]).result();
	const saved = persisted();
	await calls[0].exited;
	__test.forgetSessionMemory();
	scripts.push({});
	await call([ask, answer, user("next")], undefined, "pi", other).result();
	assert.equal(calls[1].options.forkSession, undefined);
	assert.equal(calls[1].options.sessionId, undefined);
	assert.notEqual(calls[1].options.resume, saved.ccSessionId);
	assert.equal(persisted().ccSessionId, calls[1].options.resume);
});

it("a restart whose transcript is gone drops the persisted pointer and imports", async () => {
	const ask = user("warm");
	scripts.push({});
	const answer = await call([ask]).result();
	await calls[0].exited;
	rmSync(calls[0].path);
	__test.forgetSessionMemory();
	scripts.push({ error: "API Error: quota exceeded" });
	assert.equal((await call([ask, answer, user("next")]).result()).stopReason, "error");
	assert.equal(calls[1].options.forkSession, undefined);
	assert.ok(calls[1].options.resume, "pi's priors are written to a new session");
	assert.equal(persisted(), null, "the missing transcript's pointer is deleted, not retained");
	await calls[1].exited;
});

it("an invalid persisted file is rejected, logged, and treated as no state", async () => {
	const ask = user("warm");
	scripts.push({});
	const answer = await call([ask]).result();
	await calls[0].exited;
	const [file] = readdirSync(sessionsDir());
	writeFileSync(join(sessionsDir(), file), JSON.stringify({ ...JSON.parse(readFileSync(join(sessionsDir(), file), "utf8")), version: 2 }));
	__test.forgetSessionMemory();
	assert.equal(__test.getSharedSession("pi"), null);
	assert.match(readFileSync(diagLogPath(), "utf8"), /session_state_rejected.*unsupported version/);
	scripts.push({});
	await call([ask, answer, user("next")]).result();
	assert.equal(calls[1].options.forkSession, undefined);
	assert.equal(persisted().ccSessionId, calls[1].options.resume);
});

it("an intentional null-uuid omission survives a restart", async () => {
	const history = [user("a"), { role: "assistant", content: [], provider: model.provider, timestamp: 1 }, user("b")];
	scripts.push({});
	await call(history).result();
	const saved = __test.getSharedSession("pi");
	assert.equal(saved.uuids[1], null);
	__test.forgetSessionMemory();
	assert.deepEqual(__test.getSharedSession("pi"), { ...saved, dirtyTail: true });
});

it("a stale completion's CAS never overwrites the persisted replacement", async () => {
	const controller = new AbortController();
	scripts.push({ tool: true });
	await call([user("tool")], controller.signal).result();
	const replacement = { digests: [], uuids: [], cuttable: [], ccSessionId: "cc-replacement", cwd: root, model: "replacement-model", dirtyTail: false };
	__test.setSharedSession("pi", replacement);
	saveSessionState("pi", replacement);
	controller.abort();
	await calls[0].exited;
	await tick();
	assert.strictEqual(__test.getSharedSession("pi"), replacement);
	assert.deepEqual(persisted(), stored(replacement));
});

it("an unattributed query never writes provider state", async () => {
	scripts.push({});
	await provider.streamSimple(model, { messages: [user("a"), say("b"), user("c")], tools }, {}).result();
	await calls[0].exited;
	assert.deepEqual(existsSync(sessionsDir()) ? readdirSync(sessionsDir()) : [], []);
});

it("switching pi sessions retains every other session's state", async () => {
	scripts.push({});
	await call([user("warm")]).result();
	const saved = __test.getSharedSession("pi");
	for (const reason of ["new", "resume", "fork"]) {
		for (const fn of handlers.session_start) fn({ reason }, { cwd: process.cwd(), sessionManager: { getSessionId: () => `other-${reason}` } });
	}
	assert.strictEqual(__test.getSharedSession("pi"), saved);
	assert.deepEqual(persisted(), stored(saved));
});

it("a prompt CC pulled but never replayed stays a gap, so a boot abort persists no absent anchor", async () => {
	const ask = user("warm");
	scripts.push({});
	const answer = await call([ask]).result();
	const saved = __test.getSharedSession("pi");
	await calls[0].exited;
	const controller = new AbortController(), booting = user("booting");
	scripts.push({ boot: true });
	const aborted = call([ask, answer, booting], controller.signal);
	while (!calls[1]?.pulled) await tick();
	assert.equal(calls[1].options.resume, saved.ccSessionId, "a plain resume appends to the saved file");
	controller.abort();
	assert.equal((await aborted.result()).stopReason, "aborted");
	assert.deepEqual(persisted(), stored(saved), "only the old valid prefix is retained");
	const placeholder = { role: "assistant", content: [{ type: "text", text: "" }], provider: model.provider, stopReason: "aborted", timestamp: 1 };
	scripts.push({});
	assert.equal((await call([ask, answer, booting, placeholder, user("again")]).result()).stopReason, "stop");
	assert.equal(calls[2].options.forkSession, undefined);
	assert.notEqual(calls[2].options.resume, saved.ccSessionId, "the unpersisted prompt is rewritten after the old cut");
	const state = __test.getSharedSession("pi");
	const records = readFileSync(getSessionPath(state.ccSessionId, state.cwd, root), "utf8");
	for (const uuid of state.uuids) if (uuid) assert.match(records, new RegExp(uuid));
});

it("a healthy parked provider query does not block a readonly AskClaude fork", { timeout: 5000 }, async () => {
	const ask = user("warm");
	scripts.push({});
	const answer = await call([ask]).result();
	const saved = __test.getSharedSession("pi");
	await calls[0].exited;
	scripts.push({ tool: true });
	await call([ask, answer, user("tool")]).result();
	assert.equal(calls[1].options.resume, saved.ccSessionId, "the parked query appends to the saved file");
	const [parked] = __test.activeQueryContexts;
	scripts.push({});
	const reply = await __test.promptAndWait("delegated", "none", new Map(), undefined, { model: model.id, appendSkills: false, context: [ask, answer], piSessionId: "pi" });
	assert.equal(reply.responseText, "answer");
	assert.equal(calls[2].options.forkSession, true);
	assert.equal(calls[2].options.resume, saved.ccSessionId);
	assert.equal(calls[2].options.resumeSessionAt, saved.uuids.at(-1));
	assert.equal(parked.discarded, false);
	assert.ok(__test.activeQueryContexts.has(parked));
	assert.equal(calls[1].child.exitCode, null, "the parked child keeps running");
	assert.strictEqual(__test.getSharedSession("pi"), saved);
});

it("an abort cancels a fresh query's wait on a stopping writer", { timeout: 5000 }, async () => {
	const controller = new AbortController(), ask = user("tool");
	scripts.push({ tool: true, hang: true });
	const tool = await call([ask], controller.signal).result();
	controller.abort();
	const state = __test.getSharedSession("pi");
	assert.equal(state.ccSessionId, calls[0].options.sessionId);
	const next = new AbortController();
	const waiting = call([ask, tool, toolResult, user("next")], next.signal);
	await tick();
	next.abort();
	assert.equal((await waiting.result()).stopReason, "aborted");
	assert.equal(calls.length, 1, "nothing launched while the old child is still stopping");
	assert.deepEqual(__test.getSharedSession("pi"), state);
	calls[0].child.kill("SIGKILL");
	await calls[0].exited;
});

it("a failed state save ends the turn with that error and is fatal, never retried as a query failure", async () => {
	// The surfaced rejection must kill the process, so the scenario runs in a child.
	const script = `
		import { createHash } from "node:crypto";
		import { mkdirSync } from "node:fs";
		import { join } from "node:path";
		const mod = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});
		let provider;
		mod.default({ on() {}, registerProvider: (_id, value) => { provider = value; }, registerTool() {} });
		const model = provider.models[0];
		mod.__test.getSharedSession("pi");
		const file = "s-" + createHash("sha256").update("pi", "utf16le").digest("hex") + ".json";
		mkdirSync(join(process.env.PI_CODING_AGENT_DIR, "claude-bridge", "sessions", file, "occupied"), { recursive: true });
		mod.__test.setQuery(({ prompt, options }) => {
			const gen = (async function* () {
				const initial = (await prompt[Symbol.asyncIterator]().next()).value;
				yield { type: "system", subtype: "init", session_id: options.sessionId };
				yield { type: "user", isReplay: true, parent_tool_use_id: null, uuid: initial.uuid, message: initial.message };
				yield { type: "assistant", parent_tool_use_id: null, uuid: "answer-uuid", message: { id: "answer", model: model.id, content: [{ type: "text", text: "answer" }] } };
				yield { type: "result", subtype: "success", is_error: false, result: "answer", session_id: options.sessionId };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
		const output = await provider.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] }, { sessionId: "pi" }).result();
		console.log(JSON.stringify({ stopReason: output.stopReason, errorMessage: output.errorMessage }));
		setTimeout(() => console.log("survived"), 200);
	`;
	const child = spawn(process.execPath, ["--import", "tsx", "--import", "./tests/lib/setup.mjs", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "";
	child.stdout.on("data", (d) => { stdout += d; });
	child.stderr.on("data", (d) => { stderr += d; });
	const [code] = await once(child, "close");
	const lines = stdout.trim().split("\n");
	assert.deepEqual(JSON.parse(lines[0]).stopReason, "error", stdout + stderr);
	assert.match(JSON.parse(lines[0]).errorMessage, /EISDIR/);
	assert.notEqual(code, 0, "the failed save is not swallowed");
	assert.ok(!lines.includes("survived"));
	assert.match(stderr, /EISDIR/);
});

it("an unexpected session id ends the turn, commits nothing, and is fatal", async () => {
	const script = `
		import { createHash } from "node:crypto";
		import { existsSync } from "node:fs";
		import { join } from "node:path";
		const mod = await import(${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)});
		let provider;
		mod.default({ on() {}, registerProvider: (_id, value) => { provider = value; }, registerTool() {} });
		const model = provider.models[0];
		const file = join(process.env.PI_CODING_AGENT_DIR, "claude-bridge", "sessions", "s-" + createHash("sha256").update("pi", "utf16le").digest("hex") + ".json");
		mod.__test.setQuery(({ prompt }) => {
			const gen = (async function* () {
				const initial = (await prompt[Symbol.asyncIterator]().next()).value;
				yield { type: "system", subtype: "init", session_id: "wrong-session" };
				yield { type: "user", isReplay: true, parent_tool_use_id: null, uuid: initial.uuid, message: initial.message };
				yield { type: "assistant", parent_tool_use_id: null, uuid: "answer-uuid", message: { id: "answer", model: model.id, content: [{ type: "text", text: "answer" }] } };
				yield { type: "result", subtype: "success", is_error: false, result: "answer", session_id: "wrong-session" };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
		const output = await provider.streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 1 }], tools: [] }, { sessionId: "pi" }).result();
		console.log(JSON.stringify({ stopReason: output.stopReason, errorMessage: output.errorMessage, state: mod.__test.getSharedSession("pi"), saved: existsSync(file) }));
		setTimeout(() => console.log("survived"), 200);
	`;
	const child = spawn(process.execPath, ["--import", "tsx", "--import", "./tests/lib/setup.mjs", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "";
	child.stdout.on("data", (d) => { stdout += d; });
	child.stderr.on("data", (d) => { stderr += d; });
	const [code] = await once(child, "close");
	const lines = stdout.trim().split("\n");
	const result = JSON.parse(lines[0]);
	assert.equal(result.stopReason, "error", stdout + stderr);
	assert.match(result.errorMessage, /unexpected session wrong-session/);
	assert.equal(result.state, null, "no state under the wrong target");
	assert.equal(result.saved, false);
	assert.notEqual(code, 0, "the protocol violation is not swallowed");
	assert.ok(!lines.includes("survived"));
	assert.match(stderr, /unexpected session wrong-session/);
});
