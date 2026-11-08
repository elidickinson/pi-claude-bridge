import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { __test } = await import("../src/index.js");

const model = {
	api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const context = {
	systemPrompt: "You are an advisor.",
	messages: [{ role: "user", content: [{ type: "text", text: "Advise." }], timestamp: 0 }],
};

function recordedResult() {
	const path = new URL("./fixtures/sdk-streams/text.jsonl", import.meta.url);
	const messages = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
	return messages.find((m) => m.type === "result");
}

afterEach(() => __test.setQuery(null));

describe("isolated summary usage", () => {
	it("reports the recorded result usage instead of all-zero usage", async () => {
		const recorded = recordedResult();
		__test.setQuery(() => {
			async function* gen() {
				yield { type: "assistant", message: { content: [{ type: "text", text: recorded.result }] } };
				yield recorded;
			}
			const q = gen();
			q.interrupt = async () => {};
			q.close = () => {};
			return q;
		});
		const result = await __test.isolatedStreamFn(model, context, { cacheRetention: "none" }).result();
		assert.strictEqual(result.stopReason, "stop");
		const usage = recorded.usage;
		assert.deepEqual(
			[result.usage.input, result.usage.output, result.usage.cacheRead, result.usage.cacheWrite],
			[usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens],
		);
		assert.strictEqual(
			result.usage.totalTokens,
			usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
		);
		assert.strictEqual(result.usage.reasoning, usage.output_tokens_details.thinking_tokens);
	});
});
