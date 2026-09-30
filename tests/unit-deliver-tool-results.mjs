/**
 * Unit tests for deliverToolResults — mid-turn steering's ordering guarantee.
 *
 * The steer and the MCP tool result travel back to CC over the same stdin FIFO,
 * so the steer must be written before any handler is released. Get that wrong
 * and nothing throws: the steer silently degrades to follow-up semantics, which
 * only the (slow, API-dependent) integration test would notice.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

/** Records the interleaving of stdin writes and handler releases.
 *
 *  The ack, not the `push` call, is the ordering boundary that matters: the SDK
 *  has only written the steer to stdin once the returned promise settles. So the
 *  recorder logs both, and the assertions key off `ack`. */
function makeRecorder() {
	const order = [];
	return {
		order,
		promptStream(behavior = "ack") {
			return {
				push: (msg) => {
					const label = msg.message.content.map((b) => b.text ?? `[${b.type}]`).join(",");
					order.push(`push:${label}`);
					if (behavior === "reject") {
						return Promise.reject(new Error("prompt stream closed")).catch((e) => {
							order.push("push-rejected");
							throw e;
						});
					}
					// Ack on a later turn of the event loop: resolving synchronously
					// would let a caller that forgot to await it still look correct.
					return new Promise((resolve) => setTimeout(resolve, 5)).then(() => { order.push("ack"); });
				},
			};
		},
		handler(name) {
			return { toolName: name, resolve: () => order.push(`resolve:${name}`) };
		},
	};
}

const steerText = [{ type: "text", text: "actually stop" }];
const result = (toolCallId) => ({ toolCallId, content: [{ type: "text", text: "ok" }] });

beforeEach(() => __test.resetSharedSession());

describe("deliverToolResults", () => {
	it("writes the steer to stdin before releasing any tool result", async () => {
		const rec = makeRecorder();
		const c = new QueryContext();
		c.promptStream = rec.promptStream();
		c.pendingToolCalls.set("call-1", rec.handler("read"));
		c.pendingToolCalls.set("call-2", rec.handler("bash"));

		await __test.deliverToolResults(c, [result("call-1"), result("call-2")], steerText, 4);

		assert.deepStrictEqual(rec.order, ["push:actually stop", "ack", "resolve:read", "resolve:bash"]);
	});

	it("sends the steer with priority next so CC drains it at the tool boundary", async () => {
		const sent = [];
		const c = new QueryContext();
		c.promptStream = { push: (msg) => { sent.push(msg); return Promise.resolve(); } };
		c.pendingToolCalls.set("call-1", { toolName: "read", resolve: () => {} });

		await __test.deliverToolResults(c, [result("call-1")], steerText, 4);

		assert.equal(sent.length, 1);
		assert.equal(sent[0].priority, "next");
		assert.deepStrictEqual(sent[0].message.content, steerText);
	});

	it("keeps image blocks in the steer", async () => {
		const sent = [];
		const c = new QueryContext();
		c.promptStream = { push: (msg) => { sent.push(msg); return Promise.resolve(); } };
		const withImage = [
			{ type: "text", text: "look at this" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
		];

		await __test.deliverToolResults(c, [], withImage, 4);

		assert.deepStrictEqual(sent[0].message.content, withImage);
	});

	it("appends a note to a steer that would look like a slash command to CC", async () => {
		const sent = [];
		const c = new QueryContext();
		c.promptStream = { push: (msg) => { sent.push(msg); return Promise.resolve(); } };
		const path = [{ type: "text", text: "  /var/folders/x/pi-clipboard-1.png" }];

		await __test.deliverToolResults(c, [], path, 4);

		assert.deepStrictEqual(sent[0].message.content, [...path, { type: "text", text: "(Sent while you were working.)" }]);
		assert.deepStrictEqual(path, [{ type: "text", text: "  /var/folders/x/pi-clipboard-1.png" }]);
	});

	it("only folds steers whose last block is slash-prefixed text", () => {
		const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } };
		const path = { type: "text", text: "/tmp/x" };
		for (const blocks of [[], steerText, [{ type: "text", text: "see /tmp/x" }], [path, ...steerText], [path, image], [image]]) {
			assert.strictEqual(__test.foldableSteer(blocks), blocks);
		}
		assert.deepStrictEqual(__test.foldableSteer([image, path]), [image, path, { type: "text", text: "(Sent while you were working.)" }]);
	});

	// The caller has already advanced the session cursor past the steer, so a steer
	// that never reached CC would be skipped forever by count-based sync.
	it("marks the session for rebuild when the push is rejected, and still delivers results", async () => {
		const rec = makeRecorder();
		const c = new QueryContext();
		c.promptStream = rec.promptStream("reject");
		c.pendingToolCalls.set("call-1", rec.handler("read"));
		__test.setSharedSession(null, { sessionId: "abc", cursor: 3, cwd: "/tmp", needsRebuild: false });

		await __test.deliverToolResults(c, [result("call-1")], steerText, 4);

		assert.deepStrictEqual(rec.order, ["push:actually stop", "push-rejected", "resolve:read"]);
		assert.equal(__test.getSharedSession(null).needsRebuild, true);
	});

	it("marks the session for rebuild when there is no prompt stream", async () => {
		const c = new QueryContext();
		c.promptStream = null;
		__test.setSharedSession(null, { sessionId: "abc", cursor: 3, cwd: "/tmp", needsRebuild: false });

		await __test.deliverToolResults(c, [], steerText, 4);

		assert.equal(__test.getSharedSession(null).needsRebuild, true);
	});

	it("queues a result whose handler has not arrived yet", async () => {
		const c = new QueryContext();

		await __test.deliverToolResults(c, [result("call-late")], null, 4);

		assert.equal(c.pendingResults.get("call-late").toolCallId, "call-late");
		assert.equal(c.pendingToolCalls.size, 0);
	});

	it("pairs results to handlers by tool_use id, not arrival order", async () => {
		const rec = makeRecorder();
		const c = new QueryContext();
		c.pendingToolCalls.set("call-1", rec.handler("read"));
		c.pendingToolCalls.set("call-2", rec.handler("bash"));

		await __test.deliverToolResults(c, [result("call-2"), result("call-1")], null, 4);

		assert.deepStrictEqual(rec.order, ["resolve:bash", "resolve:read"]);
	});
});
