/**
 * A context hook can rewrite the history while a Claude Code query sits parked
 * at a tool boundary: billion-context-pi applies a compression on the provider
 * call that delivers the tool result. No session event marks that rewrite, so
 * delivery has to notice it from the history itself and discard the query,
 * as it does for /compact, instead of handing the result to a CLI that still
 * holds the old conversation.
 *
 * Turns run through the real streamSimple with a mocked SDK query().
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSession } from "cc-session-io";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-parked-rewrite-cc-"));
const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-parked-rewrite-agent-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.on("exit", () => {
	rmSync(claudeDir, { recursive: true, force: true });
	rmSync(agentDir, { recursive: true, force: true });
});

const mod = await import("../src/index.js");
const { setQuery, getSharedSession, resetSharedSession, activeQueryContexts, historyRewrittenBySession } = mod.__test;
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
const scripts = [];
let fresh = 0;
const gate = () => { let open; const wait = new Promise((r) => { open = r; }); return { wait, open }; };
const ev = (event) => ({ type: "stream_event", event });
const toolUse = (id) => [
	ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
	ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
	ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
	ev({ type: "content_block_stop", index: 0 }),
	ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
	ev({ type: "message_stop" }),
];
const done = { type: "result", subtype: "success", is_error: false, result: "ok" };

let clock = 0;
const user = (text) => ({ role: "user", content: text, timestamp: clock++ });
const asst = (content, stopReason = "stop") => ({ role: "assistant", content, api: "claude-bridge", provider: "claude-bridge", model: model.id,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: clock++ });
const say = (text) => asst([{ type: "text", text }]);
const toolCall = (id) => asst([{ type: "toolCall", id, name: "read", arguments: { path: "a" } }], "toolUse");
const toolResult = (id) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ });
const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } }];

const call = (sessionId, messages) => streamSimple(model, { messages, tools }, { sessionId });
const transcript = (sessionId) => JSON.stringify(openSession({ sessionId, projectPath: cwd, claudeDir }).records);

/** Ten exchanges, then the prompt that starts the parked turn. */
function history(tag) {
	const out = [];
	for (let i = 0; i < 10; i++) out.push(user(`${tag} question ${i}`), say(`${tag} answer ${i}`));
	out.push(user(`${tag} read a`));
	return out;
}

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
	historyRewrittenBySession.clear();
	calls.length = 0;
	scripts.length = 0;
	setQuery(({ prompt, options }) => {
		const script = scripts.shift();
		if (!script) throw new Error("no fake script queued");
		const id = options.resume ?? `00000000-0000-4000-8000-${String(++fresh).padStart(12, "0")}`;
		calls.push({ label: script.label, resume: options.resume ?? null, prompt: typeof prompt === "string" ? prompt : null });
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: id };
			for (const step of script.steps) {
				if (typeof step === "function") { await step(); continue; }
				yield step;
			}
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
});

afterEach(() => setQuery(null));

/** Parks session `sid` on tool call `id` and returns the turn's pieces.
 *  `ended` resolves once the parked query has handled its final result. */
async function park(sid, id, tag, before = history(tag)) {
	const held = gate();
	const ended = gate();
	scripts.push({ label: `${sid} turn`, steps: [...toolUse(id), () => held.wait, done, () => ended.open()] });
	const first = await call(sid, before).result();
	assert.equal(first.stopReason, "toolUse", "the turn parks on the tool call");
	return { before, held, ended, a: toolCall(id), tr: toolResult(id) };
}

