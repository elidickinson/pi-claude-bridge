import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const harness = createRpcHarness({
	name: "dynamic-tools",
	args: ["--model", "claude-bridge/claude-haiku-4-5", "-e", resolve("tests/fixtures/dynamic-tools-extension.ts"), "--no-context-files", "--no-skills"],
	defaultTimeout: 120_000,
});
const results = [];
harness.addListener((event) => {
	if (event.type === "tool_execution_end") results.push(event);
});
await harness.startAndWait();
try {
	const answer = await harness.promptAndWait(
		"Call enable_probe exactly once, then call the newly enabled dynamic_probe exactly once. Return its verification marker. Complete both calls in this request.",
		120_000,
	);
	assert.deepEqual(results.map((event) => event.toolName), ["enable_probe", "dynamic_probe"]);
	const details = results[1].result.details;
	assert.equal(details.loads, 1);
	assert.equal(details.calls, 1);
	assert.ok(answer.includes(`dynamic-tools-ok:${details.marker}`), answer);
	const debug = readFileSync(harness.DEBUG_LOG, "utf8");
	assert.match(debug, /tool definitions changed under a parked query/);
	assert.doesNotMatch(debug, /BUG:|MCP handlers still waiting|No such tool available/);
	console.log("PASS: activated and called a hidden tool in one prompt, without repeating the loader");
} finally {
	await harness.stop();
}
