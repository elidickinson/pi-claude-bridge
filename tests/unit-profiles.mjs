/**
 * Profile-aware providers (profiles.ts + syncSharedSession's profile keying).
 *
 * Two accounts sharing one bridge is only safe if (a) each child process gets
 * exactly the CLAUDE_CONFIG_DIR its profile dictates — set, inherited, or
 * REMOVED, which macOS keychain namespacing makes three distinct states — and
 * (b) a session tracked under one profile is never resumed or deleted through
 * another profile's config dir.
 */
import { describe, it, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createSession, getSessionPath } from "cc-session-io";

// Rebuild paths write real CC session files — keep them in a throwaway dir.
const defaultClaudeDir = mkdtempSync(join(tmpdir(), "profiles-default-claude-"));
const workClaudeDir = mkdtempSync(join(tmpdir(), "profiles-work-claude-"));
process.env.CLAUDE_CONFIG_DIR = defaultClaudeDir;

const { extraProfiles, profileForProvider, applyProfileEnv, effectiveClaudeDir, DEFAULT_PROFILE, expandHome } =
	await import("../src/profiles.js");
const { labelModels } = await import("../src/models.js");
const { PROVIDER_ID, convertPiMessages } = await import("../src/convert.js");
const { __test } = await import("../src/index.js");

const WORK = { providerId: "claude-bridge-work", label: "Work", configDir: workClaudeDir };

describe("extraProfiles", () => {
	it("builds a provider id, expands ~, defaults the label to the slug", () => {
		const [p] = extraProfiles({ profiles: [{ slug: "work", configDir: "~/.claude-work" }] });
		assert.equal(p.providerId, "claude-bridge-work");
		assert.equal(p.label, "work");
		assert.equal(p.configDir, join(homedir(), ".claude-work"));
		assert.equal(p.stripConfigDir, undefined);
	});

	it("configDir: null means strip, not a path", () => {
		const [p] = extraProfiles({ profiles: [{ slug: "home", label: "Home", configDir: null }] });
		assert.equal(p.configDir, undefined);
		assert.equal(p.stripConfigDir, true);
		assert.equal(p.label, "Home");
	});

	it("drops invalid slugs, duplicates, missing and empty configDir instead of throwing", () => {
		const profiles = extraProfiles({
			profiles: [
				{ slug: "ok", configDir: "/tmp/a" },
				{ slug: "Bad Slug!", configDir: "/tmp/b" },
				{ slug: "ok", configDir: "/tmp/c" },
				{ slug: "no-dir" },
				// "" is falsy everywhere downstream — accepted, it would silently
				// alias the inherited account under a differently-labeled picker entry.
				{ slug: "empty", configDir: "" },
				{ slug: "blank", configDir: "   " },
			],
		});
		assert.deepEqual(profiles.map((p) => p.providerId), ["claude-bridge-ok"]);
	});

	it("memoizes per settings object — hot-path calls must not revalidate", () => {
		const settings = { profiles: [{ slug: "work", configDir: "/tmp/a" }] };
		assert.equal(extraProfiles(settings), extraProfiles(settings));
	});

	it("empty and absent lists yield no extra providers", () => {
		assert.deepEqual(extraProfiles({}), []);
		assert.deepEqual(extraProfiles(undefined), []);
		assert.deepEqual(extraProfiles({ profiles: [] }), []);
	});
});

describe("profileForProvider", () => {
	const settings = { profiles: [{ slug: "work", label: "Work", configDir: workClaudeDir }] };

	it("default for undefined, the base provider id, and non-bridge ids", () => {
		assert.equal(profileForProvider(undefined, settings), DEFAULT_PROFILE);
		assert.equal(profileForProvider(PROVIDER_ID, settings), DEFAULT_PROFILE);
		assert.equal(profileForProvider("openai-codex", settings), DEFAULT_PROFILE);
	});

	it("throws for a claude-bridge-* id with no configured profile — never silently the wrong account", () => {
		assert.throws(() => profileForProvider("claude-bridge-gone", settings), /no configured profile/);
	});

	it("resolves a configured profile by provider id", () => {
		const p = profileForProvider("claude-bridge-work", settings);
		assert.equal(p.configDir, workClaudeDir);
	});
});

describe("applyProfileEnv", () => {
	it("pins CLAUDE_CONFIG_DIR and drops inherited credential overrides for a configDir profile", () => {
		// CLAUDE_CODE_OAUTH_TOKEN beats the config dir's stored login (verified:
		// auth status flips to oauth_token), so a host that authenticates its
		// default account via env would run every profile on that one account.
		const env = applyProfileEnv(
			{ CLAUDE_CONFIG_DIR: "/inherited", CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "key", OTHER: "kept" },
			WORK,
		);
		assert.equal(env.CLAUDE_CONFIG_DIR, workClaudeDir);
		assert.equal("CLAUDE_CODE_OAUTH_TOKEN" in env, false);
		assert.equal("ANTHROPIC_API_KEY" in env, false);
		assert.equal(env.OTHER, "kept");
	});

	it("REMOVES the variable for a strip profile — unset and ~/.claude are not equivalent — but keeps inherited credentials (it aliases the default account)", () => {
		const env = applyProfileEnv(
			{ CLAUDE_CONFIG_DIR: "/inherited", CLAUDE_CODE_OAUTH_TOKEN: "tok", OTHER: "kept" },
			{ providerId: "claude-bridge-home", stripConfigDir: true },
		);
		assert.equal("CLAUDE_CONFIG_DIR" in env, false);
		assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "tok");
		assert.equal(env.OTHER, "kept");
	});

	it("inherits untouched for the default profile", () => {
		const env = applyProfileEnv({ CLAUDE_CONFIG_DIR: "/inherited" }, DEFAULT_PROFILE);
		assert.equal(env.CLAUDE_CONFIG_DIR, "/inherited");
	});
});

