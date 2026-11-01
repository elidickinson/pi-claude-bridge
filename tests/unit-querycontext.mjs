/**
 * Tests for the QueryContext class.
 * Exercises turn-state reset behavior using the real module — no API calls,
 * no extension activation.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const fakeModel = { api: "anthropic", provider: "anthropic", id: "test-model" };

describe("QueryContext class", () => {
	it("turnBlocks throws before resetTurnState", () => {
		assert.throws(() => new QueryContext().turnBlocks, /turnBlocks accessed before resetTurnState/);
	});

	it("turnBlocks reflects turnOutput.content after resetTurnState", () => {
		const c = new QueryContext();
		c.resetTurnState(fakeModel);
		assert.ok(Array.isArray(c.turnBlocks));
		assert.strictEqual(c.turnBlocks.length, 0);

		c.turnBlocks.push({ type: "text", text: "hello" });
		assert.strictEqual(c.turnOutput.content.length, 1);
		assert.strictEqual(c.turnOutput.content[0].text, "hello");
		// Same array reference
		assert.strictEqual(c.turnBlocks, c.turnOutput.content);
	});

	it("resetTurnState preserves turnToolCallIds", () => {
		const c = new QueryContext();
		c.turnToolCallIds = ["id1", "id2"];
		c.resetTurnState(fakeModel);

		assert.deepStrictEqual(c.turnToolCallIds, ["id1", "id2"]);
	});
});
