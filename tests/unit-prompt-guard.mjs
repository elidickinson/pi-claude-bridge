#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PI_PREAMBLE, projectPromptCapture, PromptCaptures } from "../src/prompt-capture.js";

const PI_SYSTEM_PROMPT = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js", import.meta.url));

function capture(overrides = {}) {
	return { contextFiles: [], skills: [], ...overrides };
}

describe("prompt guard", () => {
	it("throws when a recorded custom prompt carries pi's preamble at a line start", () => {
		const captures = new PromptCaptures();
		captures.record("leaking prompt", capture({
			custom: `${PI_PREAMBLE}, a coding agent harness.\n\n<tools>\n- read: Read a file\n</tools>`,
		}), "before_agent_start");
		const found = captures.resolve("leaking prompt");
		assert.ok(found);

		assert.throws(() => projectPromptCapture(found, { hasReadTool: false }), (error) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes(PI_PREAMBLE));
			assert.match(error.message, /offset 0 of \d+ chars/);
			assert.match(error.message, /Capture: before_agent_start/);
			assert.match(error.message, /Compatibility with other extensions/);
			return true;
		});
	});

	it("throws when a context file carries the trigger pair", () => {
		const captures = new PromptCaptures();
		const key = "context-only prompt";
		captures.record(key, capture({
			contextFiles: [{ path: "/AGENTS.md", content: "see docs/custom-provider.md and docs/packages.md" }],
		}), "before_agent_start");
		const found = captures.resolve(key);
		assert.ok(found);

		assert.throws(
			() => projectPromptCapture(found, { hasReadTool: false }),
			(error) => {
				assert.match(error.message, /docs\/custom-provider\.md and docs\/packages\.md in the project context block/);
				return true;
			},
		);
	});

	it("ignores either trigger path on its own", () => {
		for (const path of ["docs/custom-provider.md", "docs/packages.md"]) {
			const captures = new PromptCaptures();
			const custom = `see ${path}`;
			captures.record("one path", capture({ custom }), "before_agent_start");

			assert.equal(projectPromptCapture(captures.resolve("one path"), { hasReadTool: false }), custom);
		}
	});

	it("ignores a mid-line mention of pi's preamble", () => {
		const captures = new PromptCaptures();
		const custom = `note: ${PI_PREAMBLE}, allegedly`;
		captures.record("mid-line prompt", capture({ custom }), "before_agent_start");
		const found = captures.resolve("mid-line prompt");
		assert.ok(found);

		assert.equal(projectPromptCapture(found, { hasReadTool: false }), custom);
	});

	it("pins the guard's marker in pi's own rendered system prompt", async () => {
		assert.ok(
			existsSync(PI_SYSTEM_PROMPT),
			`pi's system prompt module is not at ${PI_SYSTEM_PROMPT}; if pi moved it, update this test`,
		);
		const { buildSystemPrompt } = await import(PI_SYSTEM_PROMPT);
		const harness = buildSystemPrompt({ cwd: "/tmp" });
		assert.ok(
			harness.includes(PI_PREAMBLE),
			"pi reworded its preamble, so the harness guard matches nothing; update PI_PREAMBLE in src/prompt-capture.ts",
		);
		for (const trigger of ["docs/custom-provider.md", "docs/packages.md"]) {
			assert.ok(
				harness.includes(trigger),
				`pi's rendered prompt no longer carries ${trigger}, so the third-party trigger pair may have moved; update ANTHROPIC_THIRD_PARTY_TRIGGERS in src/prompt-capture.ts`,
			);
		}
		// A custom prompt replaces the harness in full, which is what makes these strings'
		// presence mean "this prompt carries pi's harness or its gate fingerprint".
		const custom = buildSystemPrompt({ cwd: "/tmp", customPrompt: "custom" });
		assert.ok(
			!custom.includes(PI_PREAMBLE) && !custom.includes("docs/packages.md"),
			"pi now emits its harness alongside a custom prompt, so these strings no longer imply a leak",
		);
	});
});
