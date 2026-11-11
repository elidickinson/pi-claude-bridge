/**
 * provider.builtinTools lets Claude Code run some of its own tools (WebSearch,
 * WebFetch) on the provider path, which otherwise runs CC with `tools: []`.
 * CC runs such a call inside the same query; the bridge must leave it alone and
 * keep streaming the turn, exactly as it does for any tool name it doesn't serve.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import activate, { __test } from "../src/index.js";
import { QueryContext } from "../src/query-state.js";

const configPath = () => join(getAgentDir(), "claude-bridge.json");

// The first activation registers the provider; later ones only reload the config.
let providerConfig;

/** Activate the extension with `provider` as its config; returns the registered provider. */
function activateWith(provider) {
	mkdirSync(getAgentDir(), { recursive: true });
	if (provider === undefined) rmSync(configPath(), { force: true });
	else writeFileSync(configPath(), JSON.stringify({ provider }));
	activate({
		on: () => {},
		registerProvider: (_name, config) => { providerConfig = config; },
		registerTool: () => {},
	});
	return providerConfig;
}

async function providerQueryOptions(providerConfig) {
	let captured;
	__test.setQuery(({ options }) => {
		captured = options;
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: options.sessionId ?? options.resume };
			yield { type: "result", subtype: "success", is_error: false, result: "ok" };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
	const model = providerConfig.models.find((m) => m.id === "claude-haiku-4-5");
	await providerConfig.streamSimple(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] },
		{ sessionId: `s-builtin-${Math.random()}` },
	).result();
	return captured;
}

afterEach(() => {
	__test.setQuery(null);
	rmSync(configPath(), { force: true });
});

describe("provider.builtinTools", () => {
	it("gives Claude Code no builtins by default", async () => {
		const options = await providerQueryOptions(activateWith(undefined));
		assert.deepStrictEqual(options.tools, []);
	});

	it("passes the configured builtins to Claude Code's tools", async () => {
		const options = await providerQueryOptions(activateWith({ builtinTools: ["WebSearch", "WebFetch"] }));
		assert.deepStrictEqual(options.tools, ["WebSearch", "WebFetch"]);
	});

	it("ignores a malformed value instead of failing activation", async () => {
		assert.deepStrictEqual((await providerQueryOptions(activateWith({ builtinTools: "WebSearch" }))).tools, []);
		assert.deepStrictEqual((await providerQueryOptions(activateWith({ builtinTools: ["WebSearch", 1, null] }))).tools, ["WebSearch"]);
	});
});

describe("a builtin Claude Code runs itself", () => {
	const fakeModel = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
	const toolMap = new Map([["mcp__custom-tools__bash", "bash"]]);
	const streamEvent = (event) => ({ type: "stream_event", event });

	it("stays out of pi, and the answer after it streams into the same turn", async () => {
		activateWith({ builtinTools: ["WebSearch"] });
		const c = new QueryContext();
		const events = [];
		c.currentPiStream = { push: (e) => events.push(e), end: () => events.push({ type: "end" }) };
		c.resetTurnState(fakeModel);
		const messages = [
			streamEvent({ type: "message_start", message: { id: "msg_search" } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", name: "WebSearch", id: "toolu_search", input: {} } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"pi"}' } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
			streamEvent({ type: "message_stop" }),
			{ type: "user", parent_tool_use_id: null, uuid: "u-search", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_search", content: "results" }] } },
			streamEvent({ type: "message_start", message: { id: "msg_answer" } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Found it." } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_stop" }),
		];
		async function* gen() { for (const m of messages) yield m; }
		await __test.consumeQuery(gen(), toolMap, fakeModel, () => false, c);

		assert.strictEqual(c.turnSawToolCall, false);
		assert.deepStrictEqual(c.turnOutput.content.filter((b) => b.type === "toolCall"), []);
		assert.ok(c.turnOutput.content.some((b) => b.type === "text" && b.text === "Found it."));
		assert.ok(!events.some((e) => e.type === "error"), "CC's own tool_result is not a rejected pi call");
	});
});
