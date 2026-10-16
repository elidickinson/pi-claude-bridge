#!/usr/bin/env node

/**
 * /claude-account: the token reaches Claude Code through a private settings file (never
 * argv), a missing token fails loudly, and the status line keeps windows across events.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { pickAccount, resolveToken, settingsWithToken, mergeWindows, formatAccountStatus } = await import("../src/accounts.js");

describe("accounts", () => {
	it("picks the active account, else the first; none configured means no override", () => {
		assert.equal(pickAccount("alt", ["default", "alt"]), "alt");
		assert.equal(pickAccount(undefined, ["default", "alt"]), "default");
		assert.equal(pickAccount("renamed", ["default", "alt"]), "default");
		assert.equal(pickAccount("alt", []), undefined);
	});

	it("resolves tokens from env or file, trimmed", () => {
		assert.equal(resolveToken("a", { tokenEnv: "T" }, { T: " tok\n" }), "tok");
		assert.equal(resolveToken("i", { token: "inline", tokenEnv: "T" }, { T: "env" }), "inline");
		const file = join(tmpdir(), `cb-token-${process.pid}`);
		writeFileSync(file, "filetok\n");
		try {
			assert.equal(resolveToken("b", { tokenFile: file }), "filetok");
		} finally {
			rmSync(file, { force: true });
		}
	});

	it("throws instead of silently falling back", () => {
		assert.throws(() => resolveToken("a", { tokenEnv: "T" }, {}), /account "a" has no token \(env T\)/);
		assert.throws(() => resolveToken("x", undefined), /not in claude-bridge.json/);
	});

	it("writes the token into a 0600 settings file, keeping other settings", () => {
		const path = settingsWithToken({ autoMemoryEnabled: false, env: { KEEP: "1" } }, "secret");
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), {
			autoMemoryEnabled: false,
			env: { KEEP: "1", CLAUDE_CODE_OAUTH_TOKEN: "secret" },
		});
		assert.equal(settingsWithToken({ autoMemoryEnabled: false, env: { KEEP: "1" } }, "secret"), path);
		// A tmp cleanup that removes the directory mid-session must not break later turns.
		rmSync(join(path, ".."), { recursive: true });
		assert.equal(statSync(settingsWithToken({}, "secret")).mode & 0o777, 0o600);
	});

	it("merges partial rate_limit_events and formats the status", () => {
		let w = mergeWindows({}, { unifiedWindows: { five_hour: { utilization: 0.28 }, seven_day: { utilization: 0.15 } } });
		w = mergeWindows(w, { rateLimitType: "five_hour", utilization: 0.3 });
		assert.equal(formatAccountStatus("alt", w), "\uf007 alt  \uf017 5h 30%  \uf073 7d 15%");
		assert.equal(formatAccountStatus("default", {}), "\uf007 default  \uf017 5h –  \uf073 7d –");
	});
});
