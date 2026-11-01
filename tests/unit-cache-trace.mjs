/**
 * The opt-in cache trace (src/cache-trace.ts), driven through the real provider
 * entry with a fake SDK query: records must link a provider call's input to the
 * session decision and the query it started, a continuation from a later run to
 * that same query, and a recorder failure must stop a query from starting but
 * never break one already running.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { emptyState } from "./lib/session-state.mjs";
import { createSession } from "cc-session-io";
import { snapshotControl } from "../diag/lib/trace-analysis.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-trace-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const mod = await import("../src/index.js");
const trace = await import("../src/cache-trace.js");
const { setQuery, resetSharedSession, activeQueryContexts, setSharedSession } = mod.__test;
let providerConfig;
mod.default({ on: () => {}, registerProvider: (_name, config) => { providerConfig = config; }, registerTool: () => {} });
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];

const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: { cache_read_input_tokens: 7 } } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const text = [
	ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
	ev({ type: "message_stop" }),
];

let clock = 0;
const user = (t) => ({ role: "user", content: t, timestamp: clock++ });
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "contents" }], isError: false, timestamp: clock++ });
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }];

let traceDir, spawned, notices;
beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	trace.resetTraceForTests();
	traceDir = mkdtempSync(join(tmpdir(), "claude-bridge-trace-"));
	spawned = [];
	notices = [];
	trace.setTraceNotifier((m) => notices.push(m));
	// Parks at a tool call, then answers with text once the result is in.
	setQuery(({ prompt, options }) => {
		const n = spawned.push(options);
		const gen = (async function* () {
			const input = prompt[Symbol.asyncIterator]();
			await input.next();
			yield { type: "system", subtype: "init", session_id: options.sessionId ?? options.resume, claude_code_version: "test" };
			for (const step of toolUse(`toolu_${n}`)) yield step;
			// The SDK pulls the next input only after the tool result arrives; the
			// prompt stream stays open, so wait on the tool handler instead.
			await new Promise((r) => setTimeout(r, 30));
			for (const step of text) yield step;
			yield { type: "result", subtype: "success", session_id: options.sessionId ?? options.resume, result: "done", usage: { input_tokens: 1 } };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});

afterEach(() => {
	setQuery(null);
	delete process.env.CLAUDE_BRIDGE_TRACE_DIR;
	delete process.env.CLAUDE_BRIDGE_TRACE_RAW;
	delete process.env.CLAUDE_BRIDGE_TRACE_PROXY;
	trace.resetTraceForTests();
	rmSync(traceDir, { recursive: true, force: true });
});

const runDir = () => join(traceDir, readdirSync(traceDir).find((d) => d.startsWith("run-")));
const events = () => readFileSync(join(runDir(), "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function parkThenContinue(sid, secondSignal = new AbortController().signal) {
	const ask = user("read a");
	const parked = await streamSimple(model, { messages: [ask], tools }, { sessionId: sid, signal: new AbortController().signal }).result();
	assert.equal(parked.stopReason, "toolUse");
	return streamSimple(model, { messages: [ask, parked, toolResult(parked.content.find((b) => b.type === "toolCall").id)], tools }, { sessionId: sid, signal: secondSignal }).result();
}

/** A real CC session file with a companion dir, mirrored for `sid` and marked for
 *  rebuild, so the next provider call deletes and rewrites it in place. */
function plantSession(sid, { symlink = false } = {}) {
	const session = createSession({ projectPath: process.cwd(), claudeDir });
	session.addUserMessage("BEFORE-REBUILD-MARKER");
	session.save();
	const companion = session.jsonlPath.slice(0, -".jsonl".length);
	mkdirSync(join(companion, "tool-results"), { recursive: true });
	writeFileSync(join(companion, "tool-results", "out.txt"), "persisted output");
	if (symlink) symlinkSync("/etc/hosts", join(companion, "tool-results", "link.txt"));
	setSharedSession(sid, emptyState(session.sessionId, process.cwd(), { dirtyTail: true }));
	return session;
}
const history = () => [user("q1"), { role: "assistant", content: [{ type: "text", text: "a1" }], provider: "claude-bridge", api: "x", model: "m", stopReason: "stop", timestamp: clock++ }, user("q2")];