describe("history rewritten under a parked query", () => {
	it("control: an unchanged history delivers into the parked query", async () => {
		const { before, held, a, tr } = await park("pi-a", "toolu_1", "A");
		const delivery = call("pi-a", [...before, a, tr]);
		held.open();
		await delivery.result();
		assert.equal(calls.length, 1, "no second query: the result went to the parked one");
	});

	it("a shorter history discards the parked query and rebuilds with the summary", async () => {
		const { before, held, a, tr } = await park("pi-a", "toolu_1", "A");
		scripts.push({ label: "continuation", steps: [done] });
		const view = [user("SUMMARY-NONCE-7f3 of the first eight exchanges"), ...before.slice(16), a, tr];
		const delivery = call("pi-a", view);
		held.open();
		await delivery.result();

		assert.equal(calls.length, 2, "the result starts a fresh query over the rewritten history");
		const cont = calls[1];
		assert.ok(cont.resume, "the continuation resumes a rebuilt session");
		const records = transcript(cont.resume);
		assert.match(records, /SUMMARY-NONCE-7f3/);
		assert.match(records, /A answer 9/);
		assert.doesNotMatch(records, /A question 0/, "the compressed exchanges are gone");
		assert.equal(getSharedSession("pi-a").sessionId, cont.resume);
	});

	it("the continuation holds the tool call and result once, and the discarded query cannot overwrite it", async () => {
		const { before, held, ended, a, tr } = await park("pi-a", "toolu_1", "A");
		scripts.push({ label: "continuation", steps: [done] });
		await call("pi-a", [user("SUMMARY-B"), ...before.slice(16), a, tr]).result();
		const rebuilt = getSharedSession("pi-a");
		held.open();
		await ended.wait;
		await new Promise((r) => setImmediate(r));

		const records = openSession({ sessionId: calls[1].resume, projectPath: cwd, claudeDir }).records;
		const blocks = records.flatMap((r) => (Array.isArray(r.message?.content) ? r.message.content : []));
		assert.equal(blocks.filter((b) => b.type === "tool_use" && b.id === "toolu_1").length, 1);
		assert.equal(blocks.filter((b) => b.type === "tool_result" && b.tool_use_id === "toolu_1").length, 1);
		assert.equal(getSharedSession("pi-a").sessionId, rebuilt.sessionId, "the abandoned query's completion left the state alone");
		assert.equal(getSharedSession("pi-a").fingerprint, rebuilt.fingerprint);
	});

	it("an append-only second tool round stays in the same query", async () => {
		const before = history("A");
		const g1 = gate(), g2 = gate();
		scripts.push({ label: "pi-a turn", steps: [...toolUse("toolu_1"), () => g1.wait, ...toolUse("toolu_2"), () => g2.wait, done] });
		await call("pi-a", before).result();
		const round1 = call("pi-a", [...before, toolCall("toolu_1"), toolResult("toolu_1")]);
		g1.open();
		assert.equal((await round1.result()).stopReason, "toolUse", "the query asks for a second tool");
		const round2 = call("pi-a", [...before, toolCall("toolu_1"), toolResult("toolu_1"), toolCall("toolu_2"), toolResult("toolu_2")]);
		g2.open();
		await round2.result();
		assert.equal(calls.length, 1, "both results went to the one query");
	});

	it("a signed thinking block in the served history is not a rewrite", async () => {
		const signed = asst([{ type: "thinking", thinking: "plan", thinkingSignature: "sig-AbC123==" }, { type: "text", text: "A answer 0" }]);
		const base = history("A");
		base[1] = signed;
		const { before, held, a, tr } = await park("pi-a", "toolu_1", "A", base);
		const delivery = call("pi-a", [...before, a, tr]);
		held.open();
		await delivery.result();
		assert.equal(calls.length, 1, "same bytes, same query");

		const next = await park("pi-b", "toolu_2", "A", base);
		scripts.push({ label: "continuation", steps: [done] });
		const view = [...next.before.slice(0, 2), user("SUMMARY-C"), ...next.before.slice(16), next.a, next.tr];
		const rewrite = call("pi-b", view);
		next.held.open();
		await rewrite.result();
		assert.equal(calls.length, 3);
		assert.match(transcript(calls[2].resume), /sig-AbC123==/, "the signature is carried into the rebuild verbatim");
	});

	it("a same-length edit to an earlier message discards the parked query", async () => {
		const { before, held, a, tr } = await park("pi-a", "toolu_1", "A");
		scripts.push({ label: "continuation", steps: [done] });
		const edited = before.slice();
		edited[3] = say("A answer 1 EDITED-NONCE");
		const delivery = call("pi-a", [...edited, a, tr]);
		held.open();
		await delivery.result();

		assert.equal(calls.length, 2);
		assert.match(transcript(calls[1].resume), /EDITED-NONCE/);
	});

	it("one session's rewrite leaves another session's parked query alone", async () => {
		const A = await park("pi-a", "toolu_A", "A");
		const B = await park("pi-b", "toolu_B", "B");
		scripts.push({ label: "A continuation", steps: [done] });

		const aDelivery = call("pi-a", [user("SUMMARY-A"), ...A.before.slice(16), A.a, A.tr]);
		const bDelivery = call("pi-b", [...B.before, B.a, B.tr]);
		A.held.open();
		B.held.open();
		await Promise.all([aDelivery.result(), bDelivery.result()]);

		assert.deepEqual(calls.map((c) => c.label), ["pi-a turn", "pi-b turn", "A continuation"],
			"only pi-a's query was replaced; pi-b's result went into its parked query");
	});
});
