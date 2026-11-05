#!/usr/bin/env node
// Context continuity test for pi-claude-bridge provider.
// Verifies that switching away from the provider and back correctly
// preserves conversation context through native-prefix retention and suffix import.
//
// Requires: pi CLI, Claude Code (for Agent SDK subprocess).
// Requires: CLAUDE_BRIDGE_TESTING_ALT_PROVIDER (e.g. "minimax")
// Requires: CLAUDE_BRIDGE_TESTING_ALT_MODEL (e.g. "MiniMax-M2.7-highspeed")

console.log("=== session-resume-test.mjs ===");

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness, requireEnv } from "./lib/rpc-harness.mjs";

const OTHER_PROVIDER = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_PROVIDER");
const OTHER_MODEL = requireEnv("CLAUDE_BRIDGE_TESTING_ALT_MODEL");

const TIMEOUT = 180_000;
const BRIDGE_MODEL = "claude-bridge/claude-haiku-4-5";

// Random words to avoid Claude memorizing test values across runs
const WORD_A = `alpha${Math.random().toString(36).slice(2, 6)}`;
const WORD_B = `beta${Math.random().toString(36).slice(2, 6)}`;
const WORD_C = `gamma${Math.random().toString(36).slice(2, 6)}`;

const TEST_CWD_PREFIX = join(tmpdir(), "pi-claude-bridge-session-resume-");
const TEST_CWD = mkdtempSync(TEST_CWD_PREFIX);

// Use harness but with custom args - start on non-provider model
const harness = createRpcHarness({
	name: "session-resume",
	args: ["--model", `${OTHER_PROVIDER}/${OTHER_MODEL}`],
	cwd: TEST_CWD,
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, send, promptAndWait, waitForEvent, waitForMatch, DEBUG_LOG, RPC_LOG } = harness;

function latestSync() {
	const last = [...readFileSync(DEBUG_LOG, "utf8").matchAll(/syncResult: path=([a-z-]+) sessionId=([a-f0-9-]+)/g)].at(-1);
	if (!last) throw new Error("no syncResult session marker found");
	return { path: last[1], sessionId: last[2] };
}

// Start pi
await startAndWait();

try {
  // Turn 1: Non-provider prompt — establishes context before our provider is used
  console.log("Turn 1: Non-provider prompt (establish context)...");
  const text1 = await promptAndWait(`The first word is '${WORD_A}'. Acknowledge and be very brief.`);
  if (!text1) throw new Error("Turn 1 produced no text");
  console.log(`  Response: ${text1.slice(0, 80)}`);

  // Switch to provider — first provider turn with prior history (Case 2)
  const [bridgeProvider, bridgeModelId] = BRIDGE_MODEL.split("/");
  console.log(`Switching to ${BRIDGE_MODEL}...`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });


  // Turn 2: First provider turn — should see WORD_A from prior non-provider history
  console.log("Turn 2: First provider turn with prior history (Case 2)...");
  const text2 = await promptAndWait(
    `The second word is '${WORD_B}'. Also, what was the first word? Reply with both words separated by a comma.`
  );
  console.log(`  Response: ${text2.slice(0, 80)}`);
  const lower2 = text2.toLowerCase();
  if (!lower2.includes(WORD_A)) throw new Error(`Turn 2 response missing '${WORD_A}': ${text2}`);
  if (!lower2.includes(WORD_B)) throw new Error(`Turn 2 response missing '${WORD_B}': ${text2}`);
  const firstProviderSession = latestSync().sessionId;

  // Turn 3: Non-provider prompt — adds context that provider must see on switch-back
  console.log(`Switching to ${OTHER_PROVIDER}/${OTHER_MODEL}...`);
  await send({ type: "set_model", provider: OTHER_PROVIDER, modelId: OTHER_MODEL });
  console.log("Turn 3: Non-provider prompt (creates missed messages)...");
  const text3 = await promptAndWait(`The third word is '${WORD_C}'. Acknowledge and be very brief.`);
  if (!text3) throw new Error("Turn 3 produced no text");
  console.log(`  Response: ${text3.slice(0, 80)}`);

  // Switch back to provider with the intervening non-provider turn.
  console.log(`Switching back to ${BRIDGE_MODEL}...`);
  await send({ type: "set_model", provider: bridgeProvider, modelId: bridgeModelId });


  // Turn 4: retain the native prefix and import the new non-provider history.
  console.log("Turn 4: Provider continuation after non-provider turns...");
  const text4 = await promptAndWait(
    "What were all three words? Reply with just the three words separated by commas."
  );
  console.log(`  Response: ${text4.slice(0, 80)}`);
  const lower4 = text4.toLowerCase();
  if (!lower4.includes(WORD_A)) throw new Error(`Turn 4 response missing '${WORD_A}': ${text4}`);
  if (!lower4.includes(WORD_B)) throw new Error(`Turn 4 response missing '${WORD_B}': ${text4}`);
  if (!lower4.includes(WORD_C)) throw new Error(`Turn 4 response missing '${WORD_C}': ${text4}`);
  const continued = latestSync();
  if (continued.path !== "prefix-write") throw new Error(`expected prefix-write after foreign turns, got ${continued.path}`);
  if (continued.sessionId === firstProviderSession) throw new Error("foreign turns overwrote the ancestor session");

  // Turn 5: abort observed streaming, not a timer that may outlast the reply.
  console.log("Turn 5: Abort mid-stream (session recovery)...");
  const streaming = waitForMatch((m) => m.type === "message_update" && m.assistantMessageEvent?.type === "text_delta", "streamed text", TIMEOUT);
  const idle5 = waitForEvent("agent_end", TIMEOUT);
  await send({ type: "prompt", message: "Write a detailed 4,000-word essay about the history of timekeeping." });
  await streaming;
  await send({ type: "abort" });
  await idle5;


  // Turn 6: Provider turn after abort — should NOT get "conversation not found"
  console.log("Turn 6: Provider turn after abort (should recover)...");
  const text6 = await promptAndWait(
    "What were all three words? Reply with just the three words separated by commas."
  );
  console.log(`  Response: ${text6.slice(0, 80)}`);
  const lower6 = text6.toLowerCase();
  if (!lower6.includes(WORD_A)) throw new Error(`Turn 6 response missing '${WORD_A}': ${text6}`);
  if (!lower6.includes(WORD_B)) throw new Error(`Turn 6 response missing '${WORD_B}': ${text6}`);
  if (!lower6.includes(WORD_C)) throw new Error(`Turn 6 response missing '${WORD_C}': ${text6}`);

  const recovered = latestSync();
  if (!["fork", "prefix-write"].includes(recovered.path)) throw new Error(`expected a retained-prefix recovery, got ${recovered.path}`);
  if (recovered.sessionId === continued.sessionId) throw new Error("abort recovery reused the interrupted transcript");
  console.log(`  Recovery: ${recovered.path} into a new session`);

  console.log("PASS");
} catch (e) {
  process.exitCode = 1;
  console.log(`FAIL: ${e.message}\n${e.stack}`);
  console.log(`  RPC log:    ${RPC_LOG}`);
  console.log(`  Debug log:  ${DEBUG_LOG}`);
} finally {
  await stop();
  if (TEST_CWD.startsWith(TEST_CWD_PREFIX) && TEST_CWD.length > TEST_CWD_PREFIX.length) {
    rmSync(TEST_CWD, { recursive: true, force: true });
  }
}
