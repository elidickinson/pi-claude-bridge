/**
 * Tests for system prompt mode resolution and per-mode assembly.
 *
 * Covers the bug surfaced in manual review: `systemPromptMode: false` was
 * silently sending a ~6k string because extracts were computed
 * unconditionally, and the deprecated `appendSystemPrompt: false` was being
 * flipped to drop the CC preset (0.4.0 had it the other way around). This
 * suite asserts the four-mode shape and the BC preservation.
 *
 * Hermeticity: `extractAgentsAppend` walks up from process.cwd() and falls
 * back to ~/.pi/agent/AGENTS.md, which the user's home may have. Tests pass
 * `includeAgentsMd: false` explicitly unless they're testing AGENTS.md
 * inclusion (none here — extractAgentsAppend is exercised separately in
 * agents-md tests).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveSystemPromptMode } from "../src/config.js";
import { resolveSystemPromptConfig } from "../src/system-prompt.js";

// Convenience: hermetic options that disable both extracts. Use in any test
// where the extract contents aren't the thing under test.
const NO_EXTRACTS = { includeAgentsMd: false, includeSkills: false };

describe("resolveSystemPromptMode", () => {
	it("default (no config) → append", () => {
		assert.equal(resolveSystemPromptMode(undefined), "append");
		assert.equal(resolveSystemPromptMode({}), "append");
	});

	it("legacy appendSystemPrompt: true → append (BC)", () => {
		assert.equal(resolveSystemPromptMode({ appendSystemPrompt: true }), "append");
	});

	it("legacy appendSystemPrompt: false → legacy-preset-only (BC preserves 0.4.0 behavior)", () => {
		// 0.4.0 had: preset kept, no pi additions, settingSources default ["user","project"].
		// NOT equivalent to the new "false" mode (no system prompt at all).
		assert.equal(resolveSystemPromptMode({ appendSystemPrompt: false }), "legacy-preset-only");
	});

	it("new systemPromptMode passes through", () => {
		assert.equal(resolveSystemPromptMode({ systemPromptMode: "append" }), "append");
		assert.equal(resolveSystemPromptMode({ systemPromptMode: "replace" }), "replace");
		assert.equal(resolveSystemPromptMode({ systemPromptMode: false }), false);
	});

	it("new flag wins when both flags are set", () => {
		assert.equal(
			resolveSystemPromptMode({ appendSystemPrompt: false, systemPromptMode: "replace" }),
			"replace",
		);
		assert.equal(
			resolveSystemPromptMode({ appendSystemPrompt: true, systemPromptMode: false }),
			false,
		);
		assert.equal(
			resolveSystemPromptMode({ appendSystemPrompt: false, systemPromptMode: "append" }),
			"append",
		);
	});
});

describe("resolveSystemPromptConfig — append mode (default)", () => {
	it("default empty config: preset, no append, settingSources undefined (BC with upstream)", () => {
		const cfg = resolveSystemPromptConfig({}, "pi prompt with no skills", NO_EXTRACTS);
		assert.equal(cfg.mode, "append");
		assert.equal(cfg.systemPrompt.type, "preset");
		assert.equal(cfg.systemPrompt.preset, "claude_code");
		assert.equal(cfg.systemPrompt.append, undefined);
		// Upstream default: undefined = SDK loads all sources (incl. local).
		assert.equal(cfg.settingSources, undefined);
	});

	it("with skills in prompt and includeSkills: true: preset + rewritten skills block", () => {
		const prompt = [
			"You are pi.",
			"",
			"The following skills provide specialized instructions for specific tasks.",
			"Use the read tool to load a skill's file when the task matches its description.",
			"",
			"<available_skills>",
			"  <skill><name>br</name></skill>",
			"</available_skills>",
		].join("\n");
		const cfg = resolveSystemPromptConfig({}, prompt, {
			includeAgentsMd: false,
			includeSkills: true,
		});
		assert.equal(cfg.mode, "append");
		assert.equal(cfg.systemPrompt.type, "preset");
		assert.ok(
			cfg.systemPrompt.append?.includes("Use the read tool (mcp__custom-tools__read)"),
			"skills block should be rewritten with MCP read tool",
		);
	});

	it("includeAgentsMd: false skips AGENTS.md walking", () => {
		const cfg = resolveSystemPromptConfig({}, "no skills", { includeAgentsMd: false });
		assert.equal(cfg.systemPrompt.type, "preset");
		assert.equal(cfg.systemPrompt.append, undefined);
	});

	it("includeSkills: false skips skills extraction", () => {
		const prompt = [
			"The following skills provide specialized instructions for specific tasks.",
			"Use the read tool to load a skill's file.",
			"",
			"<available_skills>",
			"  <skill><name>br</name></skill>",
			"</available_skills>",
		].join("\n");
		const cfg = resolveSystemPromptConfig({}, prompt, {
			includeAgentsMd: false,
			includeSkills: false,
		});
		assert.equal(cfg.systemPrompt.type, "preset");
		assert.equal(cfg.systemPrompt.append, undefined);
	});

	it("user-configured settingSources is passed through", () => {
		const cfg = resolveSystemPromptConfig(
			{ settingSources: ["user"] },
			undefined,
			NO_EXTRACTS,
		);
		assert.deepEqual(cfg.settingSources, ["user"]);
	});

	it("append mode does not silently drop skills from prompt", () => {
		// Sanity: when includeSkills is true (default), skills in the prompt
		// show up in append. The original bug was the opposite — extracts
		// running even in "false" mode. This is the positive control.
		const prompt = "Skills block:\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file.\n<available_skills>\n  <skill><name>br</name></skill>\n</available_skills>";
		const cfg = resolveSystemPromptConfig({}, prompt, { includeAgentsMd: false });
		assert.ok(cfg.systemPrompt.append, "append mode should include skills");
	});
});

describe("resolveSystemPromptConfig — legacy-preset-only (BC for appendSystemPrompt: false)", () => {
	it("preset kept, append undefined, settingSources defaults to [user,project]", () => {
		const cfg = resolveSystemPromptConfig(
			{ appendSystemPrompt: false },
			"pi prompt",
		);
		assert.equal(cfg.mode, "legacy-preset-only");
		assert.equal(cfg.systemPrompt.type, "preset");
		assert.equal(cfg.systemPrompt.preset, "claude_code");
		assert.equal(cfg.systemPrompt.append, undefined);
		assert.deepEqual(cfg.settingSources, ["user", "project"]);
	});

	it("does NOT drop the CC preset (regression for the silent flip)", () => {
		// The bug from review: appendSystemPrompt: false used to keep the
		// CC preset; the PR flipped this to drop the preset. legacy-preset-only
		// preserves the original behavior.
		const cfg = resolveSystemPromptConfig({ appendSystemPrompt: false }, "pi prompt");
		assert.equal(cfg.systemPrompt.type, "preset");
		assert.equal(cfg.systemPrompt.preset, "claude_code");
	});

	it("user-configured settingSources wins over default", () => {
		const cfg = resolveSystemPromptConfig(
			{ appendSystemPrompt: false, settingSources: ["user"] },
			"pi prompt",
		);
		assert.deepEqual(cfg.settingSources, ["user"]);
	});
});

describe("resolveSystemPromptConfig — replace mode", () => {
	it("passes pi's prompt through verbatim, no CC settings", () => {
		const cfg = resolveSystemPromptConfig(
			{ systemPromptMode: "replace" },
			"pi prompt verbatim",
		);
		assert.equal(cfg.mode, "replace");
		assert.equal(cfg.systemPrompt, "pi prompt verbatim");
		assert.deepEqual(cfg.settingSources, []);
	});

	it("undefined pi prompt → empty string (NOT the extracted 6k string)", () => {
		const cfg = resolveSystemPromptConfig(
			{ systemPromptMode: "replace" },
			undefined,
		);
		assert.equal(cfg.systemPrompt, "");
		assert.deepEqual(cfg.settingSources, []);
	});

	it("includes skills verbatim (no MCP rewrite) — pi+Sonnet mode", () => {
		const prompt = [
			"The following skills provide specialized instructions for specific tasks.",
			"Use the read tool to load a skill's file.",
			"",
			"<available_skills>",
			"  <skill><name>br</name></skill>",
			"</available_skills>",
		].join("\n");
		const cfg = resolveSystemPromptConfig({ systemPromptMode: "replace" }, prompt);
		assert.equal(cfg.systemPrompt, prompt);
		assert.ok(
			!String(cfg.systemPrompt).includes("mcp__custom-tools__read"),
			"replace mode must NOT rewrite skills — that's pi+Sonnet semantics",
		);
	});
});

describe("resolveSystemPromptConfig — false mode (regression for review bug)", () => {
	it("empty string, no CC settings, NO 6k string", () => {
		// Regression test: previously, false mode silently sent ~6k chars
		// because extracts were computed unconditionally and joined into
		// systemPromptContent. Doc comment says "no system prompt at all".
		const cfg = resolveSystemPromptConfig({ systemPromptMode: false }, "pi prompt");
		assert.equal(cfg.mode, false);
		assert.equal(cfg.systemPrompt, "");
		assert.deepEqual(cfg.settingSources, []);
	});

	it("empty string even with skills in pi prompt (extracts are gated off)", () => {
		const prompt = [
			"The following skills provide specialized instructions for specific tasks.",
			"Use the read tool to load a skill's file.",
			"",
			"<available_skills>",
			"  <skill><name>br</name></skill>",
			"</available_skills>",
		].join("\n");
		const cfg = resolveSystemPromptConfig({ systemPromptMode: false }, prompt);
		assert.equal(cfg.systemPrompt, "");
		assert.deepEqual(cfg.settingSources, []);
	});

	it("empty string regardless of includeAgentsMd/includeSkills flags", () => {
		// Same shape as upstream pre-PR code, but documents that the gate
		// is at the mode level (helper's switch), not at the include flag.
		const cfg = resolveSystemPromptConfig(
			{ systemPromptMode: false },
			"pi prompt",
			{ includeAgentsMd: true, includeSkills: true },
		);
		assert.equal(cfg.systemPrompt, "");
	});
});