/**
 * Unit tests for the isolated compression fork (billion-context-pi #614).
 *
 * A compression extension asks the bridge, over pi.events, to run the last
 * request a pi session served once more with an extra prompt, capture the
 * arguments of the model's first call to one tool, and execute nothing. The
 * failure modes are all silent: a fork built from a request mutated after it was
 * served, a fork whose tools or system prompt differ from the main query's, a
 * fork that runs where external tools could load, a fork copied from the wrong
 * point of the main transcript, a fork session deleted while CC still writes it,
 * or a fork that writes or deletes the main session or reaches its mirror or
 * query state. These pin each of them.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { getProjectDir, getSessionPath, openSession } from "cc-session-io";
import { answerEndIn, ForkRefused, forkSettings, IsolatedForks, ISOLATED_FORK_CHANNEL, ServedRequests, parseForkRequest, toolResultCutIn, waitForAnswerEnd, waitForToolResultCut } from "../src/isolated-fork.js";

const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-isolated-fork-cc-"));
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.on("exit", () => rmSync(claudeDir, { recursive: true, force: true }));

const settle = () => new Promise((r) => setTimeout(r, 20));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };

function request(overrides = {}) {
	const accepted = [];
	const controller = new AbortController();
	return {
		accepted,
		controller,
		data: {
			version: 1,
			piSessionId: "pi-a",
			prompt: "NUDGE",
			captureTool: "compress",
			signal: controller.signal,
			accept: (result) => { accepted.push(result); return accepted.length === 1; },
			...overrides,
		},
	};
}

const compressTool = { name: "compress", description: "Compress", parameters: { type: "object", properties: {} } };
const readTool = { name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } };
const ctxWith = (text, tools = [readTool, compressTool]) => ({ systemPrompt: undefined, messages: [{ role: "user", content: text, timestamp: 0 }], tools });

function assistant(content, usage = { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 7, cache_creation_input_tokens: 1 }) {
	return { type: "assistant", message: { content, usage } };
}

function fakeDeps(script = () => [], extra = {}) {
	const log = { sources: [], started: [], deleted: [], closed: 0, processClosed: 0, debug: [] };
	const deps = {
		refusal: () => undefined,
		source(served) {
			log.sources.push({ served });
			return { mainSessionId: "main-1", forkPoint: async () => "cut-1" };
		},
		startQuery(served, target, prompt, abortController) {
			log.started.push({ served, target, prompt, abortController });
			const steps = script(abortController, target);
			const gen = (async function* () {
				for (const step of steps) {
					if (typeof step === "function") { await step(); continue; }
					yield step;
				}
			})();
			gen.close = () => { log.closed++; };
			return { query: gen, process: { exited: extra.exited ?? Promise.resolve(), close: () => { log.processClosed++; } } };
		},
		sdkToolName: (name) => `mcp__custom-tools__${name}`,
		deleteSession(id) { log.deleted.push(id); },
		debug: (...args) => log.debug.push(args.join(" ")),
		...extra,
	};
	return { deps, log };
}

const COMPRESS_CALL = assistant([{ type: "tool_use", name: "mcp__custom-tools__compress", input: { startId: "m1" } }]);

describe("answerEndIn", () => {
	const prompt = (text, uuid) => ({ type: "user", uuid, message: { role: "user", content: text } });
	const result = (ids, uuid) => ({ type: "user", uuid, message: { role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "x" })) } });
	const attachment = (uuid, type = "date") => ({ type: "attachment", uuid, attachment: { type } });
	const reply = (uuid) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
	const atPrompt = (text) => ({ kind: "prompt", text, fromByte: 0 });

	it("ends at the answer to the served prompt, past its attachments and earlier blocks, before anything CC writes after it", () => {
		const records = [prompt("go", "p"), attachment("a"), reply("thinking"), reply("answer"), { type: "system", uuid: "s", subtype: "stop_hook_summary" }, prompt("next", "n")];
		assert.equal(records[answerEndIn(records, atPrompt("go"), "answer")].uuid, "answer");
	});

	it("is undefined until the answer is on disk", () => {
		assert.equal(answerEndIn([prompt("go", "p"), attachment("a")], atPrompt("go"), "answer"), undefined);
		assert.equal(answerEndIn([reply("answer"), prompt("go", "p")], atPrompt("go"), "answer"), undefined, "an entry before the served input is not its answer");
	});

	it("is superseded when other input reached the turn before the answer", () => {
		assert.equal(answerEndIn([prompt("go", "p"), prompt("go", "p2"), reply("answer")], atPrompt("go"), "answer"), "superseded");
		assert.equal(answerEndIn([prompt("go", "p"), attachment("q", "queued_command"), reply("answer")], atPrompt("go"), "answer"), "superseded");
		assert.equal(answerEndIn([prompt("go", "p"), { type: "user", uuid: "answer" }], atPrompt("go"), "answer"), "superseded", "the uuid names no assistant entry");
	});

	it("waits for every parallel result, wherever CC put each one", () => {
		const input = { kind: "toolResults", ids: ["t1", "t2"], fromByte: 0 };
		const split = [result(["t1"], "r1"), result(["t2"], "r2"), attachment("a"), reply("answer")];
		assert.equal(split[answerEndIn(split, input, "answer")].uuid, "answer");
		assert.equal(answerEndIn([result(["t1"], "r1"), reply("answer")], input, "answer"), undefined);
		const joined = [result(["t1", "t2"], "r"), reply("answer")];
		assert.equal(joined[answerEndIn(joined, input, "answer")].uuid, "answer");
	});
});

describe("waitForAnswerEnd", () => {
	const input = { kind: "prompt", text: "go", fromByte: 0 };
	const onDisk = [{ type: "user", uuid: "p", message: { role: "user", content: "go" } }, { type: "assistant", uuid: "answer", message: { role: "assistant", content: [] } }];
	const wait = { replyMs: 1_000, flushMs: 100, pollMs: 5 };
	const watch = (over = {}) => ({ reply: () => undefined, superseded: () => false, records: () => onDisk, ...over });
	const refusal = (promise) => promise.then(() => assert.fail("expected a refusal"), (error) => { assert.ok(error instanceof ForkRefused, String(error)); return error.reason; });

	it("returns the answer's entry once the turn ended in an answer that is on disk", async () => {
		let reply;
		setTimeout(() => { reply = { kind: "answer", lastUuid: "answer" }; }, 20);
		assert.equal(await waitForAnswerEnd(watch({ reply: () => reply }), input, new AbortController().signal, wait), "answer");
	});

	it("waits for an answer that reaches the transcript after the turn ended, and not forever", async () => {
		let records = onDisk.slice(0, 1);
		setTimeout(() => { records = onDisk; }, 30);
		const late = watch({ reply: () => ({ kind: "answer", lastUuid: "answer" }), records: () => records });
		assert.equal(await waitForAnswerEnd(late, input, new AbortController().signal, wait), "answer");
		const never = watch({ reply: () => ({ kind: "answer", lastUuid: "answer" }), records: () => onDisk.slice(0, 1) });
		const started = Date.now();
		assert.equal(await refusal(waitForAnswerEnd(never, input, new AbortController().signal, wait)), "unsupported-context");
		assert.ok(Date.now() - started < 1_000);
	});

	it("declines a turn that ended on a tool call or failed, without reading the transcript", async () => {
		const unread = { records: () => assert.fail("read the transcript") };
		assert.equal(await refusal(waitForAnswerEnd(watch({ ...unread, reply: () => ({ kind: "toolUse" }) }), input, new AbortController().signal, wait)), "unsupported-context");
		assert.equal(await refusal(waitForAnswerEnd(watch({ ...unread, reply: () => ({ kind: "failed" }) }), input, new AbortController().signal, wait)), "stale-context");
	});

	it("prefers a recorded answer over the query having moved on, so a normal end is not taken for a stale one", async () => {
		const ended = watch({ reply: () => ({ kind: "answer", lastUuid: "answer" }), superseded: () => true });
		assert.equal(await waitForAnswerEnd(ended, input, new AbortController().signal, wait), "answer");
	});

	it("declines once the input is superseded with no answer, or the turn outlasts its deadline", async () => {
		let superseded = false;
		setTimeout(() => { superseded = true; }, 20);
		assert.equal(await refusal(waitForAnswerEnd(watch({ superseded: () => superseded }), input, new AbortController().signal, wait)), "stale-context");
		const started = Date.now();
		assert.equal(await refusal(waitForAnswerEnd(watch(), input, new AbortController().signal, { ...wait, replyMs: 50 })), "stale-context");
		assert.ok(Date.now() - started < 1_000);
	});

	it("declines an answer that other input overtook on disk", async () => {
		const overtaken = [onDisk[0], { type: "user", uuid: "steer", message: { role: "user", content: "also" } }, onDisk[1]];
		const w = watch({ reply: () => ({ kind: "answer", lastUuid: "answer" }), records: () => overtaken });
		assert.equal(await refusal(waitForAnswerEnd(w, input, new AbortController().signal, wait)), "stale-context");
	});

	it("stops on abort", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		assert.equal(await refusal(waitForAnswerEnd(watch(), input, controller.signal, wait)), "aborted");
	});
});

describe("toolResultCutIn", () => {
	const result = (ids, uuid) => ({ type: "user", uuid, message: { role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "x" })) } });
	const attachment = (uuid, type = "date") => ({ type: "attachment", uuid, attachment: { type } });
	const reply = (uuid) => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
	const input = { kind: "toolResults", ids: ["trig", "t2"], fromByte: 0 };

	it("cuts after the last of the input's results and the attachments written with them, settled once the next record follows", () => {
		assert.deepEqual(toolResultCutIn([result(["trig"], "r1"), result(["t2"], "r2"), attachment("a1"), attachment("a2"), reply("next")], input), { uuid: "a2", settled: true });
		assert.deepEqual(toolResultCutIn([result(["trig", "t2"], "r"), attachment("a")], input), { uuid: "a", settled: false }, "more attachments may still come");
		assert.deepEqual(toolResultCutIn([result(["trig", "t2"], "r"), { type: "user", uuid: "steer", message: { role: "user", content: "also" } }], input), { uuid: "r", settled: true }, "never past the next input");
	});

	it("is undefined until every result of the input is on disk, and superseded when a queued command came with them", () => {
		assert.equal(toolResultCutIn([result(["trig"], "r1")], input), undefined);
		assert.equal(toolResultCutIn([result(["trig", "t2"], "r"), attachment("q", "queued_command")], input), "superseded");
	});
});

describe("waitForToolResultCut", () => {
	const input = { kind: "toolResults", ids: ["trig"], fromByte: 0 };
	const resultRecord = { type: "user", uuid: "r", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "trig", content: "queued" }] } };
	const wait = { cutMs: 500, settleMs: 40, pollMs: 5 };
	const watch = (records, over = {}) => ({ reply: () => undefined, superseded: () => false, records: () => records, ...over });
	const refusal = (promise) => promise.then(() => assert.fail("expected a refusal"), (error) => { assert.ok(error instanceof ForkRefused, String(error)); return error.reason; });

	it("returns the cut without waiting for the main turn to answer", async () => {
		const settled = [resultRecord, { type: "assistant", uuid: "a", message: { role: "assistant", content: [] } }];
		assert.equal(await waitForToolResultCut(watch(settled, { reply: () => assert.fail("must not wait for the reply") }), input, "trig", new AbortController().signal, wait), "r");
		const started = Date.now();
		assert.equal(await waitForToolResultCut(watch([resultRecord]), input, "trig", new AbortController().signal, wait), "r", "an unsettled cut is taken once no attachment follows within settleMs");
		assert.ok(Date.now() - started >= 30);
	});

	it("still cuts when the main query moved on after the result reached the transcript", async () => {
		assert.equal(await waitForToolResultCut(watch([resultRecord], { superseded: () => true }), input, "trig", new AbortController().signal, wait), "r");
	});

	it("declines input that does not deliver the trigger's result, without reading the transcript", async () => {
		const unread = { records: () => assert.fail("read the transcript") };
		assert.equal(await refusal(waitForToolResultCut(watch([], unread), input, "other", new AbortController().signal, wait)), "unsupported-context");
		assert.equal(await refusal(waitForToolResultCut(watch([], unread), { kind: "prompt", text: "go", fromByte: 0 }, "trig", new AbortController().signal, wait)), "unsupported-context");
	});

	it("declines a history rewritten before the result is on disk, and a result that never arrives within its deadline from the start", async () => {
		assert.equal(await refusal(waitForToolResultCut(watch([], { superseded: () => true }), input, "trig", new AbortController().signal, wait)), "stale-context");
		const started = Date.now();
		assert.equal(await refusal(waitForToolResultCut(watch([]), input, "trig", new AbortController().signal, { ...wait, cutMs: 60 })), "cut-timeout");
		assert.ok(Date.now() - started < 1_000);
	});

	it("stops on abort", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		assert.equal(await refusal(waitForToolResultCut(watch([]), input, "trig", controller.signal, { ...wait, cutMs: 5_000 })), "aborted");
	});
});

describe("forkSettings", () => {
	it("turns hooks off on a copy of the main query's settings object, and has no fork for a settings file path", () => {
		const main = { autoMemoryEnabled: false, claudeMdExcludes: ["x"] };
		assert.deepEqual(forkSettings(main), { autoMemoryEnabled: false, claudeMdExcludes: ["x"], disableAllHooks: true });
		assert.deepEqual(main, { autoMemoryEnabled: false, claudeMdExcludes: ["x"] }, "the main settings are not mutated");
		assert.deepEqual(forkSettings(undefined), { disableAllHooks: true });
		assert.equal(forkSettings("/path/settings.json"), undefined);
	});
});

describe("parseForkRequest", () => {
	it("accepts only the v1 shape", () => {
		assert.ok(parseForkRequest(request().data));
		for (const bad of [
			null, "x", { ...request().data, version: 2 }, { ...request().data, piSessionId: "" },
			{ ...request().data, prompt: 1 }, { ...request().data, captureTool: "" },
			{ ...request().data, signal: {} }, { ...request().data, accept: undefined },
			{ ...request().data, cutAfterToolResult: "" }, { ...request().data, cutAfterToolResult: 7 },
		]) assert.equal(parseForkRequest(bad), undefined);
		assert.equal(parseForkRequest(request({ cutAfterToolResult: "toolu_1" }).data).cutAfterToolResult, "toolu_1");
	});
});

describe("ServedRequests", () => {
	it("keeps a deep copy taken at provider entry, so later mutation of the request never reaches a fork", () => {
		const served = new ServedRequests();
		const model = { id: "m", thinkingLevelMap: { high: "high" } };
		const ctx = ctxWith("A1");
		assert.equal(served.record("pi-a", model, ctx, "high", "/cwd"), true);
		ctx.messages[0].content = "mutated";
		ctx.messages.push({ role: "user", content: "appended", timestamp: 1 });
		ctx.tools[0].parameters.properties.path.type = "number";
		model.thinkingLevelMap.high = "low";
		const copy = served.get("pi-a");
		assert.deepEqual(copy.context.messages, [{ role: "user", content: "A1", timestamp: 0 }]);
		assert.equal(copy.context.tools[0].parameters.properties.path.type, "string");
		assert.equal(copy.model.thinkingLevelMap.high, "high");
		assert.equal(copy.piSessionId, "pi-a");
	});

	it("drops the previous record when a request cannot be copied, rather than forking a stale one", () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("old"), undefined, "/cwd");
		assert.equal(served.record("pi-a", { id: "m", hook: () => {} }, ctxWith("new"), undefined, "/cwd"), false);
		assert.equal(served.get("pi-a"), undefined);
	});
});

describe("IsolatedForks", () => {
	it("does not accept a session this instance never served, or a malformed request", () => {
		const { deps, log } = fakeDeps();
		const forks = new IsolatedForks(new ServedRequests(), deps);
		const r = request();
		forks.handle(r.data);
		forks.handle({ ...r.data, version: 2 });
		assert.equal(r.accepted.length, 0);
		assert.equal(log.sources.length, 0);
	});

	it("accepts once even when the handler is registered twice", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const { deps, log } = fakeDeps(() => [COMPRESS_CALL]);
		const forks = new IsolatedForks(served, deps);
		const r = request();
		forks.handle(r.data);
		forks.handle(r.data);
		assert.equal(r.accepted.length, 1);
		await r.accepted[0];
		assert.equal(log.started.length, 1);
	});

	it("starts no work when its acceptance is not the one taken", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const { deps, log } = fakeDeps(() => [COMPRESS_CALL]);
		const forks = new IsolatedForks(served, deps);
		forks.handle(request({ accept: () => false }).data);
		await settle();
		assert.equal(log.started.length, 0);
	});

	it("forks the request served before the accept, not a later one or another session's", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("A1"), "high", "/cwd");
		served.record("pi-b", { id: "m" }, ctxWith("B1"), undefined, "/cwd");
		const hold = gate();
		const { deps, log } = fakeDeps(() => [hold.wait, COMPRESS_CALL]);
		const forks = new IsolatedForks(served, deps);
		const r = request();
		forks.handle(r.data);
		served.record("pi-a", { id: "m" }, ctxWith("A2"), "low", "/cwd");
		hold.open();
		const result = await r.accepted[0];
		assert.equal(result.ok, true);
		assert.equal(log.sources[0].served.context.messages[0].content, "A1");
		assert.equal(log.started[0].served.context.messages[0].content, "A1");
		assert.equal(log.started[0].served.reasoning, "high");
		assert.equal(served.get("pi-a").context.messages[0].content, "A2");
	});

	it("captures the first capture-tool call and its usage, and leaves no abort listener behind", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const { deps, log } = fakeDeps((_, target) => [
			{ type: "system", subtype: "init", session_id: target.forkSessionId },
			assistant([
				{ type: "tool_use", name: "mcp__custom-tools__read", input: { path: "x" } },
				{ type: "tool_use", name: "mcp__custom-tools__compress", input: { startId: "m1", endId: "m2", summary: "s" } },
				{ type: "tool_use", name: "mcp__custom-tools__compress", input: { startId: "m9" } },
			]),
		]);
		const forks = new IsolatedForks(served, deps);
		const r = request();
		forks.handle(r.data);
		const result = await r.accepted[0];
		assert.deepEqual(result, { ok: true, args: { startId: "m1", endId: "m2", summary: "s" }, usage: { input: 10, output: 2, cacheRead: 7, cacheWrite: 1, complete: false } }, "without stream events the snapshot is all there is, so it is not final");
		assert.equal(log.started[0].prompt, "NUDGE");
		assert.equal(log.closed, 1);
		assert.equal(log.processClosed, 1);
		assert.equal(getEventListeners(r.controller.signal, "abort").length, 0);
		await settle();
		assert.deepEqual(log.deleted, [log.started[0].target.forkSessionId]);
	});

	it("forks Claude Code's copy of the main session at the source's fork point, under a new id it owns", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const { deps, log } = fakeDeps(() => [COMPRESS_CALL]);
		const forks = new IsolatedForks(served, deps);
		const ids = new Set();
		for (let i = 0; i < 3; i++) {
			const r = request();
			forks.handle(r.data);
			assert.equal((await r.accepted[0]).ok, true);
		}
		for (const { target } of log.started) {
			assert.equal(target.mainSessionId, "main-1");
			assert.equal(target.resumeAt, "cut-1");
			assert.match(target.forkSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
			assert.notEqual(target.forkSessionId, "main-1");
			ids.add(target.forkSessionId);
		}
		assert.equal(ids.size, 3, "each fork gets its own session");
		await settle();
		assert.deepEqual(log.deleted.sort(), [...ids].sort(), "only the forks' own sessions are deleted");
	});

	it("stops when init names a session other than the fork's, and deletes neither it nor the main one", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		for (const named of ["main-1", "11111111-1111-4111-8111-111111111111", "../../escape"]) {
			const { deps, log } = fakeDeps(() => [{ type: "system", subtype: "init", session_id: named }, COMPRESS_CALL]);
			const forks = new IsolatedForks(served, deps);
			const r = request();
			forks.handle(r.data);
			assert.deepEqual(await r.accepted[0], { ok: false, reason: "error" });
			await settle();
			assert.deepEqual(log.deleted, [log.started[0].target.forkSessionId], `${named} must not be deleted`);
		}
	});

	it("accepts an init that names the fork's own session", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const { deps } = fakeDeps((_, target) => [{ type: "system", subtype: "init", session_id: target.forkSessionId }, COMPRESS_CALL]);
		const forks = new IsolatedForks(served, deps);
		const r = request();
		forks.handle(r.data);
		assert.equal((await r.accepted[0]).ok, true);
	});

	it("returns the capture at once but deletes the session only after the CC process exits", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const exit = gate();
		const { deps, log } = fakeDeps(() => [COMPRESS_CALL], { exited: exit.wait() });
		const forks = new IsolatedForks(served, deps);
		const r = request();
		forks.handle(r.data);
		const result = await r.accepted[0];
		assert.equal(result.ok, true);
		assert.equal(log.closed, 1, "the reader ended and the query was closed");
		await settle();
		assert.deepEqual(log.deleted, [], "the reader ending is not proof the process stopped writing");
		const id = log.started[0].target.forkSessionId;
		assert.deepEqual([...forks.unsettled], [id]);
		exit.open();
		await settle();
		assert.deepEqual(log.deleted, [id]);
		assert.equal(forks.unsettled.size, 0);
	});

	it("reports no-capture when the model never calls the capture tool", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const { deps } = fakeDeps(() => [assistant([{ type: "text", text: "no" }])]);
		const forks = new IsolatedForks(served, deps);
		const r = request();
		forks.handle(r.data);
		const result = await r.accepted[0];
		assert.equal(result.ok, false);
		assert.equal(result.reason, "no-capture");
	});

	it("refuses before writing anything: missing capture tool, aborted signal, or an unsafe configuration", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a", [readTool]), undefined, "/cwd");
		const { deps, log } = fakeDeps();
		const forks = new IsolatedForks(served, deps);
		const missing = request();
		forks.handle(missing.data);
		assert.deepEqual(await missing.accepted[0], { ok: false, reason: "no-capture-tool" });
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const aborted = request();
		aborted.controller.abort();
		forks.handle(aborted.data);
		assert.deepEqual(await aborted.accepted[0], { ok: false, reason: "aborted" });
		const unsafe = new IsolatedForks(served, { ...deps, refusal: () => "unsafe-config" });
		const r = request();
		unsafe.handle(r.data);
		assert.deepEqual(await r.accepted[0], { ok: false, reason: "unsafe-config" });
		assert.equal(log.started.length, 0);
	});

	it("declines with error, without throwing into the emitter, when the source throws", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const { deps, log } = fakeDeps(() => [], { source: () => { throw new TypeError("malformed"); } });
		const forks = new IsolatedForks(served, deps);
		const r = request();
		assert.doesNotThrow(() => forks.handle(r.data));
		assert.deepEqual(await r.accepted[0], { ok: false, reason: "error" });
		assert.equal(log.started.length, 0);
		assert.ok(log.debug.some((line) => line.includes("TypeError")) && !log.debug.some((line) => line.includes("malformed")));
	});

	it("passes a refusal from the source or its fork point through as its reason, with nothing started or deleted", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const cases = [
			[{ source: () => "stale-context" }, "stale-context"],
			[{ source: () => ({ mainSessionId: "main-1", forkPoint: async () => { throw new ForkRefused("unsupported-context"); } }) }, "unsupported-context"],
		];
		for (const [extra, reason] of cases) {
			const { deps, log } = fakeDeps(() => [], extra);
			const forks = new IsolatedForks(served, deps);
			const r = request();
			forks.handle(r.data);
			assert.deepEqual(await r.accepted[0], { ok: false, reason });
			assert.equal(log.started.length, 0);
			assert.deepEqual(log.deleted, []);
		}
	});

	it("stops waiting for a fork point when aborted", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const { deps, log } = fakeDeps(() => [], {
			source: () => ({ mainSessionId: "main-1", forkPoint: (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new ForkRefused("aborted")))) }),
		});
		const forks = new IsolatedForks(served, deps);
		const r = request();
		forks.handle(r.data);
		await settle();
		r.controller.abort();
		assert.deepEqual(await r.accepted[0], { ok: false, reason: "aborted" });
		assert.equal(log.started.length, 0);
	});

	it("stops promptly on abort but keeps the session until the process exits", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const stuck = gate();
		const exit = gate();
		const { deps, log } = fakeDeps(() => [stuck.wait], { exited: exit.wait() });
		const forks = new IsolatedForks(served, deps);
		const r = request();
		forks.handle(r.data);
		await settle();
		r.controller.abort();
		assert.deepEqual(await r.accepted[0], { ok: false, reason: "aborted" });
		assert.ok(log.started[0].abortController.signal.aborted, "the request signal must reach the query");
		assert.equal(log.processClosed, 1);
		stuck.open();
		await settle();
		assert.deepEqual(log.deleted, []);
		exit.open();
		await settle();
		assert.deepEqual(log.deleted, [log.started[0].target.forkSessionId]);
	});

	it("abortAll stops running forks", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const { deps } = fakeDeps(() => [() => new Promise(() => {})]);
		const forks = new IsolatedForks(served, deps);
		const r = request();
		forks.handle(r.data);
		await settle();
		forks.abortAll();
		assert.deepEqual(await r.accepted[0], { ok: false, reason: "aborted" });
	});

	it("reports a setup failure by kind only", async () => {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const { deps, log } = fakeDeps(() => [], { source: () => ({ mainSessionId: "main-1", forkPoint: async () => { throw new Error("secret sk-ant-123 in path"); } }) });
		const forks = new IsolatedForks(served, deps);
		const r = request();
		forks.handle(r.data);
		assert.deepEqual(await r.accepted[0], { ok: false, reason: "error" });
		assert.ok(log.debug.every((line) => !line.includes("sk-ant")), log.debug.join("\n"));
	});
});

describe("isolated fork through the provider", async () => {
	const mod = await import("../src/index.js");
	const { __test } = mod;
	let providerConfig;
	const bus = createEventBus();
	mod.default({
		on: () => {},
		registerProvider: (_name, config) => { providerConfig = config; },
		events: bus,
		registerTool: () => {},
	});
	const streamSimple = providerConfig.streamSimple;
	const model = providerConfig.models[0];
	const cwd = process.cwd();

	// Exactly what billion-context-pi's AsyncCompressor emits (src/async-compress.ts launchBridge).
	function acpRequest(piSessionId, cutAfterToolResult) {
		let accepted;
		const controller = new AbortController();
		bus.emit(ISOLATED_FORK_CHANNEL, {
			version: 1,
			piSessionId,
			prompt: "NUDGE",
			captureTool: "compress",
			...(cutAfterToolResult ? { cutAfterToolResult } : {}),
			signal: controller.signal,
			accept: (result) => {
				if (!result || typeof result.then !== "function") return false;
				const promise = Promise.resolve(result);
				promise.catch(() => {});
				if (accepted) return false;
				accepted = promise;
				return true;
			},
		});
		return { accepted, controller };
	}

	const queries = [];
	const scripts = [];
	beforeEach(() => {
		__test.resetSharedSession();
		__test.setProviderSettings({});
		__test.setForkAnswerWait({ replyMs: 3_000, flushMs: 300, pollMs: 10 });
		__test.setForkCutWait({ cutMs: 2_000, settleMs: 50, pollMs: 10 });
		queries.length = 0;
		scripts.length = 0;
		__test.setQuery(({ options, prompt }) => {
			const script = scripts.shift();
			if (!script) throw new Error("no fake script queued");
			const entry = { label: script.label, options, prompt, closed: 0, interrupted: 0 };
			if (script.onStart) script.onStart(entry);
			queries.push(entry);
			const gen = (async function* () {
				for (const step of script.steps) {
					if (typeof step === "function") { await step(); continue; }
					// What CC reports: the forked session's id, else the resumed one.
					const id = options.forkSession ? options.sessionId : options.resume;
					yield step.type === "system" && id && !step.session_id ? { ...step, session_id: id } : step;
				}
			})();
			gen.interrupt = async () => { entry.interrupted++; };
			gen.close = () => { entry.closed++; };
			return gen;
		});
	});
	afterEach(() => {
		__test.setQuery(null);
		__test.setProviderSettings({});
		__test.setForkAnswerWait(null);
		__test.setForkCutWait(null);
	});

	let clock = 0;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const asst = (content, stopReason = "stop") => ({ role: "assistant", content, api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus", usage, stopReason, timestamp: clock++ });
	const tools = [
		{ name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } } },
		{ name: "compress", description: "Compress a range", parameters: { type: "object", properties: { startId: { type: "string" } }, required: ["startId"] } },
	];
	const historyFor = (tag) => [
		{ role: "user", content: `[m00001] ${tag} read it`, timestamp: clock++ },
		asst([
			{ type: "thinking", thinking: "plan", thinkingSignature: "sig-verbatim-123" },
			{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "\x3cacp tokens=\"2\"\x3em00002\x3c/acp\x3e.txt" } },
		], "toolUse"),
		{ role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "[m00003] body" }], isError: false, timestamp: clock++ },
		asst([{ type: "text", text: "[m00004] done" }]),
		{ role: "user", content: `[m00005] ${tag} next`, timestamp: clock++ },
	];

	const sessionRecords = (sessionId) => openSession({ sessionId, projectPath: cwd, claudeDir }).records;
	const sessionExists = (sessionId) => { try { sessionRecords(sessionId); return true; } catch { return false; } };
	const appendRecord = (sessionId, record) => {
		const session = openSession({ sessionId, projectPath: cwd, claudeDir });
		const last = session.records.at(-1);
		const full = { uuid: randomUUID(), parentUuid: last?.uuid ?? null, sessionId, timestamp: new Date().toISOString(), ...record };
		appendFileSync(session.jsonlPath, JSON.stringify(full) + "\n");
		return full.uuid;
	};
	// Claude Code records the prompt it was handed (the latest pi prompt) before it streams a reply.
	const ccRecordsPrompt = (text) => (entry) => appendRecord(entry.options.resume, { type: "user", message: { role: "user", content: text } });
	const answerMessage = (uuid, text = "answer") => ({ type: "assistant", uuid, message: { id: `msg_${uuid.slice(0, 8)}`, role: "assistant", content: [{ type: "text", text }] } });
	const answerRecord = (uuid, text = "answer") => ({ type: "assistant", uuid, message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } });
	const success = { type: "result", subtype: "success", is_error: false, result: "ok" };

	// A main turn that answers once released. `flush` is when the answer reaches
	// the transcript: with the message (as CC does), after the result, or never.
	async function startMain(piSessionId, history, { flush = "with-message" } = {}) {
		const hold = gate();
		const answer = randomUUID();
		const entry = {};
		const write = () => appendRecord(entry.mainId, answerRecord(answer));
		scripts.push({
			label: `main:${piSessionId}`,
			onStart: (q) => { entry.mainId = q.options.resume; ccRecordsPrompt(history.at(-1).content)(q); },
			steps: [{ type: "system", subtype: "init" }, hold.wait, () => { if (flush === "with-message") write(); }, answerMessage(answer), success],
		});
		const stream = streamSimple(model, { systemPrompt: undefined, messages: history, tools }, { sessionId: piSessionId });
		await settle();
		return { query: queries.at(-1), answer, stream, write, finish: async () => { hold.open(); await stream.result(); } };
	}

	const forkScript = (onStart) => ({
		label: "fork",
		onStart,
		steps: [{ type: "system", subtype: "init" }, assistant([
			{ type: "tool_use", name: "mcp__custom-tools__read", input: { path: "x" } },
			{ type: "tool_use", name: "mcp__custom-tools__compress", input: { startId: "m00001" } },
		])],
	});
	const projectFiles = () => readdirSync(getProjectDir(cwd, claudeDir)).sort();
	const bytesOf = (sessionId) => readFileSync(getSessionPath(sessionId, cwd, claudeDir), "utf8");

	it("forks Claude Code's own copy of the main session at the served request's answer, once the main turn ends, with the main query's options and tools, and leaves the main session alone", async () => {
		const history = historyFor("A");
		const historyBefore = structuredClone(history);
		const toolsBefore = structuredClone(tools);
		const main = await startMain("pi-main", history);
		const mainId = main.query.options.resume;
		const servedBefore = structuredClone(__test.servedRequests.get("pi-main"));

		let filesAtStart;
		scripts.push(forkScript(() => { filesAtStart = projectFiles(); }));
		const r = acpRequest("pi-main");
		assert.ok(r.accepted, "the serving instance accepts in the emit tick");
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(queries.length, 1, "no fork starts while the main turn runs");
		assert.equal(main.query.closed + main.query.interrupted, 0, "the main query is not stopped or held");

		await main.finish();
		const mainShared = { ...__test.getSharedSession("pi-main") };
		const activeBefore = [...__test.activeQueryContexts];
		const mainBytes = bytesOf(mainId);
		const filesBefore = projectFiles();
		const result = await r.accepted;
		assert.deepEqual(result.ok && result.args, { startId: "m00001" });

		const fork = queries[1];
		assert.equal(fork.label, "fork");
		assert.equal(fork.prompt, "NUDGE");
		assert.equal(fork.options.resume, mainId, "Claude Code copies the main session itself");
		assert.equal(fork.options.forkSession, true, "into a new session, never writing the main one");
		assert.match(fork.options.sessionId, /^[0-9a-f-]{36}$/);
		assert.notEqual(fork.options.sessionId, mainId);
		assert.equal(fork.options.resumeSessionAt, main.answer, "up to the answer to the served request");
		assert.deepEqual(filesAtStart, filesBefore, "the bridge writes no session of its own for the fork");
		assert.equal(fork.options.maxTurns, 1, "one turn: a second one would answer the refused tool call upstream");
		assert.ok(fork.options.abortController instanceof AbortController);
		assert.equal(typeof fork.options.spawnClaudeCodeProcess, "function");
		assert.equal(main.query.options.spawnClaudeCodeProcess, undefined, "the main query keeps the SDK's own spawner");
		for (const key of ["cwd", "tools", "permissionMode", "includePartialMessages", "systemPrompt", "extraArgs", "env", "effort", "settingSources"]) {
			assert.deepEqual(fork.options[key], main.query.options[key], `fork ${key} differs from the main query's`);
		}
		assert.deepEqual(fork.options.settings, { ...main.query.options.settings, disableAllHooks: true }, "the fork's settings are the main query's with hooks off");
		assert.equal(main.query.options.settings.disableAllHooks, undefined, "the main query keeps its hooks");

		const client = new Client({ name: "test", version: "1" });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		await fork.options.mcpServers["custom-tools"].instance.connect(serverTransport);
		await client.connect(clientTransport);
		assert.deepEqual((await client.listTools()).tools, tools.map(({ name, description, parameters }) => ({ name, description, inputSchema: parameters })));
		for (const name of ["read", "compress"]) {
			const called = await client.callTool({ name, arguments: {}, _meta: { "claudecode/toolUseId": `t_${name}` } });
			assert.equal(called.isError, true, `${name} must be refused in the fork`);
		}
		await client.close();

		assert.equal(bytesOf(mainId), mainBytes, "the main transcript, signed thinking included, is byte-for-byte unchanged");
		assert.ok(mainBytes.includes("sig-verbatim-123"));
		assert.deepEqual(history, historyBefore, "the caller's history is not mutated");
		assert.deepEqual(tools, toolsBefore, "the caller's tools are not mutated");
		assert.deepEqual(__test.servedRequests.get("pi-main"), servedBefore, "the fork does not mutate the recorded request");
		assert.equal(fork.closed, 1);
		await settle();
		assert.deepEqual(projectFiles(), filesBefore);
		assert.deepEqual({ ...__test.getSharedSession("pi-main") }, mainShared, "the main session mirror is untouched");
		assert.ok([...__test.activeQueryContexts].every((c) => activeBefore.includes(c)), "the fork never joins the routed query contexts");
	});

	it("routes by session: a fork for one session copies that session while another streams", async () => {
		const a = await startMain("pi-a", historyFor("A"));
		const b = await startMain("pi-b", historyFor("B"));
		const sharedA = { ...__test.getSharedSession("pi-a") };
		scripts.push(forkScript());
		const pending = acpRequest("pi-b").accepted;
		await b.finish();
		assert.equal((await pending).ok, true);
		const fork = queries.at(-1);
		assert.equal(fork.options.resume, b.query.options.resume);
		assert.equal(fork.options.resumeSessionAt, b.answer);
		assert.deepEqual({ ...__test.getSharedSession("pi-a") }, sharedA);
		await a.finish();
	});

	it("waits for an answer that reaches the transcript after the turn ended, and refuses if it never does", async () => {
		const late = await startMain("pi-late", historyFor("W"), { flush: "after-result" });
		scripts.push(forkScript());
		const pending = acpRequest("pi-late").accepted;
		await late.finish();
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(queries.at(-1).label, "main:pi-late", "not before the answer is on disk");
		late.write();
		assert.equal((await pending).ok, true);
		assert.equal(queries.at(-1).options.resumeSessionAt, late.answer);

		const never = await startMain("pi-never", historyFor("N"), { flush: "never" });
		const refused = acpRequest("pi-never").accepted;
		await never.finish();
		const started = Date.now();
		assert.deepEqual(await refused, { ok: false, reason: "unsupported-context" });
		assert.ok(Date.now() - started < 2_000);
		assert.equal(queries.at(-1).label, "main:pi-never", "no fork query is started");
	});

	it("the next prompt may start before the answer is on disk: the fork still cuts at this request's answer", async () => {
		const history = historyFor("N");
		const first = await startMain("pi-next", history, { flush: "after-result" });
		const mainId = first.query.options.resume;
		const pending = acpRequest("pi-next").accepted;
		await first.finish();
		const next = [...history, asst([{ type: "text", text: "answer" }]), { role: "user", content: "[m00007] N again", timestamp: clock++ }];
		const hold = gate();
		scripts.push({ label: "main:pi-next:2", steps: [{ type: "system", subtype: "init" }, hold.wait, success] });
		const second = streamSimple(model, { systemPrompt: undefined, messages: next, tools }, { sessionId: "pi-next" });
		await settle();
		assert.equal(queries.at(-1).label, "main:pi-next:2", "a new query now holds the session");
		scripts.push(forkScript());
		first.write();
		appendRecord(mainId, { type: "user", message: { role: "user", content: "[m00007] N again" } });
		assert.equal((await pending).ok, true);
		const fork = queries.at(-1);
		assert.equal(fork.label, "fork");
		assert.equal(fork.options.resumeSessionAt, first.answer);
		hold.open();
		await second.result();
	});

	it("declines when the main turn is aborted before it answers, and never holds the main stream", async () => {
		const hold = gate();
		const controller = new AbortController();
		scripts.push({ label: "main:pi-abort", onStart: ccRecordsPrompt(historyFor("X").at(-1).content), steps: [{ type: "system", subtype: "init" }, hold.wait, success] });
		const stream = streamSimple(model, { systemPrompt: undefined, messages: historyFor("X"), tools }, { sessionId: "pi-abort", signal: controller.signal });
		await settle();
		const pending = acpRequest("pi-abort").accepted;
		controller.abort();
		hold.open();
		await stream.result();
		assert.deepEqual(await pending, { ok: false, reason: "stale-context" });
		assert.equal(queries.at(-1).label, "main:pi-abort");
	});

	it("does not take the previous query's session for a query whose init has not arrived", async () => {
		const history = historyFor("I");
		const first = await startMain("pi-reinit", history);
		await first.finish();
		const hold = gate();
		scripts.push({ label: "main:pi-reinit:2", steps: [hold.wait, { type: "system", subtype: "init" }, success] });
		const next = [...history, asst([{ type: "text", text: "answer" }]), { role: "user", content: "[m00007] I again", timestamp: clock++ }];
		const second = streamSimple(model, { systemPrompt: undefined, messages: next, tools }, { sessionId: "pi-reinit" });
		await settle();
		assert.deepEqual(await acpRequest("pi-reinit").accepted, { ok: false, reason: "unsupported-context" });
		assert.equal(queries.at(-1).label, "main:pi-reinit:2");
		hold.open();
		await second.result();
	});

	it("declines a main turn that outlasts the wait", async () => {
		__test.setForkAnswerWait({ replyMs: 80, flushMs: 300, pollMs: 10 });
		const slow = await startMain("pi-slow", historyFor("S"));
		const started = Date.now();
		assert.deepEqual(await acpRequest("pi-slow").accepted, { ok: false, reason: "stale-context" });
		assert.ok(Date.now() - started < 2_000);
		assert.equal(queries.at(-1).label, "main:pi-slow");
		await slow.finish();
	});

	describe("at a tool result", () => {
		const ev = (event) => ({ type: "stream_event", event });
		const toolUse = (id) => [
			ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
			ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
			ev({ type: "content_block_stop", index: 0 }),
			ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
			ev({ type: "message_stop" }),
		];

		async function parkOnTool(sid, id) {
			const held = gate();
			const answer = randomUUID();
			const entry = {};
			const prompt = { role: "user", content: `${sid} read a`, timestamp: clock++ };
			scripts.push({
				label: `main:${sid}`,
				onStart: (q) => { entry.mainId = q.options.resume; ccRecordsPrompt(prompt.content)(q); },
				steps: [{ type: "system", subtype: "init" }, ...toolUse(id), held.wait, () => appendRecord(entry.mainId, answerRecord(answer)), answerMessage(answer), success],
			});
			const before = [...historyFor(sid), prompt];
			const first = streamSimple(model, { systemPrompt: undefined, messages: before, tools }, { sessionId: sid });
			await first.result();
			const call = asst([{ type: "toolCall", id, name: "read", arguments: { path: "a" } }], "toolUse");
			const result = { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: clock++ };
			return { mainId: entry.mainId, before, call, result, held, answer };
		}

		it("declines a request that ended on a tool call, with nothing started", async () => {
			const t = await parkOnTool("pi-tooluse", "toolu_0");
			assert.deepEqual(await acpRequest("pi-tooluse").accepted, { ok: false, reason: "unsupported-context" });
			assert.equal(queries.at(-1).label, "main:pi-tooluse");
			const delivery = streamSimple(model, { systemPrompt: undefined, messages: [...t.before, t.call, t.result], tools }, { sessionId: "pi-tooluse" });
			await settle();
			t.held.open();
			await delivery.result();
		});

		it("forks at the answer that follows the delivered tool result", async () => {
			const t = await parkOnTool("pi-tool", "toolu_1");
			const delivery = streamSimple(model, { systemPrompt: undefined, messages: [...t.before, t.call, t.result], tools }, { sessionId: "pi-tool" });
			await settle();
			appendRecord(t.mainId, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file" }] } });
			scripts.push(forkScript());
			const pending = acpRequest("pi-tool").accepted;
			t.held.open();
			await delivery.result();
			assert.equal((await pending).ok, true);
			const fork = queries.at(-1);
			assert.equal(fork.options.resume, t.mainId);
			assert.equal(fork.options.resumeSessionAt, t.answer);
		});

		it("with cutAfterToolResult, forks right after the delivered result while the main turn keeps running, and leaves the main session alone", async () => {
			const t = await parkOnTool("pi-cut", "toolu_c");
			const delivery = streamSimple(model, { systemPrompt: undefined, messages: [...t.before, t.call, t.result], tools }, { sessionId: "pi-cut" });
			await settle();
			const resultUuid = appendRecord(t.mainId, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_c", content: "queued" }] } });
			const attachmentUuid = appendRecord(t.mainId, { type: "attachment", attachment: { type: "date" } });
			const mainBytes = bytesOf(t.mainId);
			scripts.push(forkScript());
			const result = await acpRequest("pi-cut", "toolu_c").accepted;
			assert.deepEqual(result.ok && result.args, { startId: "m00001" }, "the fork finished before the main turn answered");
			const fork = queries.at(-1);
			assert.equal(fork.label, "fork");
			assert.equal(fork.options.resume, t.mainId);
			assert.equal(fork.options.forkSession, true);
			assert.notEqual(fork.options.sessionId, t.mainId);
			assert.equal(fork.options.resumeSessionAt, attachmentUuid, "after the result and the attachment written with it");
			assert.notEqual(resultUuid, attachmentUuid);
			const main = queries.find((q) => q.label === "main:pi-cut");
			assert.equal(main.closed + main.interrupted, 0, "the main query is not stopped or held");
			assert.equal(bytesOf(t.mainId), mainBytes, "the fork never writes the main transcript");
			t.held.open();
			await delivery.result();
		});

		it("with cutAfterToolResult, declines a request that does not deliver that result, and a result that never reaches the transcript", async () => {
			const t = await parkOnTool("pi-cut-other", "toolu_d");
			const delivery = streamSimple(model, { systemPrompt: undefined, messages: [...t.before, t.call, t.result], tools }, { sessionId: "pi-cut-other" });
			await settle();
			assert.deepEqual(await acpRequest("pi-cut-other", "toolu_elsewhere").accepted, { ok: false, reason: "unsupported-context" });
			__test.setForkCutWait({ cutMs: 80, settleMs: 20, pollMs: 10 });
			assert.deepEqual(await acpRequest("pi-cut-other", "toolu_d").accepted, { ok: false, reason: "cut-timeout" }, "the result record was never written");
			assert.equal(queries.at(-1).label, "main:pi-cut-other", "nothing started");
			t.held.open();
			await delivery.result();
		});

		it("refuses when a steer came with the tool result, since its place in the transcript is Claude Code's", async () => {
			const t = await parkOnTool("pi-steer", "toolu_2");
			const steer = { role: "user", content: "also check b", timestamp: clock++ };
			const delivery = streamSimple(model, { systemPrompt: undefined, messages: [...t.before, t.call, t.result, steer], tools }, { sessionId: "pi-steer" });
			await settle();
			appendRecord(t.mainId, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "file" }] } });
			const pending = acpRequest("pi-steer").accepted;
			t.held.open();
			await delivery.result();
			const refused = await pending;
			assert.equal(refused.ok, false);
			assert.ok(["unsupported-context", "stale-context"].includes(refused.reason), refused.reason);
			assert.notEqual(queries.at(-1).label, "fork");
		});
	});

	it("refuses a stale request: the query that served it has finished", async () => {
		const main = await startMain("pi-done", historyFor("D"));
		await main.finish();
		await settle();
		assert.deepEqual(await acpRequest("pi-done").accepted, { ok: false, reason: "stale-context" });
		assert.deepEqual(queries.map((q) => q.label), ["main:pi-done"]);
	});

	it("refuses without spawning anything when strict MCP config is off", async () => {
		__test.setProviderSettings({ strictMcpConfig: false });
		const main = await startMain("pi-loose", historyFor("A"));
		assert.deepEqual(await acpRequest("pi-loose").accepted, { ok: false, reason: "unsafe-config" });
		assert.deepEqual(queries.map((q) => q.label), ["main:pi-loose"]);
		await main.finish();
	});

	it("repeated forks of one request each get their own session, all deleted, the main one kept", async () => {
		const main = await startMain("pi-again", historyFor("R"));
		const mainId = main.query.options.resume;
		const pending = [];
		for (let i = 0; i < 3; i++) {
			scripts.push(forkScript((entry) => { writeFileSync(getSessionPath(entry.options.sessionId, cwd, claudeDir), "{}\n"); }));
			pending.push(acpRequest("pi-again").accepted);
		}
		await main.finish();
		const mainBytes = bytesOf(mainId);
		for (const result of await Promise.all(pending)) assert.equal(result.ok, true);
		const ids = queries.filter((q) => q.label === "fork").map((q) => q.options.sessionId);
		await settle();
		assert.equal(new Set(ids).size, 3);
		for (const id of ids) assert.equal(sessionExists(id), false);
		assert.equal(bytesOf(mainId), mainBytes);
	});

	it("deletes the fork session only after its real CC process exits, and starts none after close", async () => {
		const main = await startMain("pi-proc", historyFor("A"));
		let spawned;
		let spawner;
		let forkId;
		scripts.push(forkScript((entry) => {
			forkId = entry.options.sessionId;
			writeFileSync(getSessionPath(forkId, cwd, claudeDir), "{}\n");
			spawner = entry.options.spawnClaudeCodeProcess;
			spawned = spawner({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 300)"], cwd, env: process.env, signal: new AbortController().signal });
		}));
		const pending = acpRequest("pi-proc").accepted;
		await main.finish();
		const result = await pending;
		assert.equal(result.ok, true);
		await settle();
		assert.equal(spawned.exitCode, null, "the child is still running");
		assert.ok(existsSync(getSessionPath(forkId, cwd, claudeDir)), "its session is kept while it can still write");
		await new Promise((resolve) => spawned.once("exit", resolve));
		await settle();
		assert.equal(existsSync(getSessionPath(forkId, cwd, claudeDir)), false, "deleted once the child exited");
		assert.ok(sessionExists(main.query.options.resume), "the main session is kept");
		assert.throws(() => spawner({ command: process.execPath, args: ["-e", ""], cwd, env: process.env, signal: new AbortController().signal }), /closed/);
	});
});

describe("IsolatedForks usage", () => {
	const ev = (event) => ({ type: "stream_event", event });
	const start = (id, usage) => ev({ type: "message_start", message: { id, usage } });
	const delta = (usage) => ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage });
	const stop = ev({ type: "message_stop" });
	const record = (id, content, output = 3) => ({ type: "assistant", message: { id, content, usage: { input_tokens: 50, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 } } });
	const compress = (input) => ({ type: "tool_use", name: "mcp__custom-tools__compress", input });
	const startUsage = { input_tokens: 50, output_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 };
	const never = () => gate().wait;

	async function fork(steps, { extra = {}, captureTool = "compress", during } = {}) {
		const served = new ServedRequests();
		served.record("pi-a", { id: "m" }, ctxWith("a"), undefined, "/cwd");
		const pulled = [];
		const { deps, log } = fakeDeps((abortController, target) => steps(target, pulled, abortController), { usageWaitMs: 2_000, ...extra });
		const forks = new IsolatedForks(served, deps);
		const r = request({ captureTool });
		const began = Date.now();
		forks.handle(r.data);
		during?.(r);
		const result = await r.accepted[0];
		return { result, ms: Date.now() - began, log, pulled };
	}
	const init = (target) => ({ type: "system", subtype: "init", session_id: target.forkSessionId });
	const after = (pulled, label) => () => { pulled.push(label); };

	it("reports a recorded Claude Code stream's final usage, read no further than its message_delta", async () => {
		const recorded = readFileSync(new URL("./fixtures/sdk-streams/single-tool.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
		const at = recorded.findIndex((m) => m.type === "stream_event" && m.event.type === "message_delta");
		const { result, pulled } = await fork((target, pulled) => recorded.flatMap((m, i) => {
			const step = m.type === "system" && m.subtype === "init" ? { ...m, session_id: target.forkSessionId } : m;
			return i === at ? [step, after(pulled, "past message_delta")] : [step];
		}), { captureTool: "read" });
		assert.equal(recorded[at].event.usage.output_tokens, 106);
		assert.equal(recorded.find((m) => m.type === "assistant" && m.message.content.some((b) => b.type === "tool_use")).message.usage.output_tokens, 3, "the captured record itself carries the start count");
		assert.deepEqual(result, { ok: true, args: { path: "one.txt" }, usage: { input: 10, output: 106, cacheRead: 9410, cacheWrite: 683, complete: true } });
		assert.deepEqual(pulled, [], "nothing after the response's message_delta is read");
	});

	it("follows the captured response through thinking, text and parallel tool records, without adding counts", async () => {
		const { result, pulled } = await fork((target, pulled) => [
			init(target),
			start("msg_A", startUsage),
			record("msg_A", [{ type: "thinking", thinking: "t", signature: "s" }]),
			record("msg_A", [{ type: "text", text: "picking ranges" }]),
			record("msg_A", [{ type: "tool_use", name: "mcp__custom-tools__read", input: { path: "x" } }]),
			record("msg_A", [compress({ startId: "m1" })]),
			{ type: "system", subtype: "thinking_tokens" },
			record("msg_A", [compress({ startId: "m9" })]),
			delta({ input_tokens: 50, output_tokens: 543, cache_read_input_tokens: 1000, cache_creation_input_tokens: 20 }),
			after(pulled, "past message_delta"),
			stop,
		]);
		assert.deepEqual(result, { ok: true, args: { startId: "m1" }, usage: { input: 50, output: 543, cacheRead: 1000, cacheWrite: 20, complete: true } });
		assert.deepEqual(pulled, []);
	});

	it("keeps the start counts a message_delta omits, as the API's output-only delta does", async () => {
		const { result } = await fork((target) => [init(target), start("msg_A", startUsage), record("msg_A", [compress({ startId: "m1" })]), delta({ output_tokens: 543 }), stop]);
		assert.deepEqual(result.usage, { input: 50, output: 543, cacheRead: 1000, cacheWrite: 20, complete: true });
	});

	it("never credits another response's usage to the captured one", async () => {
		const { result } = await fork((target) => [
			init(target),
			start("msg_A", { input_tokens: 5, output_tokens: 1 }),
			record("msg_A", [{ type: "text", text: "no call" }]),
			delta({ output_tokens: 99 }),
			stop,
			start("msg_B", { input_tokens: 7, output_tokens: 2 }),
			record("msg_B", [compress({ startId: "m1" })]),
			delta({ output_tokens: 40 }),
			stop,
		]);
		assert.deepEqual(result.usage, { input: 7, output: 40, cacheRead: 0, cacheWrite: 0, complete: true });
	});

	it("reports the start counts as partial when the response stops without a final usage", async () => {
		const { result, ms } = await fork((target) => [init(target), start("msg_A", startUsage), record("msg_A", [compress({ startId: "m1" })]), delta({}), stop]);
		assert.deepEqual(result, { ok: true, args: { startId: "m1" }, usage: { input: 50, output: 3, cacheRead: 1000, cacheWrite: 20, complete: false } });
		assert.ok(ms < 1_000, `message_stop ends the wait (${ms} ms)`);
	});

	it("ignores counts that are not finite and non-negative", async () => {
		for (const bad of [{ output_tokens: -1 }, { output_tokens: Number.NaN }, { output_tokens: "543" }]) {
			const { result } = await fork((target) => [init(target), start("msg_A", { ...startUsage, cache_read_input_tokens: -5 }), record("msg_A", [compress({ startId: "m1" })]), delta(bad), stop]);
			assert.deepEqual(result.usage, { input: 50, output: 3, cacheRead: 0, cacheWrite: 20, complete: false }, JSON.stringify(bad));
		}
	});

	it("waits a bounded time for a final usage that never comes, then stops the fork", async () => {
		const never = gate();
		const { result, ms, log, pulled } = await fork((target, pulled) => [init(target), start("msg_A", startUsage), record("msg_A", [compress({ startId: "m1" })]), never.wait, after(pulled, "after hang")], { extra: { usageWaitMs: 60 } });
		assert.deepEqual(result, { ok: true, args: { startId: "m1" }, usage: { input: 50, output: 3, cacheRead: 1000, cacheWrite: 20, complete: false } });
		assert.ok(ms >= 50 && ms < 1_500, `bounded by usageWaitMs (${ms} ms)`);
		assert.equal(log.closed, 1);
		assert.equal(log.processClosed, 1);
		assert.ok(log.started[0].abortController.signal.aborted, "the fork's query is aborted");
		assert.deepEqual(pulled, []);
	});

	it("stops waiting for usage when the caller aborts, and reports the fork aborted with partial usage", async () => {
		const never = gate();
		const { result, ms, log } = await fork((target) => [init(target), start("msg_A", startUsage), record("msg_A", [compress({ startId: "m1" })]), never.wait], {
			during: (r) => setTimeout(() => r.controller.abort(), 30),
		});
		assert.deepEqual(result, { ok: false, reason: "aborted", usage: { input: 50, output: 3, cacheRead: 1000, cacheWrite: 20, complete: false } });
		assert.ok(ms < 1_500, `${ms} ms`);
		assert.equal(log.processClosed, 1);
	});

	it("is complete only with a valid input count from the response itself", async () => {
		const bare = (record) => ({ type: "assistant", message: { id: record.message.id, content: record.message.content } });
		const capture = bare(record("msg_A", [compress({ startId: "m1" })]));
		for (const [label, startCounts] of [["cache only", { cache_read_input_tokens: 1000, output_tokens: 3 }], ["NaN input", { input_tokens: Number.NaN, output_tokens: 3 }], ["negative input", { input_tokens: -4, output_tokens: 3 }]]) {
			const { result } = await fork((target) => [init(target), start("msg_A", startCounts), capture, delta({ output_tokens: 543 }), stop]);
			assert.equal(result.usage.complete, false, label);
			assert.equal(result.usage.output, 543, label);
		}
		const { result } = await fork((target) => [init(target), start("msg_A", { cache_read_input_tokens: 1000 }), capture, delta({ input_tokens: 50, output_tokens: 543 }), stop]);
		assert.deepEqual(result.usage, { input: 50, output: 543, cacheRead: 1000, cacheWrite: 0, complete: true }, "a final event's own valid input completes it");
	});

	it("never credits an earlier response's usage to a captured one that reported none", async () => {
		const unidentified = { type: "assistant", message: { content: [{ type: "text", text: "earlier" }], usage: startUsage } };
		const capture = { type: "assistant", message: { id: "msg_B", content: [compress({ startId: "m1" })] } };
		const none = await fork((target) => [init(target), unidentified, start("msg_B", {}), capture, delta({}), stop]);
		assert.deepEqual(none.result, { ok: true, args: { startId: "m1" } });
		const partial = await fork((target) => [init(target), unidentified, start("msg_B", { input_tokens: 7, output_tokens: 2 }), capture, never()], { extra: { usageWaitMs: 50 } });
		assert.deepEqual(partial.result.usage, { input: 7, output: 2, cacheRead: 0, cacheWrite: 0, complete: false });
		const anonymous = await fork((target) => [init(target), unidentified, { type: "assistant", message: { content: [compress({ startId: "m1" })] } }]);
		assert.deepEqual(anonymous.result, { ok: true, args: { startId: "m1" } }, "an unidentified capture gets only its own record's usage");
	});

	it("takes a captured record's own usage as partial, and lets the final event replace it", async () => {
		const { result } = await fork((target) => [init(target), start("msg_B", {}), record("msg_B", [compress({ startId: "m1" })]), delta({ output_tokens: 543 }), stop]);
		assert.deepEqual(result.usage, { input: 50, output: 543, cacheRead: 1000, cacheWrite: 20, complete: true });
	});

	it("leaves usage out instead of reporting zeros when the stream carried none", async () => {
		const { result } = await fork((target) => [init(target), { type: "assistant", message: { id: "msg_A", content: [compress({ startId: "m1" })] } }]);
		assert.deepEqual(result, { ok: true, args: { startId: "m1" } });
	});

	it("stops at a tool result when the captured call carries no id to match it against", async () => {
		const { result, pulled } = await fork((target, pulled) => [
			init(target),
			start("msg_A", startUsage),
			record("msg_A", [compress({ startId: "m1" })]),
			{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "refused", is_error: true }] } },
			after(pulled, "past the tool result"),
			delta({ output_tokens: 543 }),
		]);
		assert.equal(result.usage.complete, false);
		assert.deepEqual(pulled, []);
	});

	const callId = "toolu_captured";
	const captured = (input) => ({ ...compress(input), id: callId });
	const resultOf = (blocks) => ({ type: "user", message: { role: "user", content: blocks } });
	const refusal = (id = callId) => ({ type: "tool_result", tool_use_id: id, content: "Tool execution is disabled in this compression fork.", is_error: true });

	it("reads past the captured call's own refusal to its response's final usage, as live Claude Code orders them", async () => {
		const { result, pulled } = await fork((target, pulled) => [
			init(target),
			start("msg_A", startUsage),
			record("msg_A", [captured({ startId: "m1" })]),
			resultOf([refusal()]),
			delta({ output_tokens: 578 }),
			after(pulled, "past message_delta"),
			stop,
		]);
		assert.deepEqual(result, { ok: true, args: { startId: "m1" }, usage: { input: 50, output: 578, cacheRead: 1000, cacheWrite: 20, complete: true } });
		assert.deepEqual(pulled, []);
	});

	for (const [label, blocks] of [
		["another call's result", [refusal("toolu_other")]],
		["a result that is not a refusal", [{ ...refusal(), is_error: false }]],
		["the refusal next to another call's result", [refusal(), refusal("toolu_other")]],
		["a record with no results", []],
	]) {
		it(`stops at ${label} after the capture`, async () => {
			const { result, pulled } = await fork((target, pulled) => [
				init(target),
				start("msg_A", startUsage),
				record("msg_A", [captured({ startId: "m1" })]),
				resultOf(blocks),
				after(pulled, "past the record"),
				delta({ output_tokens: 578 }),
			]);
			assert.deepEqual(result.usage, { input: 50, output: 3, cacheRead: 1000, cacheWrite: 20, complete: false }, label);
			assert.deepEqual(pulled, [], label);
		});
	}

	it("stops at a new response after the refusal, never crediting its usage to the captured one", async () => {
		const { result, pulled } = await fork((target, pulled) => [
			init(target),
			start("msg_A", startUsage),
			record("msg_A", [captured({ startId: "m1" })]),
			resultOf([refusal()]),
			start("msg_B", { input_tokens: 7, output_tokens: 1 }),
			after(pulled, "past the new response"),
			delta({ output_tokens: 40 }),
		]);
		assert.deepEqual(result.usage, { input: 50, output: 3, cacheRead: 1000, cacheWrite: 20, complete: false });
		assert.deepEqual(pulled, []);
	});

	it("bounds the wait past the refusal by usageWaitMs, without extending it", async () => {
		const { result, ms, log } = await fork((target) => [init(target), start("msg_A", startUsage), record("msg_A", [captured({ startId: "m1" })]), resultOf([refusal()]), never()], { extra: { usageWaitMs: 60 } });
		assert.deepEqual(result, { ok: true, args: { startId: "m1" }, usage: { input: 50, output: 3, cacheRead: 1000, cacheWrite: 20, complete: false } });
		assert.ok(ms >= 50 && ms < 1_500, `bounded by usageWaitMs (${ms} ms)`);
		assert.equal(log.processClosed, 1);
	});

	it("stops waiting past the refusal when the caller aborts", async () => {
		const { result, ms, log } = await fork((target) => [init(target), start("msg_A", startUsage), record("msg_A", [captured({ startId: "m1" })]), resultOf([refusal()]), never()], {
			during: (r) => setTimeout(() => r.controller.abort(), 30),
		});
		assert.deepEqual(result, { ok: false, reason: "aborted", usage: { input: 50, output: 3, cacheRead: 1000, cacheWrite: 20, complete: false } });
		assert.ok(ms < 1_500, `${ms} ms`);
		assert.equal(log.processClosed, 1);
	});
});
