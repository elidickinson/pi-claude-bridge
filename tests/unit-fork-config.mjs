import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { accountConfigDir } from "../src/fork/config.js";
import { loadConfig } from "../src/config.js";

function withTempHome(fn) {
	const oldHome = process.env.HOME;
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const home = mkdtempSync(join(tmpdir(), "claude-bridge-fork-config-"));
	try {
		process.env.HOME = home;
		process.env.PI_CODING_AGENT_DIR = join(home, "agent");
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("fork accountConfigDir", () => {
	it("maps a name to its own Claude Code config dir under ~/.claude-accounts", () => withTempHome((home) => {
		assert.equal(accountConfigDir("banx"), join(home, ".claude-accounts", "banx"));
	}));
	it("rejects names that could resolve to another login", () => {
		for (const name of ["", "..", "../personal", "a/b", "/tmp/x", ".hidden"]) {
			assert.throws(() => accountConfigDir(name), /plain name/, name);
		}
	});
});

describe("fork project account configuration", () => {
	it("lets a project name its Claude account but nothing else in provider", () => withTempHome((home) => {
		const cwd = join(home, "project");
		const globalDir = getAgentDir();
		const projectDir = join(cwd, CONFIG_DIR_NAME);
		mkdirSync(globalDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({ provider: { plan: "pro", account: "personal" } }));
		writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
			provider: { plan: "max", account: "banx", pathToClaudeCodeExecutable: join(cwd, "evil") },
		}));
		const globalProvider = loadConfig(home).provider;
		assert.deepEqual(loadConfig(cwd).provider, { ...globalProvider, account: "banx" });
		assert.equal(globalProvider.account, "personal");
		assert.equal(globalProvider.plan, "pro");
	}));
});
