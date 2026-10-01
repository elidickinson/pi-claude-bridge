#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertSendableStandalonePrompt, PI_PREAMBLE, projectPromptCapture, PromptCaptures } from "../src/prompt-capture.js";

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

		assert.throws(() => projectPromptCapture(found, { skillReadTool: "none" }), (error) => {
			assert.ok(error instanceof Error);
			assert.ok(error.message.includes(PI_PREAMBLE));
			assert.match(error.message, /offset 0 of \d+ chars/);
			assert.match(error.message, /Capture: before_agent_start/);
			assert.match(error.message, /Compatibility with other extensions/);
			return true;
		});
	});

	it("checks the custom text after replacing a matched inherited prompt", () => {
		const captures = new PromptCaptures();
		const parentPrompt = `${PI_PREAMBLE}, a coding agent harness.\n\n<tools>\n- read: Read a file\n</tools>`;
		captures.record(parentPrompt, capture({ contextFiles: [{ path: "/parent/AGENTS.md", content: "parent rules" }] }), "agent_start");
		captures.record("child assembled prompt", capture({
			custom: `child wrapper\n\n${parentPrompt}\n\nchild instructions`,
		}), "agent_start");
		const child = captures.resolve("child assembled prompt");
		assert.ok(child);
		assert.equal(child.inherited.length, 1);

		const projected = projectPromptCapture(child, { skillReadTool: "none" });
		assert.ok(projected);
		assert.ok(!projected.includes(PI_PREAMBLE));
		assert.match(projected, /child wrapper/);
		assert.match(projected, /parent rules/);
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
			() => projectPromptCapture(found, { skillReadTool: "none" }),
			(error) => {
				assert.match(error.message, /docs\/custom-provider\.md and docs\/packages\.md in the project context block/);
				return true;
			},
		);
	});

	it("refuses pi's harness in a standalone prompt and passes an extension's own", () => {
		assert.doesNotThrow(() => assertSendableStandalonePrompt("You are a security reviewer. Reply with JSON."));
		assert.throws(
			() => assertSendableStandalonePrompt(`${PI_PREAMBLE}, a coding agent harness.`),
			(error) => {
				assert.match(error.message, /in the standalone prompt, at offset 0/);
				assert.doesNotMatch(error.message, /Capture:/);
				return true;
			},
		);
		assert.throws(() => assertSendableStandalonePrompt("see docs/custom-provider.md and docs/packages.md"));
	});

	it("ignores either trigger path on its own", () => {
		for (const path of ["docs/custom-provider.md", "docs/packages.md"]) {
			const captures = new PromptCaptures();
			const custom = `see ${path}`;
			captures.record("one path", capture({ custom }), "before_agent_start");

			assert.equal(projectPromptCapture(captures.resolve("one path"), { skillReadTool: "none" }), custom);
		}
	});

	it("ignores a mid-line mention of pi's preamble", () => {
		const captures = new PromptCaptures();
		const custom = `note: ${PI_PREAMBLE}, allegedly`;
		captures.record("mid-line prompt", capture({ custom }), "before_agent_start");
		const found = captures.resolve("mid-line prompt");
		assert.ok(found);

		assert.equal(projectPromptCapture(found, { skillReadTool: "none" }), custom);
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
