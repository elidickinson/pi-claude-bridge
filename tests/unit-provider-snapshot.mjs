import { it } from "node:test";
import assert from "node:assert/strict";
import activate, { __test } from "../src/index.js";

// Exercise the provider's real query construction; no Claude subprocess runs.
it("disables prompt snapshots on both initial and resumed provider queries", async () => {
	let provider;
	activate({ on() {}, registerProvider(_name, config) { provider = config; }, registerTool() {} });
	const calls = [];
	__test.resetSharedSession();
	__test.setQuery(({ options }) => {
		calls.push(options);
		const stream = (async function* () {
			yield { type: "system", subtype: "init", session_id: options.resume ?? "snapshot-test-session" };
			yield { type: "result", subtype: "success", is_error: false, result: "ok" };
		})();
		stream.interrupt = async () => {};
		stream.close = () => {};
		return stream;
	});
	try {
		const first = { role: "user", content: "first", timestamp: 1 };
		const reply = await provider.streamSimple(provider.models[0], { messages: [first], tools: [] }, { sessionId: "snapshot-test" }).result();
		assert.notEqual(reply.stopReason, "error");
		const second = await provider.streamSimple(provider.models[0], {
			messages: [first, reply, { role: "user", content: "next", timestamp: 2 }], tools: [],
		}, { sessionId: "snapshot-test" }).result();
		assert.notEqual(second.stopReason, "error");
		assert.equal(calls.length, 2);
		assert.equal(calls[1].resume, "snapshot-test-session");
		for (const { systemPrompt } of calls) {
			assert.equal(systemPrompt.type, "preset");
			assert.equal(systemPrompt.preset, "claude_code");
			assert.equal(systemPrompt.snapshot, false);
		}
	} finally {
		__test.setQuery(null);
		__test.resetSharedSession();
	}
});
