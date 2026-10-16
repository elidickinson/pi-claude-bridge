import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const gate = fileURLToPath(new URL("./lib/check-deadlock-logs.mjs", import.meta.url));
const prefix = "[2026-09-25T12:00:00.000Z] [abc123] ";

function check(lines) {
	const dir = mkdtempSync(join(tmpdir(), "bridge-deadlock-gate-"));
	try {
		writeFileSync(join(dir, "integration-debug.log"), lines.join("\n"));
		return spawnSync(process.execPath, [gate, dir], { encoding: "utf8" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

it("ignores tool-output echoes and unrelated warnings", () => {
	const result = check([
		`${prefix}tool output: BUG: echoed`,
		`${prefix}WARNING: no prompt stream`,
		"BUG: missing bridge prefix",
	]);
	assert.equal(result.status, 0, result.stderr);
});

it("fails rather than passing an empty integration run", () => {
	const dir = mkdtempSync(join(tmpdir(), "bridge-deadlock-gate-"));
	try {
		const result = spawnSync(process.execPath, [gate, dir], { encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /No integration debug logs/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("checks logs when invoked through a symlink", () => {
	const dir = mkdtempSync(join(tmpdir(), "bridge-deadlock-gate-"));
	try {
		const link = join(dir, "gate.mjs");
		symlinkSync(gate, link);
		writeFileSync(join(dir, "integration-debug.log"), `${prefix}BUG: both maps non-empty!\n`);
		const result = spawnSync(process.execPath, [link, dir], { encoding: "utf8" });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /integration-debug\.log:1:.*BUG:/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

it("fails on bridge-origin deadlock markers", () => {
	const result = check([
		`${prefix}BUG: both maps non-empty! handlers=1 results=1`,
		`${prefix}WARNING: 1 MCP handlers still waiting after delivering 0 results`,
	]);
	assert.equal(result.status, 1);
	assert.match(result.stderr, /integration-debug\.log:1:.*BUG:/);
	assert.match(result.stderr, /integration-debug\.log:2:.*MCP handlers still waiting/);
});
