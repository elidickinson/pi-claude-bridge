#!/usr/bin/env node
// Live: pi's whole system prompt names the reader "read", but the bridge serves it as
// mcp__custom-tools__read. Verify a skill still loads -- the model reads SKILL.md and
// follows it. Regression for the prompt-capture removal (the skills hint rewrite is gone;
// pi hides the hint itself when no reader is present).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const BRIDGE_MODEL = "claude-bridge/claude-haiku-5-5";
const TIMEOUT = 180_000;
const MARKER = "SKILL-LOADED-SENTINEL-7Q";
const agentDir = mkdtempSync(join(tmpdir(), "skill-loading-agent-"));
const projectDir = mkdtempSync(join(tmpdir(), "skill-loading-project-"));
mkdirSync(join(projectDir, ".pi", "skills", "sentinel-skill"), { recursive: true });
writeFileSync(join(projectDir, ".pi", "skills", "sentinel-skill", "SKILL.md"),
	`---\nname: sentinel-skill\ndescription: Emits a sentinel marker. Use when asked to run the sentinel skill.\n---\n# Sentinel Skill\nReply with exactly: ${MARKER}\nDo not call any other tools.\n`);

const harness = createRpcHarness({
	name: "skill-loading",
	// --approve so pi trusts the project-local skill and lists it in the prompt; without it
	// pi skips .pi/skills and the model could find SKILL.md by searching instead of reading
	// the skill the prompt names.
	args: ["--approve", "--model", BRIDGE_MODEL],
	cwd: projectDir,
	env: { PI_CODING_AGENT_DIR: agentDir },
	defaultTimeout: TIMEOUT,
});
const { startAndWait, stop, send, waitForEvent, waitForMatch, collectText, DEBUG_LOG } = harness;

await startAndWait();
try {
	const collector = collectText();
	await send({ type: "prompt", message: "Use the sentinel-skill skill and follow its instructions exactly." }, TIMEOUT);
	await waitForMatch(
		(msg) => msg.type === "tool_execution_start" && JSON.stringify(msg).includes("SKILL.md"),
		"read of SKILL.md",
		TIMEOUT,
	);
	await waitForEvent("agent_end", TIMEOUT);
	const text = collector.stop();
	assert.match(text, new RegExp(MARKER), `skill was not followed. Text: ${text.slice(0, 500)}`);
	console.log("PASS");
} catch (err) {
	process.exitCode = 1;
	console.log(`FAIL: ${err.message}\n${err.stack}`);
	try { console.log(`Debug tail:\n${readFileSync(DEBUG_LOG, "utf8").slice(-4000)}`); } catch {}
} finally {
	await stop();
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectDir, { recursive: true, force: true });
}