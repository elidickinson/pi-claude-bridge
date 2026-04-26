/**
 * Tests for QueryContext class and context stack infrastructure.
 * Exercises isolation, guards, deferred message merging, and context pinning
 * using the real module — no API calls, no extension activation.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ctx, pushContext, popContext, resetStack, stackDepth } from "../src/query-state.js";

const fakeModel = { api: "anthropic", provider: "anthropic", id: "test-model" };

describe("QueryContext class", () => {
	beforeEach(() => resetStack());

	it("turnBlocks throws before resetTurnState", () => {
		assert.throws(() => ctx().turnBlocks, /turnBlocks accessed before resetTurnState/);
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		ctx().resetTurnState(fakeModel);
		assert.ok(Array.isArray(ctx().turnBlocks));
		assert.strictEqual(ctx().turnBlocks.length, 0);

		ctx().turnBlocks.push({ type: "text", text: "hello" });
		assert.strictEqual(ctx().turnOutput.content.length, 1);
		assert.strictEqual(ctx().turnOutput.content[0].text, "hello");
		// Same array reference
		assert.strictEqual(ctx().turnBlocks, ctx().turnOutput.content);
	});

	it("resetTurnState preserves turnToolCallIds and nextHandlerIdx", () => {
		ctx().turnToolCallIds = ["id1", "id2"];
		ctx().nextHandlerIdx = 5;
		ctx().resetTurnState(fakeModel);

		assert.deepStrictEqual(ctx().turnToolCallIds, ["id1", "id2"]);
		assert.strictEqual(ctx().nextHandlerIdx, 5);
	});
});

describe("context stack guards", () => {
	beforeEach(() => resetStack());

	it("pushContext throws with no active query", () => {
		assert.throws(() => pushContext(), /no active query/);
	});

	it("popContext throws on empty stack", () => {
		assert.throws(() => popContext(), /empty stack/);
	});
});

describe("stack isolation and restore", () => {
	beforeEach(() => resetStack());

	it("push/pop isolates state and restores parent", () => {
		// Parent setup
		ctx().activeQuery = { id: "parent" };
		ctx().pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });
		ctx().latestCursor = 42;
		ctx().deferredUserMessages = ["parent-msg"];

		// Push — child should be clean
		pushContext();
		assert.strictEqual(ctx().activeQuery, null);
		assert.strictEqual(ctx().pendingToolCalls.size, 0);
		assert.strictEqual(ctx().pendingResults.size, 0);
		assert.strictEqual(ctx().latestCursor, 0);
		assert.deepStrictEqual(ctx().deferredUserMessages, []);

		// Mutate child
		ctx().activeQuery = { id: "child" };
		ctx().pendingToolCalls.set("t2", { toolName: "write", resolve: () => {} });
		ctx().latestCursor = 99;

		// Pop — parent restored
		popContext();
		assert.deepStrictEqual(ctx().activeQuery, { id: "parent" });
		assert.strictEqual(ctx().pendingToolCalls.size, 1);
		assert.ok(ctx().pendingToolCalls.has("t1"));
		assert.strictEqual(ctx().latestCursor, 42);
	});

	it("deferred messages merge on pop in FIFO order", () => {
		ctx().activeQuery = { id: "parent" };
		ctx().deferredUserMessages = ["parent-1", "parent-2"];

		pushContext();
		ctx().deferredUserMessages = ["child-1", "child-2"];

		popContext();
		assert.deepStrictEqual(
			ctx().deferredUserMessages,
			["parent-1", "parent-2", "child-1", "child-2"],
		);
	});

	it("triple-nested isolation — each level independent, pop restores", () => {
		// Level 0 (root)
		ctx().activeQuery = { id: "L0" };
		ctx().latestCursor = 10;
		ctx().deferredUserMessages = ["L0-msg"];

		// Level 1
		pushContext();
		assert.strictEqual(stackDepth(), 1);
		ctx().activeQuery = { id: "L1" };
		ctx().latestCursor = 20;
		ctx().deferredUserMessages = ["L1-msg"];

		// Level 2
		pushContext();
		assert.strictEqual(stackDepth(), 2);
		ctx().activeQuery = { id: "L2" };
		ctx().latestCursor = 30;
		ctx().deferredUserMessages = ["L2-msg"];

		// Pop L2 → L1 (L2's deferred merge into L1)
		popContext();
		assert.strictEqual(stackDepth(), 1);
		assert.deepStrictEqual(ctx().activeQuery, { id: "L1" });
		assert.strictEqual(ctx().latestCursor, 20);
		assert.deepStrictEqual(ctx().deferredUserMessages, ["L1-msg", "L2-msg"]);

		// Pop L1 → L0 (L1+L2's deferred merge into L0)
		popContext();
		assert.strictEqual(stackDepth(), 0);
		assert.deepStrictEqual(ctx().activeQuery, { id: "L0" });
		assert.strictEqual(ctx().latestCursor, 10);
		assert.deepStrictEqual(ctx().deferredUserMessages, ["L0-msg", "L1-msg", "L2-msg"]);
	});
});

describe("context pinning (MCP handler closure pattern)", () => {
	beforeEach(() => resetStack());

	it("captured context ref stays valid across push/pop", () => {
		ctx().activeQuery = { id: "parent" };
		ctx().pendingToolCalls.set("t1", { toolName: "read", resolve: () => {} });

		// Simulate handler capturing parent context before push
		const capturedCtx = ctx();

		pushContext();
		// After push, ctx() is the child — but capturedCtx still points to parent
		assert.notStrictEqual(ctx(), capturedCtx);
		assert.strictEqual(capturedCtx.pendingToolCalls.size, 1);
		assert.ok(capturedCtx.pendingToolCalls.has("t1"));

		// Mutate child — captured parent unaffected
		ctx().pendingToolCalls.set("t2", { toolName: "write", resolve: () => {} });
		assert.strictEqual(capturedCtx.pendingToolCalls.size, 1);

		// Pop restores parent as current
		popContext();
		assert.strictEqual(ctx(), capturedCtx);
	});
});
