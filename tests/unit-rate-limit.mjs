/**
 * rate_limit_event → pi's onResponse, as the Anthropic API's unified rate-limit headers.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { QueryContext } from "../src/query-state.js";
import { rateLimitResponse } from "../src/rate-limit.js";

const mod = await import("../src/index.js");
const { __test } = mod;

const fixtureModel = {
	api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function fixture(name) {
	const path = new URL(`./fixtures/sdk-streams/${name}.jsonl`, import.meta.url);
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("rateLimitResponse", () => {
	it("names each unified window with Claude Code's header abbreviation", () => {
		const { status, headers } = rateLimitResponse({
			status: "allowed",
			resetsAt: 1789770600,
			rateLimitType: "five_hour",
			unifiedWindows: {
				five_hour: { utilization: 0.14, resetsAt: 1789770600 },
				seven_day: { utilization: 0.01, resetsAt: 1790042400 },
				seven_day_overage_included: { utilization: 0.5, resetsAt: 1790042400 },
			},
		});

		assert.equal(status, 200);
		assert.deepEqual(headers, {
			"anthropic-ratelimit-unified-status": "allowed",
			"anthropic-ratelimit-unified-reset": "1789770600",
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
			"anthropic-ratelimit-unified-5h-utilization": "0.14",
			"anthropic-ratelimit-unified-5h-reset": "1789770600",
			"anthropic-ratelimit-unified-7d-utilization": "0.01",
			"anthropic-ratelimit-unified-7d-reset": "1790042400",
			"anthropic-ratelimit-unified-7d_oi-utilization": "0.5",
			"anthropic-ratelimit-unified-7d_oi-reset": "1790042400",
		});
	});

	it("keeps a window name Claude Code has no abbreviation for", () => {
		const { headers } = rateLimitResponse({ status: "allowed", unifiedWindows: { seven_day_opus: { utilization: 0.3 } } });

		assert.equal(headers["anthropic-ratelimit-unified-seven_day_opus-utilization"], "0.3");
	});

	it("reports a rejection in the headers, not the status code", () => {
		const { status, headers } = rateLimitResponse({
			status: "rejected", rateLimitType: "five_hour", overageStatus: "rejected", overageResetsAt: 1790812800,
		});

		assert.equal(status, 200);
		assert.equal(headers["anthropic-ratelimit-unified-status"], "rejected");
		assert.equal(headers["anthropic-ratelimit-unified-overage-status"], "rejected");
		assert.equal(headers["anthropic-ratelimit-unified-overage-reset"], "1790812800");
	});
});

describe("consumeQuery forwarding rate_limit_event", () => {
	async function replay(messages, onResponse) {
		const c = new QueryContext();
		c.currentPiStream = { push: () => {}, end: () => {} };
		c.currentOnResponse = onResponse;
		c.resetTurnState(fixtureModel);
		async function* stream() { for (const m of messages) yield m; }
		await __test.consumeQuery(stream(), new Map(), fixtureModel, () => false, c);
		return c;
	}

	it("hands every recorded event to the provider call's onResponse", async () => {
		const messages = fixture("text");
		const events = messages.filter((m) => m.type === "rate_limit_event");
		const responses = [];

		await replay(messages, (response, served) => responses.push({ response, served }));

		assert.ok(events.length > 0, "the fixture should carry rate_limit_event frames");
		assert.deepEqual(responses.map((r) => r.response), events.map((e) => rateLimitResponse(e.rate_limit_info)));
		assert.ok(responses.every((r) => r.served === fixtureModel));
	});

	it("finishes the turn when onResponse throws", async () => {
		const c = await replay(fixture("text"), () => { throw new Error("consumer bug"); });

		assert.equal(c.turnOutput.stopReason, "stop");
		assert.equal(c.turnOutput.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim(), "ALPHA");
	});
});

describe("delivery to the provider call that owns the stream", () => {
	let providerConfig;
	mod.default({
		on: () => {},
		registerProvider: (_name, config) => { providerConfig = config; },
		registerTool: () => {},
	});
	const model = providerConfig.models[0];

	const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { wait: () => p, open }; };
	const ev = (event) => ({ type: "stream_event", event });
	const usage = (utilization) => ({
		type: "rate_limit_event",
		rate_limit_info: { status: "allowed", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization, resetsAt: 1789770600 } } },
	});
	const toolUse = (id) => [
		ev({ type: "message_start", message: { id: `msg_${id}`, usage: {} } }),
		ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "mcp__custom-tools__read", input: {} } }),
		ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"a"}' } }),
		ev({ type: "content_block_stop", index: 0 }),
		ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
		ev({ type: "message_stop" }),
	];
	const msgUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const user = { role: "user", content: "read a", timestamp: 0 };
	const call = { role: "assistant", content: [{ type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "a" } }],
		api: "claude-bridge", provider: "claude-bridge", model: "claude-bridge/opus", usage: msgUsage, stopReason: "toolUse", timestamp: 1 };
	const result = { role: "toolResult", toolCallId: "toolu_1", toolName: "read", content: [{ type: "text", text: "file" }], isError: false, timestamp: 2 };

	afterEach(() => __test.setQuery(null));

	const textReply = [
		ev({ type: "message_start", message: { id: "msg_text", usage: {} } }),
		ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
		ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
		ev({ type: "content_block_stop", index: 0 }),
		ev({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }),
		ev({ type: "message_stop" }),
	];
	const drain = async (stream, log) => { for await (const e of stream) log.push(e.type); };
	// Async, like an after_provider_response handler: the report must finish before the next event.
	const reportingTo = (log) => async (r) => {
		await new Promise(setImmediate);
		log.push(`usage ${r.headers["anthropic-ratelimit-unified-5h-utilization"]}`);
	};

	it("reports each event before the next event of the call that owns the stream", async () => {
		const toolDelivered = gate(), usageConsumed = gate();
		__test.setQuery(() => {
			const gen = (async function* () {
				yield { type: "system", subtype: "init", session_id: "cc-rate-limit" };
				yield* toolUse("toolu_1");
				// Claude Code reports usage after message_stop, once the tool call has ended the stream.
				yield usage(0.05);
				yield usage(0.1);
				usageConsumed.open();
				await toolDelivered.wait();
				yield* textReply;
				yield usage(0.2);
				yield { type: "result", subtype: "success", is_error: false, result: "done" };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
		const first = [], second = [];
		const tools = [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }];

		await drain(providerConfig.streamSimple(model, { messages: [user], tools }, { sessionId: "pi-rate-limit", onResponse: reportingTo(first) }), first);
		await usageConsumed.wait();
		const resumed = drain(providerConfig.streamSimple(model, { messages: [user, call, result], tools }, { sessionId: "pi-rate-limit", onResponse: reportingTo(second) }), second);
		toolDelivered.open();
		await resumed;

		assert.ok(!first.some((e) => e.startsWith("usage")), `a call whose stream has ended hears nothing: ${first}`);
		assert.equal(second[0], "usage 0.1", `the latest held event precedes the next call's first event: ${second}`);
		assert.ok(!second.includes("usage 0.05"), `a newer event replaces a held one: ${second}`);
		assert.deepEqual(second.slice(-3), ["text_end", "usage 0.2", "done"], `an event on an open stream precedes its end: ${second}`);
	});
});
