#!/usr/bin/env node

/**
 * Main-provider hook isolation.
 *
 * The SDK loads user/project/local settings.json by default (sdk.d.ts:2239-2249),
 * and the provider path intentionally leaves settingSources at CC's default so
 * Bedrock/Vertex users keep `env`/`apiKeyHelper` from settings.json. But those
 * same settings files carry configured CC hooks, which would execute commands in
 * the CC child outside pi's tool executor. The main-provider query therefore
 * passes `settings.disableAllHooks: true` (sdk.d.ts:7088-7091), which disables
 * hooks and statusLine defined in settings files and installed plugins.
 *
 * Deliberate limits, pinned so they don't silently drift:
 * - managed (enterprise policy) hooks still run (sdk.d.ts:4133-4151) — not a
 *   complete sandbox.
 * - AskClaude keeps CC's native tools and does NOT set disableAllHooks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

describe("main-provider hooks disabled", () => {
	it("main-provider query settings carry disableAllHooks:true", () => {
		// The provider query settings object is uniquely identified by its
		// includeGitInstructions exclusion (documented at that site for cache
		// stability); assert disableAllHooks lives inside that same object.
		assert.match(
			source,
			/settings: \{\s*\n\s*\.\.\.claudeCodeSettings\(providerSettings\),\s*\n\s*claudeMdExcludes: CLAUDE_MD_EXCLUDES,\s*\n\s*includeGitInstructions: false,[\s\S]*?disableAllHooks: true,\s*\n\s*\},\s*\n\t\tsystemPrompt:/,
			"main provider settings object must set disableAllHooks: true",
		);
	});

	it("AskClaude settings do not set disableAllHooks", () => {
		// promptAndWait's settings construction is uniquely identified by its
		// skills: [] suppression directly above; between it and settingSources
		// there must be no disableAllHooks.
		const m = source.match(
			/skills: \[\],[\s\S]{0,1500}?settingSources: \["user", "project"\]/,
		);
		assert.ok(m, "AskClaude option block not found");
		assert.doesNotMatch(m[0], /disableAllHooks/, "AskClaude must not disable hooks");
	});
});
