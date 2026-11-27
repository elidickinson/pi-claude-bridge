// A pi package update can move the SDK under a running pi. The real SDK keeps its
// cached path to the deleted binary and throws; the launch is retried with the binary
// that is on disk now.
import { it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findClaudeExecutable, queryWithFreshBinary } from "../src/claude-executable.js";

const SDK = "@anthropic-ai/claude-agent-sdk";
const BINARY = join(`${SDK}-${process.platform}-${process.arch}`, process.platform === "win32" ? "claude.exe" : "claude");
// The layout npm leaves while the bridge and AskClaude pin different SDK versions.
const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-executable-")));
const bridge = join(root, "node_modules", "pi-claude-bridge");
const from = join(bridge, "src");
const hoisted = join(root, "node_modules", BINARY);
const nested = join(bridge, "node_modules", BINARY);
for (const path of [hoisted, nested]) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "#!/bin/sh\n");
	chmodSync(path, 0o755);
}
mkdirSync(from);
const sdkDir = dirname(fileURLToPath(import.meta.resolve(SDK)));
cpSync(sdkDir, join(bridge, "node_modules", SDK), { recursive: true });
const { query: nestedQuery } = await import(join(bridge, "node_modules", SDK, "sdk.mjs"));
after(() => rmSync(root, { recursive: true, force: true }));

function launch(queryImpl, options = {}) {
	let command;
	const spawnClaudeCodeProcess = (spawnOptions) => {
		command = spawnOptions.command;
		return spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { stdio: ["pipe", "pipe", "pipe"] });
	};
	const q = queryWithFreshBinary(queryImpl, { prompt: "hi", options: { ...options, spawnClaudeCodeProcess } }, from);
	return new Promise((resolve) => setTimeout(resolve, 200)).then(() => { q.close(); return command; });
}

it("relaunches with the binary on disk after the SDK's cached one is deleted", async () => {
	assert.equal(findClaudeExecutable(from), nested);
	assert.equal(await launch(nestedQuery), nested);
	rmSync(dirname(nested), { recursive: true });
	assert.throws(() => nestedQuery({ prompt: "hi" }), /Native CLI binary for \S+ not found/);
	assert.equal(findClaudeExecutable(from), hoisted);
	assert.equal(await launch(nestedQuery), hoisted);
});

it("leaves a configured executable and other launch errors to the caller", () => {
	const missing = () => { throw new Error(`Native CLI binary for ${process.platform}-${process.arch} not found. Reinstall.`); };
	const params = { prompt: "hi", options: { pathToClaudeCodeExecutable: "/opt/claude" } };
	assert.throws(() => queryWithFreshBinary(missing, params, from), /Native CLI binary/);
	let calls = 0;
	const other = () => { calls++; throw new Error("sessionStore cannot be used with persistSession: false"); };
	assert.throws(() => queryWithFreshBinary(other, { prompt: "hi" }, from), /sessionStore/);
	assert.equal(calls, 1);
	assert.throws(() => queryWithFreshBinary(missing, { prompt: "hi" }, mkdtempSync(join(tmpdir(), "no-binary-"))), /Native CLI binary/);
});
