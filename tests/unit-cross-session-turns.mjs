// Behavioral provider sequences with a scripted external SDK and real transcripts.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createSession, getSessionPath } from "cc-session-io";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { digestMessages } from "../src/message-digests.js";
import { copyRecording } from "../src/session-sync.js";

const root = mkdtempSync(join(tmpdir(), "cross-session-"));
process.env.CLAUDE_CONFIG_DIR = root;
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const mod = await import("../src/index.js");
const { __test } = mod;
const { setQuery, getSharedSession, resetSharedSession } = __test;
let providerConfig;
mod.default({ on: () => {}, registerProvider: (_name, config) => { providerConfig = config; }, registerTool: () => {} });
const model = providerConfig.models[0];
const user = (content) => ({ role: "user", content, timestamp: 1 });
const result = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 1 });
const tools = [{ name: "read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }, { name: "edit", description: "edit", parameters: { type: "object", properties: {} } }];
const call = (sid, messages) => providerConfig.streamSimple(model, { messages, tools }, { sessionId: sid });
const gate = () => { let open; const wait = new Promise((r) => { open = r; }); return { wait, open }; };
const settle = () => new Promise((r) => setTimeout(r, 20));
let scripts, calls;

beforeEach(() => {
	resetSharedSession();
	__test.activeQueryContexts.clear();
	scripts = [];
	calls = [];
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		assert.ok(script, "script queued");
		const sessionId = options.sessionId ?? options.resume;
		calls.push({ resume: options.resume, sessionId });
		const path = getSessionPath(sessionId, options.cwd, root);
		let parentUuid = null;
		// Only this external SDK double writes its simulated live records.
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
			void input.next().catch(() => {}); // SDK pump acknowledges stdin before waiting for more input
			record("user", initial.message.content, initial.uuid);
			yield { type: "system", subtype: "init", session_id: sessionId };
			yield { type: "user", isReplay: true, parent_tool_use_id: null, uuid: initial.uuid, session_id: sessionId, message: initial.message };
			const sdkAssistant = (content, id) => {
				const value = record("assistant", content);
				return { type: "assistant", parent_tool_use_id: null, uuid: value.uuid, session_id: sessionId, message: { id, model: model.id, content } };
			};
			if (script.tool) yield sdkAssistant([{ type: "tool_use", id: script.tool, name: "mcp__custom-tools__read", input: { path: "a" } }], `msg_${script.tool}`);
			if (script.wait) await script.wait;
			if (script.result) {
				const value = record("user", [{ type: "tool_result", tool_use_id: script.result, content: "file" }]);
				yield { type: "user", parent_tool_use_id: null, uuid: value.uuid, message: value.message };
			}
			if (script.edit) yield sdkAssistant([{ type: "tool_use", id: "edit-id", name: "mcp__custom-tools__edit", input: { path: "a", edits: script.edit } }], "msg_edit");
			else yield sdkAssistant([{ type: "text", text: script.text ?? "answer" }], `msg_final_${sessionId}`);
			yield { type: "result", subtype: "success", is_error: false, result: script.text ?? "answer", session_id: sessionId };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});
afterEach(() => setQuery(null));

function assertCoverage(sid, history) {
	const state = getSharedSession(sid);
	assert.deepEqual(state.digests, digestMessages(history));
	const records = readFileSync(getSessionPath(state.ccSessionId, state.cwd, root), "utf8").trim().split("\n").map(JSON.parse);
	for (const uuid of state.uuids) assert.ok(records.some((r) => r.uuid === uuid), `missing ${uuid}`);
}

describe("cross-session conversation isolation", () => {
	it("a foreground child cannot claim a parent's tool-using conversation", async () => {
		const ask = user("research"), g = gate();
		scripts.push({ id: "cc-parent", tool: "tool-P", result: "tool-P", wait: g.wait, text: "parent answer" });
		const tool = await call("parent", [ask]).result();
		scripts.push({ id: "cc-child", text: "child answer" });
		await call("child", [user("child")]).result();
		const tr = result("tool-P");
		const continuation = call("parent", [ask, tool, tr]);
		g.open();
		const answer = await continuation.result();
		assertCoverage("parent", [ask, tool, tr, answer]);
		scripts.push({ id: "unused", text: "ok" });
		await call("parent", [ask, tool, tr, answer, user("next")]).result();
		assert.equal(calls.at(-1).resume, calls[0].sessionId);
		assert.equal(getSharedSession("child").ccSessionId, calls[1].sessionId);
	});
	it("a background child finishing after a parent does not overwrite it", async () => {
		const ask = user("parent");
		scripts.push({ id: "cc-P", text: "parent answer" });
		const answer = await call("parent", [ask]).result();
		const g = gate();
		scripts.push({ id: "cc-C", wait: g.wait });
		const child = call("child", [user("child")]);
		scripts.push({ id: "unused", text: "ok" });
		await call("parent", [ask, answer, user("next")]).result();
		assert.equal(calls.at(-1).resume, calls[0].sessionId);
		g.open();
		await child.result();
		assert.equal(getSharedSession("parent").ccSessionId, calls[0].sessionId);
		assert.equal(getSharedSession("child").ccSessionId, calls[1].sessionId);
	});
	for (const firstTurn of [false, true]) it(`an unacknowledged steer leaves a contiguous gap (${firstTurn ? "first" : "later"} turn)`, async () => {
		let history = [];
		if (!firstTurn) {
			const ask = user("first");
			scripts.push({ id: "cc-first" });
			history = [ask, await call("parent", [ask]).result()];
		}
		const ask = user("second"), steer = user("missed steer"), g = gate();
		scripts.push({ id: "cc-second", wait: g.wait });
		const pending = call("parent", [...history, ask]);
		await settle();
		const c = [...__test.activeQueryContexts].find((c) => c.piSessionId === "parent");
		c.promptStream.fail(new Error("closed"));
		await __test.deliverToolResults(c, [], [{ type: "text", text: "missed steer" }], history.length + 2, [...history, ask, steer]);
		g.open();
		const answer = await pending.result();
		if (firstTurn) assert.equal(getSharedSession("parent"), null, "no contiguous assistant progress leaves no new mirror");
		else assert.deepEqual(getSharedSession("parent").digests, digestMessages([...history, ask]));
		const previous = getSharedSession("parent")?.ccSessionId;
		const before = previous ? readFileSync(getSessionPath(previous, process.cwd(), root)) : null;
		scripts.push({ id: "unused" });
		await call("parent", [...history, ask, steer, answer, user("third")]).result();
		assert.notEqual(calls.at(-1).sessionId, previous);
		assert.match(readFileSync(getSessionPath(calls.at(-1).resume, process.cwd(), root), "utf8"), /missed steer/);
		if (previous) assert.deepEqual(readFileSync(getSessionPath(previous, process.cwd(), root)), before);
	});
	it("completion uses identity CAS and cannot overwrite a replacement state", async () => {
		const g = gate();
		scripts.push({ id: "cc-old", wait: g.wait });
		const pending = call("parent", [user("first")]);
		await settle();
		const replacement = { ...copyRecording(), ccSessionId: "replacement", cwd: process.cwd(), model: "other" };
		__test.setSharedSession("parent", replacement);
		g.open();
		await pending.result();
		assert.strictEqual(getSharedSession("parent"), replacement);
	});
	for (const edits of ['{"oldText":"a","newText":"b"}', { oldText: "a", newText: "b" }]) it("normalizes edit edits before emitting and hashing", async () => {
		const ask = user("edit");
		scripts.push({ id: "cc-edit", edit: edits });
		const output = await call("parent", [ask]).result();
		assert.deepEqual(output.content[0].arguments.edits, [{ oldText: "a", newText: "b" }]);
		await settle();
		assertCoverage("parent", [ask, output]);
	});
});