describe("effectiveClaudeDir", () => {
	it("profile dir; inherited env for default", () => {
		assert.equal(effectiveClaudeDir(WORK), workClaudeDir);
		assert.equal(effectiveClaudeDir(DEFAULT_PROFILE), defaultClaudeDir);
	});

	// cc-session-io's fallback chain is `claudeDir ?? env.CLAUDE_CONFIG_DIR ??
	// ~/.claude`. A strip profile's child reads ~/.claude, so pi must WRITE
	// there explicitly — returning undefined here (with CLAUDE_CONFIG_DIR
	// inherited, as in this suite) would make pi write one store while the
	// child reads another, and every resume would fail.
	it("strip profile pins ~/.claude even when the process inherits CLAUDE_CONFIG_DIR", () => {
		assert.equal(effectiveClaudeDir({ providerId: "x", stripConfigDir: true }), join(homedir(), ".claude"));
	});
});

describe("labelModels", () => {
	it("suffixes display names and leaves ids alone", () => {
		const models = labelModels([{ id: "claude-opus-5", name: "Opus 5 1M" }], "Work");
		assert.deepEqual(models, [{ id: "claude-opus-5", name: "Opus 5 1M (Work)" }]);
	});
});

describe("thinking replay across profiles", () => {
	// A signature is only ours to hand back to the account that minted it.
	// Cross-profile replays must drop the thinking block — same treatment as
	// thinking from any other provider.
	const history = [
		{ role: "user", content: "hi" },
		{
			role: "assistant",
			provider: PROVIDER_ID,
			content: [
				{ type: "thinking", thinking: "private reasoning", thinkingSignature: "sig-abc" },
				{ type: "text", text: "hello" },
			],
		},
	];

	const blockTypes = (msgs) => msgs[1].content.map((b) => b.type);

	it("replays thinking for the same profile's provider id", () => {
		const { anthropicMessages } = convertPiMessages(history, undefined, PROVIDER_ID);
		assert.deepEqual(blockTypes(anthropicMessages), ["thinking", "text"]);
	});

	it("drops thinking when a different profile rebuilds the history", () => {
		const { anthropicMessages } = convertPiMessages(history, undefined, "claude-bridge-work");
		assert.deepEqual(blockTypes(anthropicMessages), ["text"]);
	});
});

describe("expandHome", () => {
	it("expands ~ and ~/ but not mid-path tildes", () => {
		assert.equal(expandHome("~"), homedir());
		assert.equal(expandHome("~/.claude-work"), join(homedir(), ".claude-work"));
		assert.equal(expandHome("/abs/~x"), "/abs/~x");
	});
});

describe("syncSharedSession profile keying", () => {
	after(() => {
		rmSync(defaultClaudeDir, { recursive: true, force: true });
		rmSync(workClaudeDir, { recursive: true, force: true });
	});

	afterEach(() => {
		__test.resetSharedSession();
	});

	const userMsg = (text) => ({ role: "user", content: text, timestamp: Date.now() });
	const assistantMsg = (text) => ({ role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() });

	it("a profile switch rotates the session and leaves the other profile's file alone", () => {
		const cwd = mkdtempSync(join(tmpdir(), "profiles-sync-"));
		try {
			// A tracked session written under the DEFAULT profile, with a real file.
			const tracked = createSession({ projectPath: cwd, claudeDir: defaultClaudeDir });
			tracked.importMessages([{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "hello" }] }]);
			tracked.save();
			__test.setSharedSession({ sessionId: tracked.sessionId, cursor: 2, cwd });

			// Same history, but the query arrives on the work profile. Without the
			// profile guard this REUSEs — and the work-account CC child then fails
			// with "No conversation found" because its config dir can't see the file.
			const messages = [userMsg("hi"), assistantMsg("hello"), userMsg("next question")];
			const result = __test.syncSharedSession(messages, cwd, undefined, undefined, WORK);

			assert.notEqual(result.sessionId, null);
			assert.notEqual(result.sessionId, tracked.sessionId, "must not resume a foreign profile's session id");
			const state = __test.getSharedSession();
			assert.equal(state.providerId, "claude-bridge-work");
			assert.ok(existsSync(getSessionPath(result.sessionId, cwd, workClaudeDir)), "rebuilt session must live in the work profile's dir");
			assert.ok(existsSync(tracked.jsonlPath), "the default profile's file must be left untouched");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("the same profile still REUSEs its tracked session", () => {
		const cwd = mkdtempSync(join(tmpdir(), "profiles-sync-"));
		try {
			const messages = [userMsg("hi"), assistantMsg("hello"), userMsg("next question")];
			const first = __test.syncSharedSession(messages, cwd, undefined, undefined, WORK);
			assert.notEqual(first.sessionId, null);

			const again = __test.syncSharedSession(messages, cwd, undefined, undefined, WORK);
			assert.equal(again.sessionId, first.sessionId, "same profile with unchanged history must resume");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("pre-profile states (providerId undefined) mean the default profile", () => {
		const cwd = mkdtempSync(join(tmpdir(), "profiles-sync-"));
		try {
			const tracked = createSession({ projectPath: cwd, claudeDir: defaultClaudeDir });
			tracked.importMessages([{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "hello" }] }]);
			tracked.save();
			__test.setSharedSession({ sessionId: tracked.sessionId, cursor: 2, cwd });

			const messages = [userMsg("hi"), assistantMsg("hello"), userMsg("next question")];
			const result = __test.syncSharedSession(messages, cwd);
			assert.equal(result.sessionId, tracked.sessionId, "default profile must keep resuming pre-profile sessions");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
