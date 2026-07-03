import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../src/config.js";

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
				provider: { plan: "max" },
				askClaude: { enabled: false },
				usageMeter: {},
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));

	it("merges project config over global config", () => withTempHome((home) => {
		const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-project-"));
		try {
			const globalDir = join(home, ".pi", "agent");
			const projectDir = join(cwd, CONFIG_DIR_NAME);
			mkdirSync(globalDir, { recursive: true });
			mkdirSync(projectDir, { recursive: true });
			writeFileSync(join(globalDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "pro", strictMcpConfig: true },
				askClaude: { enabled: true, defaultMode: "read" },
			}));
			writeFileSync(join(projectDir, "claude-bridge.json"), JSON.stringify({
				provider: { plan: "max" },
				askClaude: { enabled: false },
			}));

			assert.deepEqual(loadConfig(cwd), {
				provider: { plan: "max", strictMcpConfig: true },
				askClaude: { enabled: false, defaultMode: "read" },
				usageMeter: {},
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}));
});
