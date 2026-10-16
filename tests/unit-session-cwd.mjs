import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rememberSessionCwd, forgetSessionCwd, sessionCwdFor } from "../src/session-cwd.ts";
import activate, { __test } from "../src/index.js";

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

describe("streamSimple", () => {
	it("runs Claude Code in the cwd registered at session_start", async (t) => {
		const sessionCwd = mkdtempSync(join(tmpdir(), "claude-bridge-session-cwd-"));
		t.after(() => rmSync(sessionCwd, { recursive: true, force: true }));
		const handlers = {};
		let providerConfig;
		activate({
			on: (name, fn) => { (handlers[name] ??= []).push(fn); },
			registerProvider: (_name, config) => { providerConfig = config; },
			registerTool: () => {},
		});
		for (const fn of handlers.session_start) fn({}, { cwd: sessionCwd, sessionManager: { getSessionId: () => "s-web" } });
		t.after(() => forgetSessionCwd("s-web"));

		let queryCwd;
		__test.setQuery(({ options }) => {
			queryCwd = options.cwd;
			const gen = (async function* () {
				yield { type: "system", subtype: "init", session_id: "cc-web" };
				yield { type: "result", subtype: "success", is_error: false, result: "ok" };
			})();
			gen.interrupt = async () => {};
			gen.close = () => {};
			return gen;
		});
		t.after(() => __test.setQuery(null));

		await providerConfig.streamSimple(providerConfig.models[0], { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools: [] }, { sessionId: "s-web" }).result();
		assert.equal(queryCwd, sessionCwd);
	});
});
