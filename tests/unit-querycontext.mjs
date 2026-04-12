/**
 * Tests for QueryContext class and context stack infrastructure.
 * Mirrors the class/helpers from index.ts — exercises isolation, guards,
 * deferred message merging, and context pinning without hitting any API.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

// --- Mirrored QueryContext + stack (same logic as index.ts) ---

class QueryContext {
	activeQuery = null;
	currentPiStream = null;
	latestCursor = 0;
	pendingToolCalls = new Map();
	pendingResults = new Map();
	turnToolCallIds = [];
	nextHandlerIdx = 0;
	deferredUserMessages = [];

	turnOutput = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;

	get turnBlocks() {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	resetTurnState() {
		this.turnOutput = {
			role: "assistant", content: [],
			stopReason: "stop", timestamp: Date.now(),
		};
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
	}
}

let _ctx;
let contextStack;

function resetModule() {
	_ctx = new QueryContext();
	contextStack = [];
}

function ctx() { return _ctx; }

function pushContext() {
	if (!_ctx.activeQuery) throw new Error("pushContext() called with no active query");
	contextStack.push(_ctx);
	_ctx = new QueryContext();
}

function popContext() {
	if (contextStack.length === 0) throw new Error("popContext() called with empty stack");
	const parent = contextStack[contextStack.length - 1];
	parent.deferredUserMessages.push(..._ctx.deferredUserMessages);
	_ctx = contextStack.pop();
}

// --- Tests ---

describe("QueryContext class", () => {
	beforeEach(() => resetModule());

	it("turnBlocks throws before resetTurnState", () => {
		assert.throws(() => ctx().turnBlocks, /turnBlocks accessed before resetTurnState/);
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		ctx().resetTurnState();
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
		ctx().resetTurnState();

		assert.deepStrictEqual(ctx().turnToolCallIds, ["id1", "id2"]);
		assert.strictEqual(ctx().nextHandlerIdx, 5);
	});
});

describe("context stack guards", () => {
	beforeEach(() => resetModule());

	it("pushContext throws with no active query", () => {
		assert.throws(() => pushContext(), /no active query/);
	});

	it("popContext throws on empty stack", () => {
		assert.throws(() => popContext(), /empty stack/);
	});
});

describe("stack isolation and restore", () => {
	beforeEach(() => resetModule());

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
		assert.strictEqual(contextStack.length, 1);
		ctx().activeQuery = { id: "L1" };
		ctx().latestCursor = 20;
		ctx().deferredUserMessages = ["L1-msg"];

		// Level 2
		pushContext();
		assert.strictEqual(contextStack.length, 2);
		ctx().activeQuery = { id: "L2" };
		ctx().latestCursor = 30;
		ctx().deferredUserMessages = ["L2-msg"];

		// Pop L2 → L1 (L2's deferred merge into L1)
		popContext();
		assert.strictEqual(contextStack.length, 1);
		assert.deepStrictEqual(ctx().activeQuery, { id: "L1" });
		assert.strictEqual(ctx().latestCursor, 20);
		assert.deepStrictEqual(ctx().deferredUserMessages, ["L1-msg", "L2-msg"]);

		// Pop L1 → L0 (L1+L2's deferred merge into L0)
		popContext();
		assert.strictEqual(contextStack.length, 0);
		assert.deepStrictEqual(ctx().activeQuery, { id: "L0" });
		assert.strictEqual(ctx().latestCursor, 10);
		assert.deepStrictEqual(ctx().deferredUserMessages, ["L0-msg", "L1-msg", "L2-msg"]);
	});
});

describe("context pinning (MCP handler closure pattern)", () => {
	beforeEach(() => resetModule());

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