describe("cache trace", () => {
	it("records nothing and leaves the child env alone when disabled", async () => {
		const exitListeners = process.listenerCount("exit");
		await parkThenContinue("pi-off");
		assert.equal(trace.traceId("call"), undefined);
		assert.equal(spawned[0].env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL);
		assert.equal(process.listenerCount("exit"), exitListeners);
		assert.deepEqual(readdirSync(traceDir), []);
	});

	it("links input, decision, query start and a later run's continuation by id", async () => {
		process.env.CLAUDE_BRIDGE_TRACE_DIR = traceDir;
		process.env.CLAUDE_BRIDGE_TRACE_PROXY = "http://127.0.0.1:9";
		const reply = await parkThenContinue("pi-on");
		assert.equal(reply.stopReason, "stop");

		const all = events();
		const [first, second] = all.filter((e) => e.type === "input");
		assert.notEqual(first.callId, second.callId);
		assert.equal(first.piSessionId, "pi-on");
		const decision = all.find((e) => e.type === "decision");
		assert.deepEqual([decision.callId, decision.path, decision.reason], [first.callId, "clean-start", "no-state"]);
		const start = all.find((e) => e.type === "query-start");
		assert.equal(start.callId, first.callId);
		assert.equal(spawned[0].env.ANTHROPIC_BASE_URL, `http://127.0.0.1:9/q/${start.queryId}`);
		assert.equal(spawned[0].env._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL, "1");
		const route = all.find((e) => e.type === "route" && e.route === "tool-result");
		assert.equal(route.callId, second.callId);
		assert.equal(route.queryId, start.queryId, "continuation not tied to the query it feeds");
		assert.notEqual(route.signal, start.signal, "the continuing run's signal is a different signal");
		assert.deepEqual(all.filter((e) => e.type === "api-message").map((e) => [e.queryId, e.apiMessageId]),
			[[start.queryId, "msg_toolu_1"], [start.queryId, "msg_text"]]);
		assert.equal(all.find((e) => e.type === "query-end").outcome, "complete");
	});

	it("keeps each pi session's decisions and queries apart", async () => {
		process.env.CLAUDE_BRIDGE_TRACE_DIR = traceDir;
		await Promise.all([parkThenContinue("pi-a"), parkThenContinue("pi-b")]);
		const all = events();
		const queryOf = (sid) => all.find((e) => e.type === "query-start" && e.piSessionId === sid).queryId;
		assert.notEqual(queryOf("pi-a"), queryOf("pi-b"));
		for (const sid of ["pi-a", "pi-b"]) {
			const callIds = new Set(all.filter((e) => e.type === "input" && e.piSessionId === sid).map((e) => e.callId));
			const route = all.find((e) => e.type === "route" && callIds.has(e.callId));
			assert.equal(route.queryId, queryOf(sid));
		}
	});

	it("captures provider input at call time, not after pi mutates it", async () => {
		process.env.CLAUDE_BRIDGE_TRACE_DIR = traceDir;
		process.env.CLAUDE_BRIDGE_TRACE_RAW = "1";
		const ask = { role: "user", content: [{ type: "text", text: "original" }], timestamp: clock++ };
		const reply = streamSimple(model, { messages: [ask], tools }, { sessionId: "pi-mut" });
		ask.content[0].text = "mutated";
		await reply.result();
		const input = events().find((e) => e.type === "input");
		const saved = JSON.parse(readFileSync(join(runDir(), "artifacts", input.source.artifact), "utf8"));
		assert.equal(saved.messages[0].content[0].text, "original");
		assert.equal(input.source.messages[0].blocks[0].type, "text");
	});

	it("copies the ancestor before a rebuild rotates away from it, and the copy passes as a resume control", async () => {
		process.env.CLAUDE_BRIDGE_TRACE_DIR = traceDir;
		process.env.CLAUDE_BRIDGE_TRACE_RAW = "1";
		const session = plantSession("pi-snap");
		await streamSimple(model, { messages: history(), tools }, { sessionId: "pi-snap" }).result();

		assert.match(readFileSync(session.jsonlPath, "utf8"), /BEFORE-REBUILD-MARKER/, "the ancestor must remain untouched");
		const all = events();
		const snap = all.find((e) => e.type === "snapshot");
		assert.deepEqual([snap.reason, snap.writer, snap.complete], ["rebuild-rotate", "no-known-writer", true]);
		assert.ok(snap.seq < all.find((e) => e.type === "rebuild-written").seq);
		const copied = join(runDir(), "snapshots", snap.snapshotId, "files", `${session.sessionId}.jsonl`);
		assert.match(readFileSync(copied, "utf8"), /BEFORE-REBUILD-MARKER/);
		assert.ok(existsSync(join(runDir(), "snapshots", snap.snapshotId, "files", session.sessionId, "tool-results", "out.txt")));
		assert.deepEqual(snapshotControl(runDir(), snap.snapshotId).reasons, []);
	});

	it("refuses a snapshot with a symlink or an altered file as a resume control", async () => {
		process.env.CLAUDE_BRIDGE_TRACE_DIR = traceDir;
		process.env.CLAUDE_BRIDGE_TRACE_RAW = "1";
		const session = plantSession("pi-snap-link", { symlink: true });
		await streamSimple(model, { messages: history(), tools }, { sessionId: "pi-snap-link" }).result();
		const snap = events().find((e) => e.type === "snapshot");
		assert.equal(snap.complete, false);
		writeFileSync(join(runDir(), "snapshots", snap.snapshotId, "files", `${session.sessionId}.jsonl`), "tampered");
		const control = snapshotControl(runDir(), snap.snapshotId);
		assert.equal(control.usable, false);
		assert.deepEqual(control.reasons, [`refused ${session.sessionId}/tool-results/link.txt: symlink`, `altered ${session.sessionId}.jsonl`]);
	});

	it("does not delete the session when its snapshot cannot be written", async () => {
		process.env.CLAUDE_BRIDGE_TRACE_DIR = traceDir;
		process.env.CLAUDE_BRIDGE_TRACE_RAW = "1";
		await streamSimple(model, { messages: [user("warm up")], tools }, { sessionId: "pi-snap-warm" }).result();
		chmodSync(runDir(), 0o500); // events.jsonl stays appendable; snapshots/ cannot be created
		const session = plantSession("pi-snap-fail");
		const before = spawned.length;
		try {
			const reply = await streamSimple(model, { messages: history(), tools }, { sessionId: "pi-snap-fail" }).result();
			assert.equal(reply.stopReason, "error");
		} catch (error) {
			assert.equal(error.code, "EACCES");
		} finally {
			chmodSync(runDir(), 0o700);
		}
		assert.match(readFileSync(session.jsonlPath, "utf8"), /BEFORE-REBUILD-MARKER/, "the session was deleted without its snapshot");
		assert.equal(spawned.length, before, "a query started without its trace");
	});

	it("latches a recorder failure mid-query, then refuses to start the next query", async () => {
		process.env.CLAUDE_BRIDGE_TRACE_DIR = traceDir;
		const ask = user("read a");
		const parked = await streamSimple(model, { messages: [ask], tools }, { sessionId: "pi-io" }).result();
		chmodSync(join(runDir(), "events.jsonl"), 0o444);

		const continued = await streamSimple(model, { messages: [ask, parked, toolResult("toolu_1")], tools }, { sessionId: "pi-io" }).result();
		assert.equal(continued.stopReason, "stop", "a recorder failure broke the running query");
		assert.equal(notices.length, 1);
		assert.match(notices[0], /incomplete/);

		const next = await streamSimple(model, { messages: [user("again")], tools }, { sessionId: "pi-io-2" }).result();
		assert.equal(next.stopReason, "error");
		assert.match(next.errorMessage, /cache trace is incomplete/);
		assert.equal(spawned.length, 1, "a query started without its trace");
	});
});
