/**
 * pi sends no reasoning level when thinking is off. Claude Code then applied its
 * own default and kept thinking on (issue #152), so the provider path has to
 * ask for thinking: { type: "disabled" } itself.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import activate, { __test } from "../src/index.js";

let providerConfig;
activate({
	on: () => {},
	registerProvider: (_name, config) => { providerConfig = config; },
	registerTool: () => {},
});

async function queryOptionsFor(model, streamOptions) {
	let captured;
	__test.setQuery(({ options }) => {
		captured = options;
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: "cc-thinking" };
			yield { type: "result", subtype: "success", is_error: false, result: "ok" };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
	await providerConfig.streamSimple(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] },
		{ sessionId: `s-thinking-${Math.random()}`, ...streamOptions },
	).result();
	return captured;
}

afterEach(() => __test.setQuery(null));

describe("provider path thinking", () => {
	const haiku = () => providerConfig.models.find((m) => m.id === "claude-haiku-4-5");

	it("disables thinking when thinking is off", async () => {
		assert.ok(haiku(), "claude-haiku-4-5 is registered");
		const options = await queryOptionsFor(haiku(), {});
		assert.deepStrictEqual(options.thinking, { type: "disabled" });
		assert.ok(!("effort" in options));
	});

	it("sends an effort and no thinking override with a reasoning level", async () => {
		const options = await queryOptionsFor(haiku(), { reasoning: "high" });
		assert.ok(!("thinking" in options));
		assert.strictEqual(options.effort, "high");
	});
});
