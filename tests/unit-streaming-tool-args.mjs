/**
 * Streaming tool call argument parsing (#294): toolCall blocks expose partial
 * arguments on each toolcall_delta as JSON arrives, without leaking raw parser
 * state onto the content block, and still resolve finished/malformed/abandoned
 * tool calls cleanly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const model = { api: "anthropic-messages", provider: "anthropic", id: "test-model" };
const toolMap = new Map([
	["mcp__custom-tools__write", "write"],
	["mcp__custom-tools__bash", "bash"],
	["mcp__custom-tools__read", "read"],
	["mcp__custom-tools__probe", "probe"],
]);

const ev = (event) => ({ type: "stream_event", event });

async function runStream(messages) {
	const snapshots = [];
	const c = new QueryContext();
	c.currentPiStream = {
		push: (e) => {
			if (e.type.startsWith("toolcall_")) {
				const block = e.partial.content[e.contentIndex];
				snapshots.push({
					type: e.type,
					id: block?.id,
					delta: e.delta,
					arguments: structuredClone(block?.arguments),
					argumentsError: block?.argumentsError,
					hasPartialJson: block != null && "partialJson" in block,
				});
			}
		},
		end: () => {},
	};
	c.resetTurnState(model);
	async function* stream() { for (const m of messages) yield m; }
	await __test.consumeQuery(stream(), toolMap, model, () => false, c);
	return { ctx: c, snapshots };
}

describe("streaming tool call arguments", () => {
	it("exposes partial multi-field arguments on every delta including trailing spaces and escapes", async () => {
		const chunks = [
			"",
			'{"path":"src/',
			'app.ts","content":"line 1\\n',
			"line 2 ",
			'end"}',
		];
		const { ctx, snapshots } = await runStream([
			ev({ type: "message_start", message: { id: "msg_write" } }),
			ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_w", name: "mcp__custom-tools__write", input: {} } }),
			...chunks.map((partial_json) => ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } })),
			ev({ type: "content_block_stop", index: 0 }),
			ev({ type: "message_stop" }),
		]);

		const deltas = snapshots.filter((s) => s.type === "toolcall_delta");
		assert.deepEqual(
			deltas.map((s) => s.arguments),
			[
				{},
				{ path: "src/" },
				{ path: "src/app.ts", content: "line 1\n" },
				{ path: "src/app.ts", content: "line 1\nline 2 " },
				{ path: "src/app.ts", content: "line 1\nline 2 end" },
			],
		);
		assert.deepEqual(snapshots.at(-1), {
			type: "toolcall_end",
			id: "toolu_w",
			delta: undefined,
			arguments: { path: "src/app.ts", content: "line 1\nline 2 end" },
			argumentsError: undefined,
			hasPartialJson: false,
		});
		assert.ok(snapshots.every((s) => !s.hasPartialJson));
		assert.equal(ctx.turnToolArgStreams.size, 0);
	});

	it("still replaces streamed arguments with Claude Code's converted assistant block at content_block_stop", async () => {
		const { snapshots } = await runStream([
			ev({ type: "message_start", message: { id: "msg_conv" } }),
			ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_p", name: "mcp__custom-tools__probe", input: {} } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"count":' } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"5"}' } }),
			{
				type: "assistant",
				parent_tool_use_id: null,
				uuid: "u_conv",
				message: {
					id: "msg_conv",
					model: "test-model",
					content: [{ type: "tool_use", id: "toolu_p", name: "mcp__custom-tools__probe", input: { count: 5 } }],
				},
			},
			ev({ type: "content_block_stop", index: 0 }),
			ev({ type: "message_stop" }),
		]);

		const deltas = snapshots.filter((s) => s.type === "toolcall_delta");
		assert.deepEqual(deltas.map((s) => s.arguments), [{}, { count: "5" }]);
		const end = snapshots.find((s) => s.type === "toolcall_end");
		assert.deepEqual(end?.arguments, { count: 5 });
		assert.equal(end?.argumentsError, undefined);
	});

	it("drops a truncated prefix and records argumentsError if content_block_stop fires without CC's assistant block", async () => {
		const { snapshots } = await runStream([
			ev({ type: "message_start", message: { id: "msg_bad" } }),
			ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_b", name: "mcp__custom-tools__bash", input: {} } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"rm -rf /tmp/foo' } }),
			ev({ type: "content_block_stop", index: 0 }),
			ev({ type: "message_stop" }),
		]);

		assert.deepEqual(snapshots.find((s) => s.type === "toolcall_delta")?.arguments, { command: "rm -rf /tmp/foo" });
		const end = snapshots.find((s) => s.type === "toolcall_end");
		assert.deepEqual(end?.arguments, {}, "must not execute a truncated partial command");
		assert.match(end?.argumentsError ?? "", /Received arguments:/);
	});

	it("keeps arguments as an object when non-object JSON is streamed", async () => {
		for (const raw of ["[1, 2]", "123", '"hello"', "null"]) {
			const { snapshots } = await runStream([
				ev({ type: "message_start", message: { id: `msg_${raw}` } }),
				ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_nonobj", name: "mcp__custom-tools__probe", input: {} } }),
				ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: raw } }),
				ev({ type: "content_block_stop", index: 0 }),
				ev({ type: "message_stop" }),
			]);

			const delta = snapshots.find((s) => s.type === "toolcall_delta");
			assert.deepEqual(delta?.arguments, {}, `non-object delta ${raw} must surface as {}`);
			const end = snapshots.find((s) => s.type === "toolcall_end");
			assert.deepEqual(end?.arguments, {});
			assert.match(end?.argumentsError ?? "", /must be a JSON object/);
		}
	});

	it("maps aliased keys on fallback stop and preserves prefilled input when deltas are empty", async () => {
		const aliased = await runStream([
			ev({ type: "message_start", message: { id: "msg_alias" } }),
			ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_a", name: "mcp__custom-tools__read", input: {} } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path":"a.txt"}' } }),
			ev({ type: "content_block_stop", index: 0 }),
			ev({ type: "message_stop" }),
		]);
		assert.deepEqual(aliased.snapshots.find((s) => s.type === "toolcall_end")?.arguments, { path: "a.txt" });

		const prefilled = await runStream([
			ev({ type: "message_start", message: { id: "msg_prefill" } }),
			ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_pre", name: "mcp__custom-tools__read", input: { file_path: "pre.txt" } } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "" } }),
			ev({ type: "content_block_stop", index: 0 }),
			ev({ type: "message_stop" }),
		]);
		assert.deepEqual(prefilled.snapshots.find((s) => s.type === "toolcall_delta")?.arguments, { file_path: "pre.txt" });
		assert.deepEqual(prefilled.snapshots.find((s) => s.type === "toolcall_end")?.arguments, { path: "pre.txt" });
	});

	it("clears parser state when an open or unfinished tool call is dropped before retry", async () => {
		const { ctx, snapshots } = await runStream([
			// Stalled stream abandoned by a fresh message_start while still open.
			ev({ type: "message_start", message: { id: "msg_stalled" } }),
			ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "mcp__custom-tools__bash", input: {} } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"stalled' } }),
			// Cut stream closed by message_stop without content_block_stop.
			ev({ type: "message_start", message: { id: "msg_cut" } }),
			ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_2", name: "mcp__custom-tools__bash", input: {} } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"cut' } }),
			ev({ type: "message_stop" }),
			// Resumed call reuses index 0 and succeeds.
			ev({ type: "message_start", message: { id: "msg_ok" } }),
			ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_3", name: "mcp__custom-tools__bash", input: {} } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"echo ' } }),
			ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ok"}' } }),
			ev({ type: "content_block_stop", index: 0 }),
			ev({ type: "message_stop" }),
		]);

		const okEvents = snapshots.filter((s) => s.id === "toolu_3");
		assert.deepEqual(
			okEvents.filter((s) => s.type === "toolcall_delta").map((s) => s.arguments),
			[{ command: "echo " }, { command: "echo ok" }],
		);
		assert.deepEqual(okEvents.find((s) => s.type === "toolcall_end")?.arguments, { command: "echo ok" });
		assert.equal(ctx.turnToolArgStreams.size, 0);
	});
});
