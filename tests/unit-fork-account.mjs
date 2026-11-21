import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { applyAccount, excludeFromGit, writeProjectAccount } from "../src/fork/account.js";
import { accountConfigDir } from "../src/fork/config.js";

function withProject(fn) {
	const cwd = mkdtempSync(join(tmpdir(), "claude-bridge-account-"));
	try {
		return fn(cwd, join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
}

describe("applyAccount", () => {
	it("switching back to the default restores the CLAUDE_CONFIG_DIR pi started with", () => {
		const original = process.env.CLAUDE_CONFIG_DIR;
		assert.equal(applyAccount("banx"), accountConfigDir("banx"));
		assert.equal(process.env.CLAUDE_CONFIG_DIR, accountConfigDir("banx"));
		assert.equal(applyAccount(undefined), original);
		assert.equal(process.env.CLAUDE_CONFIG_DIR, original);
	});
});

describe("writeProjectAccount", () => {
	it("sets and clears the account without touching other settings", () => withProject((cwd, path) => {
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(path, JSON.stringify({ provider: { plan: "max" }, askClaude: { enabled: false } }));
		writeProjectAccount(cwd, "banx");
		assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { provider: { plan: "max", account: "banx" }, askClaude: { enabled: false } });
		writeProjectAccount(cwd, undefined);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), { provider: { plan: "max" }, askClaude: { enabled: false } });
	}));

	it("removes a config file that only held the account", () => withProject((cwd, path) => {
		writeProjectAccount(cwd, "banx");
		assert.ok(existsSync(path));
		writeProjectAccount(cwd, undefined);
		assert.ok(!existsSync(path));
	}));

	it("leaves an unparseable config alone", () => withProject((cwd, path) => {
		mkdirSync(join(cwd, CONFIG_DIR_NAME));
		writeFileSync(path, "{ \"provider\": { \"plan\": \"max\", } }");
		assert.throws(() => writeProjectAccount(cwd, "banx"), /does not parse/);
		assert.equal(readFileSync(path, "utf-8"), "{ \"provider\": { \"plan\": \"max\", } }");
	}));
});

describe("excludeFromGit", () => {
	it("excludes the config once, locally", () => withProject((cwd, path) => {
		execFileSync("git", ["init", "-q"], { cwd });
		writeProjectAccount(cwd, "banx");
		excludeFromGit(cwd);
		excludeFromGit(cwd);
		const exclude = readFileSync(join(cwd, ".git", "info", "exclude"), "utf-8");
		assert.equal(exclude.split("\n").filter((line) => line === `/${CONFIG_DIR_NAME}/claude-bridge.json`).length, 1);
		assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf-8" }), "");
	}));
});
