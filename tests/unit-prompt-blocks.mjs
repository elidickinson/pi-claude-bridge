import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { __test } = await import("../src/index.js");

describe("extractUserPromptBlocks", () => {
	it("keeps images and text from the trailing run of user messages", () => {
		const blocks = __test.extractUserPromptBlocks([
			{ role: "user", content: [
				{ type: "text", text: "describe this" },
				{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
			] },
			{ role: "user", content: "(attachment preview: [#image 1])" },
		]);

		assert.deepEqual(blocks, [
			{ type: "text", text: "describe this" },
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
			{ type: "text", text: "(attachment preview: [#image 1])" },
		]);
	});

	it("does not reach past the current user turn", () => {
		const blocks = __test.extractUserPromptBlocks([
			{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "b2xk" }] },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
			{ role: "user", content: "next turn" },
		]);

		assert.equal(blocks, null);
	});
});
