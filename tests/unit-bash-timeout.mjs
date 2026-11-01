import { it } from "node:test";
import assert from "node:assert/strict";
import { activateWithMockPi } from "./lib/mock-pi.mjs";

const onToolCall = activateWithMockPi().get("tool_call");
const run = (provider, toolName, input) => {
	onToolCall({ type: "tool_call", toolCallId: "t", toolName, input }, { model: { provider } });
	return input;
};

it("bash runs with a 120s default timeout only under the bridge's models", () => {
	assert.deepEqual(run("claude-bridge", "bash", { command: "ls" }), { command: "ls", timeout: 120 });
	assert.deepEqual(run("claude-bridge", "bash", { command: "ls", timeout: 5 }), { command: "ls", timeout: 5 });
	assert.deepEqual(run("claude-bridge", "read", { path: "a" }), { path: "a" });
	assert.deepEqual(run("anthropic", "bash", { command: "ls" }), { command: "ls" });
});
