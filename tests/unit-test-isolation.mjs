import { it } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { DEBUG_LOG_PATH, DIAG_LOG_PATH } from "../src/log-paths.js";
import { globalConfigPath } from "../src/config.js";
import { assertEffectiveTestPaths, assertOwnedPath, testRoot, TEST_ENV_KEYS, withTempHome } from "./lib/setup.mjs";

function snapshot() { return Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]])); }
function restore(values) {
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}
// No test writes until the actual runner paths have passed confinement checks.
for (const [label, path] of Object.entries({ home: homedir(), agent: getAgentDir(), config: globalConfigPath(), claude: process.env.CLAUDE_CONFIG_DIR, debug: DEBUG_LOG_PATH, diagnostics: DIAG_LOG_PATH })) {
	assertOwnedPath(testRoot, path, label);
}

it("each nested config fixture gets a fresh effective agent directory and restores every variable", () => {
	const before = snapshot();
	let firstHome, firstAgent;
	withTempHome((home) => {
		firstHome = home;
		firstAgent = getAgentDir();
		assertOwnedPath(home, homedir(), "nested home");
		assertOwnedPath(home, firstAgent, "nested getAgentDir");
		assertOwnedPath(home, globalConfigPath(), "nested config");
		assertOwnedPath(home, process.env.CLAUDE_CONFIG_DIR, "nested Claude config");
		assertOwnedPath(home, process.env.CLAUDE_BRIDGE_DEBUG_PATH, "nested debug");
		assertOwnedPath(home, join(getAgentDir(), "claude-bridge-diag.log"), "nested diagnostics");
		assert.equal(process.env.CLAUDE_BRIDGE_RECORD_STREAM, undefined);
		mkdirSync(firstAgent, { recursive: true });
		writeFileSync(globalConfigPath(), "{ malformed fixture }");
	});
	assert.equal(existsSync(firstHome), false);
	assert.deepEqual(snapshot(), before);
	withTempHome((home) => {
		assert.notEqual(home, firstHome);
		assert.notEqual(getAgentDir(), firstAgent);
		assert.equal(existsSync(globalConfigPath()), false);
	});
});
it("a fake real-home sentinel is never overwritten by nested fixtures, including on throw", () => {
	const before = snapshot();
	try {
		withTempHome((outer) => {
			const fakeHome = join(outer, "fake-real-home");
			const fakeAgent = join(fakeHome, CONFIG_DIR_NAME, "agent");
			const sentinel = assertOwnedPath(testRoot, join(fakeAgent, "claude-bridge.json"));
			mkdirSync(fakeAgent, { recursive: true });
			const bytes = '{"sentinel":"never alter this fake home"}\n';
			writeFileSync(sentinel, bytes);
			process.env.HOME = fakeHome;
			process.env.USERPROFILE = fakeHome;
			process.env.PI_CODING_AGENT_DIR = fakeAgent;
			process.env.CLAUDE_CONFIG_DIR = join(fakeHome, "claude");
			process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(fakeHome, "debug.log");
			process.env.CLAUDE_BRIDGE_RECORD_STREAM = join(fakeHome, "record.log");
			const inherited = snapshot();
			assert.throws(() => withTempHome(() => {
				const path = assertOwnedPath(testRoot, globalConfigPath(), "sentinel regression fixture");
				mkdirSync(getAgentDir(), { recursive: true });
				writeFileSync(path, '{ "askClaude": { "enabled": true }, }');
				throw new Error("fixture failure");
			}), /fixture failure/);
			assert.deepEqual(snapshot(), inherited);
			assert.equal(readFileSync(sentinel, "utf8"), bytes);
		});
	} finally {
		restore(before);
	}
});
it("preflight does not freeze production log paths before a test installs its own fixture", () => {
	const probe = `
		import assert from "node:assert/strict";
		import { mkdtempSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		import { getAgentDir } from "@earendil-works/pi-coding-agent";
		import { assertOwnedPath, testRoot } from "./tests/lib/setup.mjs";
		const agent = mkdtempSync(join(tmpdir(), "log-path-fixture-"));
		process.env.PI_CODING_AGENT_DIR = agent;
		assertOwnedPath(testRoot, getAgentDir(), "probe agent");
		const { DIAG_LOG_PATH } = await import("./src/log-paths.js");
		assert.equal(DIAG_LOG_PATH, join(agent, "claude-bridge-diag.log"));
	`;
	// Node-only path probe, with inherited isolated home/temp environment.
	execFileSync(process.execPath, ["--import", "tsx", "--import", "./tests/lib/setup.mjs", "--input-type=module", "-e", probe], { encoding: "utf8", timeout: 60000 });
});
it("preflight rejects an escaped effective override before any config write", () => {
	withTempHome((home) => {
		process.env.CLAUDE_CONFIG_DIR = join(testRoot, "fake-outside-nested-home");
		assert.throws(() => assertEffectiveTestPaths(home), /claudeConfig escapes/);
	});
});
it("path guards reject symlink redirection into another runner-owned fixture", () => {
	const target = join(testRoot, "redirect-target");
	mkdirSync(target);
	withTempHome((home) => {
		const link = join(home, "redirect");
		symlinkSync(target, link, "junction");
		assert.throws(() => assertOwnedPath(home, join(link, "future-config.json")), /escapes/);
		assert.equal(existsSync(join(target, "future-config.json")), false);
	});
});
it("restores absent overrides as absent rather than stringifying undefined", () => {
	const before = snapshot();
	try {
		delete process.env.PI_CODING_AGENT_DIR;
		delete process.env.CLAUDE_BRIDGE_RECORD_STREAM;
		withTempHome((home) => assertEffectiveTestPaths(home));
		assert.equal(process.env.PI_CODING_AGENT_DIR, undefined);
		assert.equal(process.env.CLAUDE_BRIDGE_RECORD_STREAM, undefined);
	} finally {
		restore(before);
	}
});
it("path guards reject traversal and sibling-prefix paths before filesystem access", () => {
	assert.equal(assertOwnedPath(testRoot, join(testRoot, "future", "config.json")), join(testRoot, "future", "config.json"));
	assert.throws(() => assertOwnedPath(testRoot, join(testRoot, "..", "escape.json")), /escapes/);
	assert.throws(() => assertOwnedPath(testRoot, `${testRoot}-sibling/config.json`), /escapes/);
	assert.throws(() => assertOwnedPath(testRoot, "relative/config.json"), /not absolute/);
});
