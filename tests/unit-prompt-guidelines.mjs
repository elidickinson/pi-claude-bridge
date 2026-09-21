#!/usr/bin/env node

/**
 * pi's tool and prompt guidelines survive Claude Code's preset.
 *
 * The preset replaces pi's system prompt wholesale, so pi's `rules` section — every
 * guideline an extension registers on a tool — reaches the model only if the
 * projection carries it. That is not a cosmetic loss: a tool whose JSON Schema is
 * deliberately loose (a `{ type: string }` discriminator, with the per-operation
 * argument shapes written as guidelines) arrives with its operation names and none
 * of their fields, and the model has to guess the call.
 *
 * These pin the selection rule pi's own buildRules uses, and that an inherited
 * prompt's guidelines are projected once rather than restated inside the child's.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { PromptCaptures, projectPromptCapture } from "../src/prompt-capture.js";
import { renderGuidelinesBlock, selectedGuidelines } from "../src/prompt-guidelines.js";

const options = {
	selectedTools: ["job", "memory_edit", "read"],
	toolGuidelines: {
		job: ["Start the job, end the turn, and continue from its completion message."],
		memory_edit: ["patch({ nodeId: string, body: string }) replaces a node's full body."],
		// Registered but not selected for this run, exactly as pi's own buildRules filters it.
		grep: ["Never forwarded."],
	},
	promptGuidelines: ["A global rule.", "  Start the job, end the turn, and continue from its completion message.  "],
};

describe("selectedGuidelines", () => {
	it("takes the selected tools' lines then the global ones, and drops the rest", () => {
		assert.deepEqual(selectedGuidelines(options), [
			"Start the job, end the turn, and continue from its completion message.",
			"patch({ nodeId: string, body: string }) replaces a node's full body.",
			"A global rule.",
		]);
	});

	it("survives a run with no guidelines at all", () => {
		assert.deepEqual(selectedGuidelines(undefined), []);
		assert.equal(renderGuidelinesBlock([]), undefined);
	});
});

describe("the projected append", () => {
	const record = (captures, prompt, guidelines, custom) =>
		captures.record(prompt, { custom, contextFiles: [], skills: [], guidelines });

	it("carries the guidelines Claude Code's preset would otherwise replace away", () => {
		const captures = new PromptCaptures();
		record(captures, "PI PROMPT", selectedGuidelines(options));

		const append = projectPromptCapture(captures.resolve("PI PROMPT"), { skillReadTool: "mcp" });
		assert.match(append, /patch\(\{ nodeId: string, body: string \}\)/);
		assert.match(append, /- A global rule\./);
	});

	it("does not restate a parent's guidelines inside a child's block", () => {
		// A sub-agent prompt embeds its parent's assembled prompt verbatim; the parent's
		// projection is substituted in place, so repeating the shared lines would send them twice.
		const captures = new PromptCaptures();
		record(captures, "PARENT", ["Shared rule.", "Parent-only rule."]);
		record(captures, "CHILD", ["Shared rule.", "Child-only rule."], "before PARENT after");

		const append = projectPromptCapture(captures.resolve("CHILD"), { skillReadTool: "mcp" });
		assert.equal(append.match(/Shared rule\./g)?.length, 1, "the shared line is sent once");
		assert.match(append, /Parent-only rule\./);
		assert.match(append, /Child-only rule\./);
	});

	it("still projects a capture recorded without guidelines", () => {
		// resolveOrDerive builds captures with no guidelines of their own; reading them must not throw.
		const captures = new PromptCaptures();
		captures.record("BARE", { contextFiles: [{ path: "AGENTS.md", content: "rule" }], skills: [] });

		const append = projectPromptCapture(captures.resolve("BARE"), { skillReadTool: "mcp" });
		assert.match(append, /AGENTS\.md/);
		assert.doesNotMatch(append, /pi harness/);
	});
});
