import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { rememberSessionCwd, forgetSessionCwd, sessionCwdFor } from "../src/session-cwd.ts";

const KEY = Symbol.for("claude-bridge:sessionCwds");

describe("session cwd", () => {
	it("returns the remembered cwd for its session only", () => {
		rememberSessionCwd("s1", "/agents/Martin");
		assert.equal(sessionCwdFor("s1"), "/agents/Martin");
		assert.equal(sessionCwdFor("other"), process.cwd());
		forgetSessionCwd("s1");
	});

	it("falls back to process.cwd() for null and undefined", () => {
		assert.equal(sessionCwdFor(null), process.cwd());
		assert.equal(sessionCwdFor(undefined), process.cwd());
	});

	it("forget removes the entry", () => {
		rememberSessionCwd("s2", "/x");
		forgetSessionCwd("s2");
		assert.equal(sessionCwdFor("s2"), process.cwd());
	});

	it("shares the store across module instances via globalThis", async () => {
		const second = await import(`../src/session-cwd.ts?instance=${Date.now()}`);
		rememberSessionCwd("s3", "/shared");
		assert.equal(second.sessionCwdFor("s3"), "/shared");
		assert.equal(globalThis[KEY].get("s3"), "/shared");
		forgetSessionCwd("s3");
	});
});

describe("src/index.ts pins", () => {
	const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	it("no longer takes cwd from process.cwd()", () => {
		assert.doesNotMatch(src, /const cwd = process\.cwd\(\)/);
	});
	it("excludes AGENTS.md from Claude Code's native loading", () => {
		assert.match(src, /CLAUDE_MD_EXCLUDES = \[[^\]]*"\*\*\/AGENTS\.md"/);
	});
});
