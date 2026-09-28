/**
 * provider.loadClaudeSettings wiring: the provider path must hand the SDK
 * `settingSources: []` only when the user opted out, and leave the option
 * absent (SDK default: every source) otherwise. unit-config.mjs pins the
 * helper; this pins that the provider query actually receives it. Drives
 * streamSimple with a mocked SDK query() (see setQuery) — no Claude Code
 * subprocess runs.
 */
import { describe, it, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Before importing the module: point HOME (and so the global config dir) and CC
// state at throwaway dirs so no real ~/.pi or ~/.claude state is read or written.
const claudeDir = mkdtempSync(join(tmpdir(), "claude-bridge-setting-sources-cc-"));
const home = mkdtempSync(join(tmpdir(), "claude-bridge-setting-sources-home-"));
const oldHome = process.env.HOME;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
process.env.HOME = home;
const agentDir = getAgentDir();
// An agent-dir env override would redirect writes to a real config dir.
assert.ok(agentDir.startsWith(home), `agent dir escaped the temp HOME: ${agentDir}`);
mkdirSync(agentDir, { recursive: true });
process.on("exit", () => {
	rmSync(claudeDir, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

const mod = await import("../src/index.js");
const { setQuery, resetSharedSession } = mod.__test;

// Load the given global config the way pi activates the extension. Every call
// to the default export reloads config into the module; only the first one
// registers the provider (later instances defer to session_start), so keep the
// streamSimple and model from that first registration.
let provider;
function register(config) {
	writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify(config));
	mod.default({
		on: () => {},
		registerProvider: (_name, cfg) => { provider ??= { streamSimple: cfg.streamSimple, model: cfg.models[0] }; },
		registerTool: () => {},
	});
	assert.ok(provider, "extension never registered its provider");
	return provider;
}

async function capturedOptions(config) {
	const { streamSimple, model } = register(config);
	let seen;
	setQuery(({ options }) => {
		seen = options;
		const gen = (async function* () {
			yield { type: "system", subtype: "init", session_id: "cc-setting-sources" };
			yield { type: "result", subtype: "success", is_error: false, result: "OK" };
		})();
		gen.interrupt = async () => {};
		gen.close = () => {};
		return gen;
	});
	await streamSimple(model, { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] }, { sessionId: "pi-setting-sources" }).result();
	assert.ok(seen, "provider never called query()");
	return seen;
}

after(() => {
	if (oldHome === undefined) delete process.env.HOME;
	else process.env.HOME = oldHome;
});
beforeEach(() => resetSharedSession());
afterEach(() => setQuery(null));

describe("provider query settingSources", () => {
	it("is left at the SDK default when loadClaudeSettings is unset", async () => {
		const options = await capturedOptions({ provider: {} });
		assert.equal("settingSources" in options, false);
	});

	it("is left at the SDK default when loadClaudeSettings is true", async () => {
		const options = await capturedOptions({ provider: { loadClaudeSettings: true } });
		assert.equal("settingSources" in options, false);
	});

	it("is empty when loadClaudeSettings is false", async () => {
		const options = await capturedOptions({ provider: { loadClaudeSettings: false } });
		assert.deepEqual(options.settingSources, []);
	});
});
