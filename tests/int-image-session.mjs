#!/usr/bin/env node
// An image sent on another provider must survive the bridge writing pi's history
// into a Claude Code session, and still be visible to Claude after the resume.
//
// This is the one place the whole image path is exercised together: pi context →
// convertPiMessages → cc-session-io's writer → CC's own resume. The unit tests
// cover each conversion in isolation, but every regression here (issue #34, and
// the block-flattening that dropped images from written sessions) only shows up
// end to end.

import { createRpcHarness } from "./lib/rpc-harness.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectDir } from "cc-session-io";

// 32x32 solid crimson PNG — a colour the model can name unambiguously.
const CRIMSON_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGO4I2JDU8QwasGoBaMWjFow" +
	"asGoBaMWjFowasGoBaMWDBULADahsD1ndvqVAAAAAElFTkSuQmCC";

const ALT_PROVIDER = process.env.CLAUDE_BRIDGE_TESTING_ALT_PROVIDER;
const ALT_MODEL = process.env.CLAUDE_BRIDGE_TESTING_ALT_MODEL;
const TIMEOUT = 90_000;

console.log("=== image-session-test.mjs ===");

const CWD = mkdtempSync(join(tmpdir(), "image-session."));

const harness = createRpcHarness({
	name: "image-session",
	args: ["--provider", ALT_PROVIDER, "--model", ALT_MODEL, "-e", process.cwd()],
	cwd: CWD,
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, send, promptAndWait, collectText, waitForEvent } = harness;

function fail(msg) {
	console.error(`FAIL: ${msg}`);
	console.error(`  RPC log:   ${harness.RPC_LOG}`);
	console.error(`  Debug log: ${harness.DEBUG_LOG}`);
	process.exitCode = 1;
}

// Substring matching is not enough: a refusal like "I don't see an image, I made
// an error" contains "red". Only the first word counts, so a model that cannot
// see the image has no way to accidentally pass.
function namesTheColour(answer) {
	const firstWord = answer.trim().toLowerCase().replace(/^[^a-z]+/, "").split(/[^a-z]/)[0];
	return firstWord === "red" || firstWord === "crimson";
}

await startAndWait();
try {
	// Turn 1 on the non-bridge provider: puts the image into pi's history, and
	// confirms the fixture is a readable image before the bridge is involved.
	console.log("Turn 1: send the image to the non-bridge provider...");
	const collector = collectText();
	await send({
		type: "prompt",
		message: "What colour is this image? Reply with just the colour word.",
		images: [{ type: "image", data: CRIMSON_PNG, mimeType: "image/png" }],
	}, TIMEOUT);
	await waitForEvent("agent_end", TIMEOUT);
	const seen = collector.stop();
	console.log(`  Response: ${seen.trim().slice(0, 60)}`);
	if (!namesTheColour(seen)) {
		// Nothing after this can mean anything if the fixture was never readable.
		fail(`turn 1 could not read the image fixture (got: ${seen.trim().slice(0, 80)})`);
		throw new Error("turn 1 failed");
	}

	// Switching providers forces the bridge to write pi's history — image included —
	// into a Claude Code session for CC to resume from.
	console.log("Switching to claude-bridge/claude-haiku-5-5...");
	await send({ type: "set_model", provider: "claude-bridge", modelId: "claude-haiku-5-5" }, TIMEOUT);

	console.log("Turn 2: ask Claude about the image through the rebuilt session...");
	const answer = await promptAndWait(
		"Look at the image earlier in this conversation. Reply with exactly one word: " +
			"its colour, or UNKNOWN if no image is present.",
		TIMEOUT,
	);
	console.log(`  Response: ${answer.trim().slice(0, 80)}`);
	if (!namesTheColour(answer)) {
		fail(`image did not survive the session rebuild (got: ${answer.trim().slice(0, 120)})`);
	}

	if (!process.exitCode) console.log("PASS");
} catch (err) {
	if (!process.exitCode) throw err;
} finally {
	await stop();
	// Both the working dir and the session Claude Code wrote for it are ours.
	const projectDir = getProjectDir(CWD);
	rmSync(CWD, { recursive: true, force: true });
	if (projectDir.includes("image-session")) rmSync(projectDir, { recursive: true, force: true });
}
