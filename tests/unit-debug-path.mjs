/**
 * Guards the guard: if tests/lib/setup.mjs stops being preloaded, unit tests
 * would silently start writing to the developer's real debug log instead of a
 * temp dir. That regression is otherwise invisible unless CLAUDE_BRIDGE_DEBUG=1.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { globalConfigPath } from "../src/config.js";
import { debugLogPath, diagLogPath } from "../src/log-paths.js";

describe("test harness", () => {
	it("redirects the bridge debug log away from the real one", () => {
		const path = process.env.CLAUDE_BRIDGE_DEBUG_PATH;
		assert.ok(path, "CLAUDE_BRIDGE_DEBUG_PATH must be set — is tests/lib/setup.mjs still preloaded via --import?");
		// Compare against the production default specifically; a blanket "not under
		// $HOME" check would misfire for anyone whose TMPDIR lives inside their home.
		assert.notEqual(
			path,
			join(getAgentDir(), "claude-bridge.log"),
			"debug log must not resolve to the real one",
		);
	});

	it("keeps every path-derived location inside the temp root", () => {
		const root = process.env.HOME;
		assert.ok(root, "HOME must be set — is tests/lib/setup.mjs still preloaded via --import?");
		for (const path of [homedir(), getAgentDir(), globalConfigPath(), debugLogPath(), diagLogPath()]) {
			assert.ok(path.startsWith(root), `${path} must live under ${root}`);
		}
	});

	it("resolves lazily from env changes made after import", () => {
		// Pinning the lazy contract: if log-paths regresses to import-time consts,
		// this fails because the preloaded values would still be returned.
		const previous = { agent: process.env.PI_CODING_AGENT_DIR, debug: process.env.CLAUDE_BRIDGE_DEBUG_PATH };
		try {
			process.env.PI_CODING_AGENT_DIR = "/tmp/log-paths-lazy-probe";
			process.env.CLAUDE_BRIDGE_DEBUG_PATH = "/tmp/log-paths-lazy-probe-debug.log";
			assert.equal(diagLogPath(), "/tmp/log-paths-lazy-probe/claude-bridge-diag.log");
			assert.equal(debugLogPath(), "/tmp/log-paths-lazy-probe-debug.log");
		} finally {
			if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous.agent;
			if (previous.debug === undefined) delete process.env.CLAUDE_BRIDGE_DEBUG_PATH;
			else process.env.CLAUDE_BRIDGE_DEBUG_PATH = previous.debug;
		}
	});
});

describe("log paths", () => {
	it("follow PI_CODING_AGENT_DIR when no debug path override is set", () => {
		// Read from a fresh process: this is the env the preload sets, minus the
		// debug-path override, resolved against a probe agent dir.
		const env = { ...process.env, PI_CODING_AGENT_DIR: "/tmp/pi-agent-dir-probe" };
		delete env.CLAUDE_BRIDGE_DEBUG_PATH;
		const src = new URL("../src/log-paths.ts", import.meta.url).href;
		const out = execFileSync(process.execPath, [
			"--import", "tsx", "--input-type=module", "-e",
			`const p = await import(${JSON.stringify(src)}); console.log(JSON.stringify({ DEBUG_LOG_PATH: p.debugLogPath(), DIAG_LOG_PATH: p.diagLogPath() }));`,
		], { env, encoding: "utf8" });
		assert.deepEqual(JSON.parse(out), {
			DEBUG_LOG_PATH: "/tmp/pi-agent-dir-probe/claude-bridge.log",
			DIAG_LOG_PATH: "/tmp/pi-agent-dir-probe/claude-bridge-diag.log",
		});
	});
});
