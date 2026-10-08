/**
 * Session reuse checks prior content, not only the message count.
 *
 * A context hook (billion-context-pi's compression, for one) can hand the
 * provider a history that is shorter than the cursor, or one that is rewritten
 * at the same count. The count-only check sent the first as a fresh query with
 * no history, and resumed the stale pre-rewrite session for the second. The
 * fingerprint idea comes from PR #136 (@sonSunnoi).
 *
 * Turns run through the real streamSimple with a mocked SDK query().
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionPath, openSession } from "cc-session-io";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-sync-fp-cc-"));
const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-sync-fp-agent-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => {
	rmSync(claudeDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

const mod = await import("../src/index.js");
const { fingerprintPriors } = await import("../src/priors-fingerprint.js");
const { setQuery, getSharedSession, setSharedSession, resetSharedSession, markRebuildForSession } = mod.__test;
let providerConfig;
mod.default({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	events: { on: () => () => {}, emit: () => {} },
	registerTool: () => {},
});
const streamSimple = providerConfig.streamSimple;
const model = providerConfig.models[0];
const cwd = process.cwd();

const calls = [];
let fresh = 0;
let hold = null;
beforeEach(() => {
	resetSharedSession();
	calls.length = 0;
	hold = null;
	setQuery(({ options }) => {
		const id = options.resume ?? `00000000-0000-4000-8000-${String(++fresh).padStart(12, "0")}`;
		calls.push({ resume: options.resume ?? null });
		const gate = hold;
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: id };
			if (gate) await gate.wait;
			yield { type: "result", subtype: "success", is_error: false, result: "ok" };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});

let clock = 0;
const usage = (n = 0) => ({ input: n, output: n, cacheRead: 0, cacheWrite: 0, totalTokens: n, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const user = (content) => ({ role: "user", content, timestamp: clock++ });
const asst = (content, extra = {}) => ({ role: "assistant", content, api: "claude-bridge", provider: "claude-bridge", model: model.id, usage: usage(), stopReason: "stop", timestamp: clock++, ...extra });
const say = (text) => asst([{ type: "text", text }]);
const toolCall = (id, args) => asst([{ type: "toolCall", id, name: "read", arguments: args }], { stopReason: "toolUse" });
const toolResult = (id, content) => ({ role: "toolResult", toolCallId: id, toolName: "read", content, isError: false, timestamp: clock++ });
const tools = [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }];

const turn = (sessionId, messages) => streamSimple(model, { messages, tools }, sessionId === null ? {} : { sessionId }).result();
const transcript = (id) => openSession({ sessionId: id, projectPath: cwd, claudeDir }).messages
	.map((m) => typeof m.message.content === "string" ? m.message.content : m.message.content.map((b) => b.text ?? b.type).join("|"));

function notes(n) {
	const out = [];
	for (let k = 0; k < n; k++) out.push(user(`note ${k}`), say(`ack ${k}`));
	return out;
}

describe("session reuse by prior fingerprint", () => {
	it("rebuilds from the retained history when a context hook shrinks it", async () => {
		const history = notes(12);
		await turn("s", [...history, user("q1")]);
		const first = getSharedSession("s");
		const compressed = [user("[summary of notes 0-8]"), ...history.slice(18), user("q1"), say("a1")];
		await turn("s", [...compressed, user("q2")]);
		assert.equal(calls[1].resume, first.sessionId, "same session id, rebuilt in place");
		assert.deepEqual(transcript(first.sessionId), compressed.map((m) => typeof m.content === "string" ? m.content : m.content[0].text));
	});

	it("rebuilds when a prior is rewritten at the same count", async () => {
		const history = notes(3);
		await turn("s", [...history, user("q1")]);
		const edited = [...history.slice(0, 2), say("ack 1, edited"), ...history.slice(3)];
		await turn("s", [...edited, user("q1"), say("a1"), user("q2")]);
		assert.ok(transcript(calls[1].resume).includes("ack 1, edited"));
	});

	it("rebuilds when a shrunk history grows back to exactly the old cursor", async () => {
		const history = notes(6);
		await turn("s", [...history, user("q1")]);
		const cursor = getSharedSession("s").cursor;
		const regrown = [user("[summary]"), say("ok")];
		while (regrown.length < cursor) regrown.push(regrown.length % 2 ? say(`new ${regrown.length}`) : user(`new ${regrown.length}`));
		await turn("s", [...regrown, user("q2")]);
		assert.equal(regrown.length, cursor);
		assert.equal(transcript(calls[1].resume)[0], "[summary]", "the stale pre-rewrite session is not resumed");
	});

	it("resumes without rewriting for an append-only continuation", async () => {
		const history = notes(2);
		await turn("s", [...history, user("q1")]);
		const id = getSharedSession("s").sessionId;
		const before = transcript(id);
		await turn("s", [...history, user("q1"), say("a1", { usage: usage(99) }), user("q2")]);
		assert.equal(calls[1].resume, id);
		assert.deepEqual(transcript(id), before, "the trailing assistant Claude Code recorded itself is not re-imported");
		assert.equal(getSharedSession("s").cursor, 7, "the completed turn moves the cursor past q2");
	});

	it("ignores metadata-only changes", async () => {
		const history = notes(2);
		await turn("s", [...history, user("q1")]);
		const id = getSharedSession("s").sessionId;
		const before = transcript(id);
		const restamped = history.map((m) => ({ ...m, timestamp: m.timestamp + 1000, ...(m.role === "assistant" ? { usage: usage(7) } : {}) }));
		await turn("s", [...restamped, user("q1"), say("a1"), user("q2")]);
		assert.deepEqual(transcript(id), before);
	});

	it("rebuilds when a tool argument changes without changing its length", async () => {
		const history = [user("go"), toolCall("t1", { path: "aaaa" }), toolResult("t1", [{ type: "text", text: "x" }]), say("done")];
		await turn("s", [...history, user("q1")]);
		const id = getSharedSession("s").sessionId;
		const edited = [history[0], toolCall("t1", { path: "bbbb" }), ...history.slice(2)];
		await turn("s", [...edited, user("q1"), say("a1"), user("q2")]);
		const records = openSession({ sessionId: id, projectPath: cwd, claudeDir }).messages;
		const input = records.flatMap((m) => Array.isArray(m.message.content) ? m.message.content : []).find((b) => b.type === "tool_use").input;
		assert.deepEqual(input, { path: "bbbb" });
	});

	it("fingerprints thinking signatures, images and tool names", () => {
		const think = (sig) => [user("u"), asst([{ type: "thinking", thinking: "t", thinkingSignature: sig }, { type: "text", text: "a" }])];
		assert.notEqual(fingerprintPriors(think("sig-a")), fingerprintPriors(think("sig-b")));
		const image = (data) => [user("u"), toolCall("t", {}), toolResult("t", [{ type: "image", data, mimeType: "image/png" }])];
		assert.notEqual(fingerprintPriors(image("AAAA")), fingerprintPriors(image("AAAB")));
		const call = [user("u"), toolCall("t", {})];
		assert.notEqual(fingerprintPriors(call, new Map([["read", "mcp__x__read"]])), fingerprintPriors(call, new Map([["read", "mcp__y__read"]])));
		assert.notEqual(fingerprintPriors([user("a b"), say("c")]), fingerprintPriors([user("a"), say("b c")]));
	});

	it("never touches another session's mirror", async () => {
		await turn("x", [...notes(4), user("x1")]);
		const x = { ...getSharedSession("x") };
		const xBefore = transcript(x.sessionId);
		await turn("y", [...notes(5), user("y1")]);
		await turn("y", [user("[summary]"), say("ok"), user("y2")]);
		assert.deepEqual(getSharedSession("x"), x);
		assert.deepEqual(transcript(x.sessionId), xBefore);
	});

	it("clears the mirror on a rewind to an empty history", async () => {
		await turn("s", [...notes(2), user("q1")]);
		const old = getSharedSession("s").sessionId;
		resetSharedSession("s");
		setSharedSession("s", { sessionId: old, cursor: 4, cwd, piSessionId: "s", fingerprint: "stale" });
		await turn("s", [user("fresh start")]);
		assert.equal(calls[1].resume, null);
		assert.notEqual(getSharedSession("s").sessionId, old);
		assert.ok(existsSync(getSessionPath(old, cwd, claudeDir)), "the old file is left alone");
	});

	it("keeps the count-based guard for callers with no session id", async () => {
		await turn(null, [...notes(4), user("q1")]);
		const shared = { ...getSharedSession(null) };
		await turn(null, [user("[summary]"), say("ok"), user("q2")]);
		assert.equal(calls[1].resume, null, "unchanged: a clean start that preserves the shared session");
		assert.equal(getSharedSession(null).sessionId, shared.sessionId);
	});

	it("records the fingerprint of the completed turn's history", async () => {
		const history = [user("u0"), say("a0"), { role: "system", content: "", toolsAdded: [], timestamp: clock++ }];
		await turn("s", [...history, user("q1")]);
		const state = getSharedSession("s");
		assert.equal(state.cursor, 3, "system messages are not counted");
		assert.equal(state.fingerprint, fingerprintPriors([history[0], history[1], user("q1")]));
	});

	it("keeps a rebuild requested while the query was running", async () => {
		await turn("s", [...notes(2), user("q1")]);
		let open;
		hold = { wait: new Promise((r) => { open = r; }) };
		const running = turn("s", [...notes(2), user("q1"), say("a1"), user("q2")]);
		await new Promise((r) => setImmediate(r));
		markRebuildForSession("s", "test");
		setSharedSession("s", { ...getSharedSession("s"), forceRotate: true });
		open();
		await running;
		assert.equal(getSharedSession("s").needsRebuild, true);
		assert.equal(getSharedSession("s").forceRotate, true);
	});
});
