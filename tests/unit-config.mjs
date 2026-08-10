import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { claudeCodeSettings, loadConfig, markStartupNoticeShown } from "../src/config.js";

function withTempHome(fn) {
	const oldHome = process.env.HOME;
	const home = mkdtempSync(join(tmpdir(), "claude-bridge-home-"));
	try {
		process.env.HOME = home;
		return fn(home);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		rmSync(home, { recursive: true, force: true });
	}
}

describe("claudeCodeSettings", () => {
	it("disables auto-memory by default", () => {
		assert.deepEqual(claudeCodeSettings(), { autoMemoryEnabled: false });
	});

	it("allows auto-memory to be enabled", () => {
		assert.deepEqual(claudeCodeSettings({ autoMemoryEnabled: true }), { autoMemoryEnabled: true });
	});
});

describe("loadConfig", () => {
	it("loads project config from Pi's configured project directory", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const configDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				startupNoticeShown: undefined,
				provider: { plan: "max" },
				askClaude: { enabled: false },
				compaction: {},
				branchSummary: {},
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("merges project config over global config", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "pro", strictMcpConfig: true },
				askClaude: { enabled: true, defaultMode: "read" },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max", autoMemoryEnabled: true },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				startupNoticeShown: undefined,
				provider: { plan: "max", strictMcpConfig: true, autoMemoryEnabled: true },
				askClaude: { enabled: false, defaultMode: "read" },
				compaction: {},
				branchSummary: {},
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("merges takeover flags with project overriding global", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				compaction: { takeover: true },
				branchSummary: { takeover: true },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				compaction: { takeover: false },
				branchSummary: { takeover: false },
			}));

			const config = loadConfig(cwd);
			assert.equal(config.compaction?.takeover, false);
			assert.equal(config.branchSummary?.takeover, false);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("leaves the takeover flags independent of each other", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				compaction: { takeover: false },
			}));

			const config = loadConfig(cwd);
			assert.equal(config.compaction?.takeover, false);
			assert.equal(config.branchSummary?.takeover, undefined);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("leaves both takeover flags undefined when unconfigured, so takeover stays on", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const config = loadConfig(cwd);
			assert.equal(config.compaction?.takeover, undefined);
			assert.equal(config.branchSummary?.takeover, undefined);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("markStartupNoticeShown records today's date without dropping existing settings", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = getAgentDir();
			mkdirSync(globalDir, { recursive: true });
			const path = join(globalDir, "claude-bridge.json");
			writeFileSync(path, JSON.stringify({
				askClaude: { enabled: false },
				provider: { strictMcpConfig: false },
			}));

			assert.equal(markStartupNoticeShown(), path);
			const written = JSON.parse(readFileSync(path, "utf-8"));
			assert.match(written.startupNoticeShown, /^\d{4}-\d{2}-\d{2}$/);
			assert.deepEqual(written.askClaude, { enabled: false });
			assert.deepEqual(written.provider, { strictMcpConfig: false });
			assert.equal(loadConfig(cwd).startupNoticeShown, written.startupNoticeShown);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("markStartupNoticeShown leaves an unparseable config untouched", () => withTempHome(() => {
		const globalDir = getAgentDir();
		mkdirSync(globalDir, { recursive: true });
		const path = join(globalDir, "claude-bridge.json");
		const malformed = '{ "askClaude": { "enabled": true }, }';
		writeFileSync(path, malformed);

		markStartupNoticeShown();
		assert.equal(readFileSync(path, "utf-8"), malformed, "a typo must not cost the user their config");
	}));

	it("markStartupNoticeShown creates the config when there is none", () => withTempHome(() => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			assert.equal(loadConfig(cwd).startupNoticeShown, undefined);
			markStartupNoticeShown();
			assert.match(loadConfig(cwd).startupNoticeShown, /^\d{4}-\d{2}-\d{2}$/);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("resolves global config via PI_CODING_AGENT_DIR override, not hardcoded ~/.pi/agent", () => withTempHome(() => {
		const agentDir = mkdtempSync(join(tmpdir(), "claude-bridge-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		const oldEnv = process.env.PI_CODING_AGENT_DIR;
		try {
			process.env.PI_CODING_AGENT_DIR = agentDir;
			writeFileSync(join(agentDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
			}));

			assert.deepEqual(loadConfig(cwd), {
				startupNoticeShown: undefined,
				provider: { plan: "max" },
				askClaude: {},
				compaction: {},
				branchSummary: {},
			});
		} finally {
			if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldEnv;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	}));
});
