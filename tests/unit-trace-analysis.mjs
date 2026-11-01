/**
 * diag/lib/trace-analysis.mjs must rediscover known cache failures from request
 * shape alone, keep wire-only differences apart from cache loss, catch stale
 * history however warm the cache is, and report what it cannot link instead of
 * passing it.
 */
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { cacheObservation, checkPreservation, checkPropagation, configChanges, isMessages, linkCalls, loadCapture, traceTransitions } from "../diag/lib/trace-analysis.mjs";

const system = [{ type: "text", text: "x-anthropic-billing-header: cch=1" }, { type: "text", text: "You are Claude Code." }];
const tools = [{ name: "mcp__custom-tools__read", input_schema: { type: "object" } }];
const body = (messages) => ({ model: "m", system, tools, messages });
const ask = { role: "user", content: [{ type: "text", text: "read a" }] };
const call = { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "toolu_1", name: "mcp__custom-tools__read", input: { path: "a" } }] };
const result = (fields) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "A" }], cache_control: { type: "ephemeral" }, ...fields }] });
const next = { role: "user", content: [{ type: "text", text: "continue" }] };

describe("trace analysis", () => {
	it("finds a tool_result content shape change and its measured cache shortfall", () => {
		const seed = body([ask, call, result()]);
		const resumed = body([ask, call, result({ content: "A" }), next]);
		const preservation = checkPreservation(seed, resumed);
		assert.deepEqual(preservation.normalized.map((d) => d.signature), ["messages>user>tool_result.content type-or-shape array->string"]);
		assert.equal(preservation.firstChange.label, "message 2 of 3");
		assert.equal(preservation.normalized[0].beforeAncestorBreakpoint, true);
		const cache = cacheObservation({ usage: { cacheRead: 7811, cacheWrite: 103 } }, { usage: { cacheRead: 7811, cacheWrite: 200 } });
		assert.deepEqual([cache.status, cache.shortfall], ["shortfall", 103]);
	});

	it("records a key-order change without calling it cache loss when the cache covered the prefix", () => {
		const seed = body([ask, call, result()]);
		const block = seed.messages[2].content[0];
		const reordered = body([ask, call, { role: "user", content: [{ tool_use_id: block.tool_use_id, type: block.type, content: block.content }] }, next]);
		assert.deepEqual(checkPreservation(seed, reordered).normalized.map((d) => d.signature), ["messages>user>tool_result key-order"]);
		assert.equal(cacheObservation({ usage: { cacheRead: 7811, cacheWrite: 103 } }, { usage: { cacheRead: 7914, cacheWrite: 50 } }).status, "covered");
	});

	it("places a difference inside or past the ancestor's cache breakpoint by block", () => {
		// The marker sits on block 0 of the last message; block 1 was never cached.
		const seed = body([ask, call, { role: "user", content: [{ type: "text", text: "a", cache_control: { type: "ephemeral" } }, { type: "text", text: "b" }] }]);
		const later = body([ask, call, { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "B" }] }, next]);
		assert.deepEqual(checkPreservation(seed, later).normalized.map((d) => d.beforeAncestorBreakpoint), [false]);
	});

	it("places messages inserted ahead of the ancestor's cache breakpoint inside its cached region", () => {
		// Ancestor's marker is on message 1; the new request inserts two messages
		// before it, so in its own numbering the insertions sit at 1 and 2.
		const marked = { ...call, content: [call.content[0], { ...call.content[1], cache_control: { type: "ephemeral" } }] };
		const plain = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "A" }] }] };
		const extra = (t) => ({ role: "user", content: [{ type: "text", text: t }] });
		const p = checkPreservation(body([ask, marked, plain]), body([ask, extra("one"), extra("two"), call, plain, next]));
		const added = p.normalized.filter((d) => !d.path);
		assert.ok(added.length === 2 && added.every((d) => d.beforeAncestorBreakpoint === true), JSON.stringify(p.normalized));
	});

	it("re-labels an ancestor message reported missing that is present further on", () => {
		// The real rebuild layout (Haiku 5.5): reminders leave the front, the system
		// reminder message empties, the tool result flattens, the environment returns
		// at the end.
		const front = { role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }, { type: "text", text: "read a" }] };
		const env = (cc) => ({ role: "system", content: [{ type: "text", text: "# Environment cwd=/x", ...(cc ? { cache_control: { type: "ephemeral" } } : {}) }] });
		const use = { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "x", input: {} }] };
		const blocks = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "A\n" }] }] };
		const flat = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "A" }] };
		const countdown = { role: "system", content: [{ type: "text", text: "<total_tokens>9 left</total_tokens>", cache_control: { type: "ephemeral" } }] };
		const before = body([front, { role: "system", content: "# Environment cwd=/x" }, use, blocks, countdown]);
		const after = body([{ role: "user", content: "read a" }, { role: "system", content: [] }, use, flat, { role: "assistant", content: [{ type: "text", text: "A it is" }] },
			{ role: "user", content: [{ type: "text", text: "<system-reminder>ctx</system-reminder>" }, { type: "text", text: "next" }] }, env(true)]);
		const kinds = checkPreservation(before, after).normalized.map((d) => d.signature);
		assert.ok(!kinds.some((k) => k.startsWith("missing-element") && k.includes("tool_result")), JSON.stringify(kinds));
	});

	it("loads a capture whose last line was cut off, and says so", () => {
		const dir = mkdtempSync(join(tmpdir(), "ta-cut-"));
		writeFileSync(join(dir, "index.jsonl"), `${JSON.stringify({ n: 1, path: "/v1/messages", status: 200 })}\n{"n":2,"pa`);
		const capture = loadCapture(dir);
		assert.deepEqual([capture.requests.length, capture.unparsedLines, capture.requests[0].bodyMissing], [1, 1, "absent"]);
	});

	it("gives a call with no pi session id no ancestor", () => {
		const input = (callId, seq, messages) => ({ type: "input", callId, seq, piSessionId: null, effective: "source", source: { messages } });
		const trace = { events: [
			input("x1", 1, [{ digest: "u" }]), { type: "query-start", queryId: "q1", callId: "x1", kind: "provider", piSessionId: null, seq: 2 },
			input("x2", 3, [{ digest: "u" }, { digest: "a" }, { digest: "v" }]), { type: "query-start", queryId: "q2", callId: "x2", kind: "provider", piSessionId: null, seq: 4 },
		], artifact: () => null };
		const capture = { requests: ["q1", "q2"].map((route, i) => ({ n: i + 1, route, path: "/v1/messages", status: 200, usage: null, body: body([ask]) })) };
		assert.deepEqual(traceTransitions(linkCalls(capture, trace).calls), []);
	});

	it("says when a shortfall comes after the ancestor's requested TTL", () => {
		const ancestor = { n: 1, at: "2026-10-21T10:00:00Z", usage: { cacheRead: 100, cacheWrite: 900 }, body: body([result()]) };
		const late = { n: 2, startedAt: "2026-10-21T10:06:00Z", usage: { cacheRead: 100, cacheWrite: 900 } };
		assert.deepEqual([cacheObservation(ancestor, late).status, cacheObservation(ancestor, late).ttlSeconds], ["shortfall-past-ttl", 300]);
	});

	it("does not call a read covered when the ancestor cached nothing", () => {
		assert.equal(cacheObservation({ usage: { cacheRead: 0, cacheWrite: 0 } }, { usage: { cacheRead: 0, cacheWrite: 0 } }).status, "ancestor-cached-nothing");
	});

	it("reports top-level request changes outside the prompt", () => {
		const a = { ...body([ask]), thinking: { type: "enabled" } };
		assert.deepEqual(configChanges(a, { ...a, thinking: { type: "disabled" } }).map((c) => c.key), ["thinking"]);
		assert.deepEqual(configChanges(a, { ...a, messages: [ask, next] }), []);
		const d = { ...a, diagnostics: { previous_message_id: "msg_1" } };
		assert.deepEqual(configChanges(d, { ...d, diagnostics: { previous_message_id: "msg_2" } }), []);
		assert.deepEqual(configChanges(d, { ...d, diagnostics: { previous_message_id: "msg_2", other: 1 } }).map((c) => c.key), ["diagnostics"]);
	});

	it("measures the cache on a call's first attempt, not a retry that read what it wrote", () => {
		const input = (callId, seq, messages) => ({ type: "input", callId, seq, piSessionId: "s", effective: "source", source: { messages } });
		const trace = {
			events: [
				input("c1", 1, [{ digest: "u" }]), { type: "query-start", queryId: "q1", callId: "c1", kind: "provider", piSessionId: "s", seq: 2 },
				input("c2", 3, [{ digest: "u" }, { digest: "a" }, { digest: "v" }]), { type: "query-start", queryId: "q2", callId: "c2", kind: "provider", piSessionId: "s", seq: 4 },
			],
			artifact: () => null,
		};
		const second = body([ask, call, result()]);
		const capture = { requests: [
			{ n: 1, route: "q1", path: "/v1/messages", status: 200, usage: { cacheRead: 4000, cacheWrite: 1000 }, body: body([ask]) },
			{ n: 2, route: "q2", path: "/v1/messages", status: 200, terminal: "upstream-error", usage: { cacheRead: 4000, cacheWrite: 1500 }, body: second },
			{ n: 3, route: "q2", path: "/v1/messages", status: 200, usage: { cacheRead: 5500, cacheWrite: 10 }, body: second },
		] };
		const [t] = traceTransitions(linkCalls(capture, trace).calls);
		assert.deepEqual(t.to.attempts.map((a) => a.n), [2, 3]);
		assert.deepEqual([t.cache.request, t.cache.status, t.cache.shortfall], [2, "shortfall", 1000]);
	});

	it("does not flag moved cache_control or the billing header", () => {
		const seed = body([ask, call, result()]);
		const { cache_control: _, ...unmarked } = result().content[0];
		const moved = body([ask, call, { role: "user", content: [unmarked] }, { role: "user", content: [{ type: "text", text: "continue", cache_control: { type: "ephemeral" } }] }]);
		moved.system = [{ type: "text", text: "x-anthropic-billing-header: cch=2" }, system[1]];
		assert.equal(checkPreservation(seed, moved).status, "preserved");
	});

	it("catches pi history that never reached the request, however warm the cache", () => {
		const pi = [
			{ role: "user", content: "the code is SECRET-1234" },
			{ role: "assistant", content: [{ type: "text", text: "noted" }], provider: "claude-bridge" },
			{ role: "user", content: "what now" },
		];
		const wire = body([{ role: "user", content: "the code is SECRET-1234" }, { role: "assistant", content: [{ type: "text", text: "noted" }] }, { role: "user", content: "what now" }]);
		assert.equal(checkPropagation(pi, wire).status, "checked");

		const redacted = [{ ...pi[0], content: "the code is XXXXXX-XXXX" }, pi[1], pi[2]];
		const stale = checkPropagation(redacted, wire);
		assert.equal(stale.status, "stale-or-missing");
		assert.deepEqual(stale.missing.map((m) => [m.role, m.kind, m.piMessage]), [["user", "text", 0]]);
	});

	it("accepts a steer inside the tool result it was drained with, and nothing else inside tool results", () => {
		const served = { read: "mcp__custom-tools__read" };
		const toolCall = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }] };
		const toolResult = { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "file says yes" }], isError: false };
		const wire = body([{ role: "user", content: "go" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__custom-tools__read", input: {} }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file says yes" }, { type: "text", text: "<system-reminder>also PAPAYA</system-reminder>" }] }] }]);
		const steered = checkPropagation([{ role: "user", content: "go" }, toolCall, toolResult, { role: "user", content: "also PAPAYA" }], wire, served);
		assert.deepEqual([steered.status, steered.steerContained], ["checked-contained", 1]);
		// Haiku 5.5 delivers it as a system message after the results instead.
		const asSystem = body([wire.messages[0], wire.messages[1], { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file says yes" }] },
			{ role: "system", content: [{ type: "text", text: "The user sent a new message while you were working:\nalso PAPAYA" }] }]);
		assert.equal(checkPropagation([{ role: "user", content: "go" }, toolCall, toolResult, { role: "user", content: "also PAPAYA" }], asSystem, served).steerContained, 1);
		// "yes" was dropped from the request; that a tool result happens to contain it proves nothing.
		const dropped = checkPropagation([{ role: "user", content: "yes" }, toolCall, toolResult], wire, served);
		assert.deepEqual(dropped.missing.map((m) => m.piMessage), [0]);
	});

	it("does not accept stale or truncated content as delivered with additions", () => {
		const pi = [{ role: "user", content: "read notes.txt" }];
		assert.equal(checkPropagation(pi, body([{ role: "user", content: [{ type: "text", text: "read notes.txt REMOVE_ME" }] }])).status, "stale-or-missing");
		assert.equal(checkPropagation(pi, body([{ role: "user", content: [{ type: "text", text: "read notes.txt\n<system-reminder>x</system-reminder>" }] }])).status, "checked-contained");
	});

	it("reports nothing compared, ambiguous ids and unrecorded tool names instead of passing", () => {
		assert.equal(checkPropagation([{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }], body([ask])).status, "nothing-compared");
		const dup = [{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }, { type: "toolCall", id: "t1", name: "read", arguments: {} }] }];
		assert.equal(checkPropagation(dup, body([call]), { read: "mcp__custom-tools__read" }).status, "ambiguous-ids");
		assert.deepEqual(checkPropagation(dup.map((m) => ({ ...m, content: [m.content[0]] })), body([call])).unsupported, ["tool-name-unrecorded/read"]);
	});

	it("counts only /v1/messages itself as a conversation request", () => {
		assert.deepEqual(["/v1/messages?beta=true", "/v1/messages/count_tokens?beta=true"].map((path) => isMessages({ path })), [true, false]);
	});

	it("checks tool identity, arguments and results by id through the recorded name map", () => {
		const pi = [
			{ role: "user", content: "read a" },
			{ role: "assistant", content: [{ type: "toolCall", id: "call|1", name: "Read", arguments: { path: "a" } }] },
			{ role: "toolResult", toolCallId: "call|1", toolName: "Read", content: [{ type: "text", text: "A" }], isError: false },
		];
		const wire = (input, content = "A") => body([
			{ role: "user", content: "read a" },
			{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "mcp__custom-tools__Read", input }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content }] },
		]);
		const served = { Read: "mcp__custom-tools__Read" };
		assert.equal(checkPropagation(pi, wire({ path: "a" }), served).status, "checked");
		// Live CC pads an MCP result and appends a reminder block: present, but not exact.
		const padded = [{ type: "text", text: "A\n" }, { type: "text", text: "<system-reminder>x</system-reminder>" }];
		assert.equal(checkPropagation(pi, wire({ path: "a" }, padded), served).status, "checked-contained");
		const added = checkPropagation(pi, wire({ path: "a", timeout: 120 }), served);
		assert.deepEqual(added.changed.map((c) => [c.kind, c.fields]), [["tool_use", ["input"]]]);
	});

	it("never takes another pi session's call as an ancestor, even with identical history", () => {
		const input = (callId, seq, piSessionId, messages) => ({ type: "input", callId, seq, piSessionId, effective: "source", source: { messages } });
		const start = (queryId, callId, seq, piSessionId) => ({ type: "query-start", queryId, callId, kind: "provider", piSessionId, seq });
		const trace = {
			events: [
				input("a1", 1, "A", [{ digest: "u" }]), start("qa1", "a1", 2, "A"),
				input("b1", 3, "B", [{ digest: "u" }]), start("qb1", "b1", 4, "B"),
				input("b2", 5, "B", [{ digest: "u" }, { digest: "x" }, { digest: "v" }]), start("qb2", "b2", 6, "B"),
			],
			artifact: () => null,
		};
		const capture = { requests: ["qa1", "qb1", "qb2"].map((route, i) => ({ n: i + 1, route, path: "/v1/messages", status: 200, usage: null, body: body([ask]) })) };
		const transitions = traceTransitions(linkCalls(capture, trace).calls);
		assert.deepEqual(transitions.map((t) => [t.from.callId, t.to.callId]), [["b1", "b2"]]);
	});

	it("leaves a continuation it cannot anchor unlinked rather than guessing", () => {
		const input = (callId, messages) => ({ type: "input", callId, seq: callId === "c1" ? 1 : 3, piSessionId: "s", effective: "source", source: { messages, artifact: undefined } });
		const trace = {
			events: [
				input("c1", [{ digest: "u1" }]),
				{ type: "decision", callId: "c1", path: "clean-start", reason: "no-priors" },
				{ type: "query-start", queryId: "q1", callId: "c1", kind: "provider", piSessionId: "s", seq: 2 },
				input("c2", [{ digest: "u1" }, { digest: "a1" }, { digest: "r1" }]),
				{ type: "route", route: "tool-result", callId: "c2", queryId: "q1", results: ["toolu_9"] },
			],
			artifact: () => null,
		};
		const capture = { requests: [
			{ n: 1, route: "q1", path: "/v1/messages", status: 200, usage: null, body: body([ask]) },
			{ n: 2, route: "q1", path: "/v1/messages", status: 200, usage: null, body: body([ask, call, result()]) },
		] };
		const { calls, unattributed } = linkCalls(capture, trace);
		assert.deepEqual(calls.map((c) => [c.callId, c.link, c.request?.n ?? null]), [["c1", "first-in-route-unverified", 1], ["c2", "unlinked", null]]);
		assert.deepEqual(unattributed.map((u) => u.n), [2]);
		const [t] = traceTransitions(calls, trace);
		assert.deepEqual([t.source.relation, t.validity, t.preservation.status, t.propagation.status], ["append", "unattributed-request", "not-checked", "incomplete"]);
	});
});
