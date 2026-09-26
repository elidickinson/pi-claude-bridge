/**
 * Every Claude Code subprocess the bridge spawns must get an environment that
 * both keeps its hands off state pi owns (CC_CHILD_ENV) and does not inherit
 * ambient ANTHROPIC_* auth variables exported for another gateway: the SDK
 * REPLACES the whole child environment with options.env (sdk.d.ts:1577-1594),
 * so ANTHROPIC_BASE_URL/API_KEY/AUTH_TOKEN for a corporate proxy or LiteLLM
 * would redirect Claude Code too and every turn would fail with that gateway's
 * auth error (upstream issue #107).
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const { __test } = await import("../src/index.js");
const { resolveInheritAnthropicEnv } = await import("../src/config.js");

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "../src/index.ts"), "utf-8");

afterEach(() => {
	// Restore sanitize default between tests (resolveInheritAnthropicEnv(undefined) = false).
	__test.setInheritAnthropicEnv(false);
});

describe("Claude Code child environment", () => {
	it("disables auto-compaction and claude.ai MCP servers", () => {
		assert.deepEqual(__test.CC_CHILD_ENV, {
			ENABLE_CLAUDEAI_MCP_SERVERS: "0",
			DISABLE_AUTO_COMPACT: "1",
		});
	});

	it("buildChildEnv strips the three ambient ANTHROPIC auth vars and applies CC_CHILD_ENV on top", () => {
		const saved = {};
		for (const key of ["PATH", "HOME", "ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ENABLE_CLAUDEAI_MCP_SERVERS"]) {
			saved[key] = process.env[key];
			process.env[key] = key === "PATH" || key === "HOME"
				? `sentinel-${key}`
				: key === "ENABLE_CLAUDEAI_MCP_SERVERS" ? "1" : `sentinel-${key}`;
		}
		try {
			__test.setInheritAnthropicEnv(false);
			const env = __test.buildChildEnv();
			// Exactly the three auth vars are stripped.
			assert.equal(env["ANTHROPIC_BASE_URL"], undefined);
			assert.equal(env["ANTHROPIC_API_KEY"], undefined);
			assert.equal("ANTHROPIC_AUTH_TOKEN" in env, false);
			// Legitimate ANTHROPIC_* runtime configuration survives.
			assert.equal(env["ANTHROPIC_MODEL"], "sentinel-ANTHROPIC_MODEL");
			// Ordinary environment survives.
			assert.equal(env["PATH"], "sentinel-PATH");
			assert.equal(env["HOME"], "sentinel-HOME");
			// CC_CHILD_ENV wins over the ambient value.
			assert.equal(env["ENABLE_CLAUDEAI_MCP_SERVERS"], "0");
			assert.equal(env["DISABLE_AUTO_COMPACT"], "1");
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("buildChildEnv with inheritAnthropicEnv=true passes ANTHROPIC_* through (escape hatch)", () => {
		const saved = { key: process.env["ANTHROPIC_BASE_URL"] };
		process.env["ANTHROPIC_BASE_URL"] = "https://gateway.internal";
		try {
			__test.setInheritAnthropicEnv(true);
			const env = __test.buildChildEnv();
			assert.equal(env["ANTHROPIC_BASE_URL"], "https://gateway.internal");
			assert.equal(env["ENABLE_CLAUDEAI_MCP_SERVERS"], "0");
		} finally {
			if (saved.key === undefined) delete process.env["ANTHROPIC_BASE_URL"];
			else process.env["ANTHROPIC_BASE_URL"] = saved.key;
		}
	});

	// The SDK env option REPLACES the whole child environment, so a spawn site
	// falling back to raw process.env instead of the builder is exactly the
	// regression this fix targets. Grep the source: the old raw spread must be
	// gone, all three spawn sites (compact summary, provider, AskClaude) must
	// call the builder, and no fourth call may appear silently.
	it("all three spawn sites use buildChildEnv, none spread raw process.env", () => {
		assert.equal(src.match(/\{\s*\.\.\.process\.env,\s*\.\.\.CC_CHILD_ENV\s*\}/g), null,
			"a spawn site still builds the child env with the raw process.env spread");
		assert.equal((src.match(/buildChildEnv\(\)/g) ?? []).length, 4,
			"expected exactly 3 spawn sites calling buildChildEnv() + the definition");
	});
});

describe("resolveInheritAnthropicEnv", () => {
	it("defaults to false (sanitize)", () => {
		assert.equal(resolveInheritAnthropicEnv(undefined), false);
	});
	it("round-trips both boolean values", () => {
		assert.equal(resolveInheritAnthropicEnv(false), false);
		assert.equal(resolveInheritAnthropicEnv(true), true);
	});
	it("throws naming the key on invalid values", () => {
		for (const value of ["true", "false", 1, null, {}]) {
			assert.throws(() => resolveInheritAnthropicEnv(value), /provider\.inheritAnthropicEnv/,
				`expected throw for ${JSON.stringify(value)}`);
		}
	});
});
