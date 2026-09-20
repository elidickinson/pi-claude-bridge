#!/usr/bin/env node

/**
 * Tail-stripped inheritance matching (issue #88).
 *
 * gotgenes/pi-subagents embeds a parent prompt in a child minus pi's
 * per-session layers (see `inheritedIdentity` there): the tail cut for a child
 * whose workspace is the parent's, and a one-layer-earlier cut at
 * `<project_context>` for a relocated one (#918 there). The full assembled
 * prompt never appears in either embedding, so matching under the full key
 * alone records no inheritance edge and pi's entire base reaches Claude Code's
 * `--append-system-prompt`, where it trips the subscription OAuth gate.
 *
 * The fixtures mirror pi's real markers: the project-context block byte-exact
 * (open tag, blank line, lead-in sentence — the shape `projectContextStart`
 * locates), the skills catalogue with its heading, and the cwd footer
 * immediately after the closing tag.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectPromptCapture, PromptCaptures } from "../src/prompt-capture.js";

const IDENTITY = "You are an expert coding assistant operating inside pi.\n# Available tools\n- read: Read a file\n- bash: Run commands";

const PROJECT_CONTEXT_BLOCK = [
	"<project_context>",
	"",
	"Project-specific instructions and guidelines:",
	"",
	'<project_instructions path="/parent/AGENTS.md">',
	"Repo rules.",
	"</project_instructions>",
	"",
	"</project_context>",
].join("\n");

const SKILLS_CATALOGUE = [
	"The following skills provide specialized instructions for specific tasks.",
	"Use the read tool to load a skill's file when the task matches its description.",
	"",
	"<available_skills>",
	"  <skill>",
	"    <name>deploy</name>",
	"    <description>Ship the service.</description>",
	"    <location>/parent/.pi/skills/deploy/SKILL.md</location>",
	"  </skill>",
	"</available_skills>",
].join("\n");

const CHILD_SUFFIX = `\n\n<sub_agent_context>child rules</sub_agent_context>\n\n<active_agent name="Plan"/>\n\n# Environment\nWorking directory: /child`;

/** The 0.85-shaped parent: footer line immediately after the catalogue. */
const PARENT_KEY = [
	IDENTITY,
	PROJECT_CONTEXT_BLOCK,
	`${SKILLS_CATALOGUE}\nCurrent working directory: /parent`,
].join("\n\n");

/** The form pi-subagents embeds for a child whose workspace is the parent's. */
const TAIL_KEY = [IDENTITY, PROJECT_CONTEXT_BLOCK].join("\n\n");

/** The form it embeds for a relocated child: cut one layer earlier (#918). */
const RELOCATED_KEY = IDENTITY;

/** The pi ≥0.86 section-rendered parent: same layers, wrapped and joined by
 *  blank lines, the cwd as a section instead of a footer line. */
const SECTION_PARENT_KEY = [
	IDENTITY,
	PROJECT_CONTEXT_BLOCK,
	`<skills>\n${SKILLS_CATALOGUE}\n</skills>`,
	"<cwd>\n/parent\n</cwd>",
].join("\n\n");

function capture(overrides = {}) {
	return { contextFiles: [], skills: [], ...overrides };
}

function recordParent(captures, key = PARENT_KEY, overrides = {}) {
	captures.record(key, capture({
		cwd: "/parent",
		contextFiles: [{ path: "/parent/AGENTS.md", content: "Repo rules." }],
		skills: [{
			name: "deploy",
			description: "Ship the service.",
			filePath: "/parent/.pi/skills/deploy/SKILL.md",
			baseDir: "/parent/.pi/skills/deploy",
		}],
		...overrides,
	}));
}

describe("tail-stripped inheritance (#88)", () => {
	it("matches a same-workspace child under the tail-stripped key, longest match wins", () => {
		const captures = new PromptCaptures();
		recordParent(captures);

		const child = `${TAIL_KEY}${CHILD_SUFFIX}`;
		const derived = captures.resolveOrDerive(child);
		assert.ok(derived, "the stripped child resolves to a derived capture");
		assert.equal(derived.inherited.length, 1, "one inheritance edge");
		assert.equal(derived.inherited[0].end, TAIL_KEY.length, "the tail key (not the shorter project-context key) wins");

		// Projection swaps the parent region for its portable parts: no pi base,
		// no per-session footer; the parent's context file and the child's own
		// wrapper text survive.
		const projected = projectPromptCapture(derived, { skillReadTool: "read" });
		assert.ok(!projected.includes(IDENTITY), "the pi base is not forwarded");
		assert.ok(!projected.includes("Current working directory: /parent"), "the parent footer is not forwarded");
		assert.ok(projected.includes("Repo rules."), "the parent's context file is projected");
		assert.ok(projected.includes("child rules"), "the child's own wrapper text survives");
	});

	it("matches a relocated child under the project-context-stripped key (#918 shape)", () => {
		const captures = new PromptCaptures();
		recordParent(captures);

		const child = `${RELOCATED_KEY}${CHILD_SUFFIX}`;
		const derived = captures.resolveOrDerive(child);
		assert.ok(derived, "the relocated child resolves");
		assert.equal(derived.inherited[0].end, RELOCATED_KEY.length, "the earlier cut matches");

		const projected = projectPromptCapture(derived, { skillReadTool: "read" });
		assert.ok(!projected.includes(IDENTITY), "the pi base is not forwarded");
		assert.ok(projected.includes("Repo rules."), "the parent's context file is re-rendered as a portable part");
		assert.ok(projected.includes("child rules"), "the child's own wrapper text survives");
	});

	it("still matches a child embedding the parent verbatim under the full key", () => {
		const captures = new PromptCaptures();
		recordParent(captures);

		const child = `${PARENT_KEY}${CHILD_SUFFIX}`;
		const derived = captures.resolveOrDerive(child);
		assert.ok(derived, "the verbatim child resolves");
		assert.equal(derived.inherited[0].end, PARENT_KEY.length, "the full key matches");
	});

	it("keeps matching a pre-#959 child whose 0.86 embedding carries the dangling wrapper", () => {
		const captures = new PromptCaptures();
		recordParent(captures, SECTION_PARENT_KEY);

		// Children on a pi-subagents that predates gotgenes#959 embed the parent
		// cut at the heading, leaving the `<skills>` wrapper behind. The heading
		// cut stays a key for them; the wrapper cut is longer but only fits the
		// post-#959 embedding, so longest-match picks the heading cut here.
		const tailKey = [IDENTITY, PROJECT_CONTEXT_BLOCK, "<skills>"].join("\n\n");
		const child = `${tailKey}${CHILD_SUFFIX}`;
		const derived = captures.resolveOrDerive(child);
		assert.ok(derived, "the stripped child resolves without a footer anchor");
		assert.equal(derived.inherited[0].end, tailKey.length, "the heading cut still matches the pre-#959 embedding, longest match wins");
	});

	it("matches a ≥0.86 child embedding cut at the skills-section wrapper (post-#959)", () => {
		const captures = new PromptCaptures();
		recordParent(captures, SECTION_PARENT_KEY);

		// gotgenes#959 moves the same-cwd cut to the wrapper's opening tag, so
		// the embedded region is the tail key without the dangling wrapper line.
		const child = `${TAIL_KEY}${CHILD_SUFFIX}`;
		const derived = captures.resolveOrDerive(child);
		assert.ok(derived, "the wrapper-cut child resolves");
		assert.equal(derived.inherited[0].end, TAIL_KEY.length, "the wrapper cut matches");

		const projected = projectPromptCapture(derived, { skillReadTool: "read" });
		assert.ok(!projected.includes("<skills>"), "the wrapper is not forwarded");
	});

	it("matches a relocated ≥0.86 child: the lead-in sits one line below the opening", () => {
		// The shape that was dead before this change: 0.86's renderer drops the
		// blank line below the opening tag, and the wrapper tag broke the
		// close-tag adjacency — neither guard could find the block.
		const captures = new PromptCaptures();
		recordParent(captures, SECTION_PARENT_KEY);

		const child = `${RELOCATED_KEY}${CHILD_SUFFIX}`;
		const derived = captures.resolveOrDerive(child);
		assert.ok(derived, "the relocated 0.86 child resolves");
		assert.equal(derived.inherited[0].end, RELOCATED_KEY.length, "the project-context cut matches");
	});

	it("records the edge on the child's own record path, not just the derived route", () => {
		const captures = new PromptCaptures();
		recordParent(captures);

		const childKey = `${TAIL_KEY}${CHILD_SUFFIX}\nCurrent working directory: /child`;
		captures.record(childKey, capture({ custom: `${TAIL_KEY}${CHILD_SUFFIX}`, cwd: "/child" }));
		const found = captures.resolve(childKey);
		assert.ok(found, "the child's own prompt is a capture key");
		assert.equal(found.inherited.length, 1, "the record path also sees the stripped-parent edge");
		assert.equal(found.inherited[0].end, TAIL_KEY.length);
	});

	it("does not let a catalogue quoted inside the context block displace the cut (#801)", () => {
		const captures = new PromptCaptures();
		// The parent's context file quotes a catalogue closing tag; the real one
		// is still the line above the footer, and the heading search is bounded
		// by it.
		const quotingBlock = PROJECT_CONTEXT_BLOCK.replace(
			"Repo rules.",
			"Repo rules.\n</available_skills>",
		);
		const parent = [
			IDENTITY,
			quotingBlock,
			`${SKILLS_CATALOGUE}\nCurrent working directory: /parent`,
		].join("\n\n");
		recordParent(captures, parent);

		const tailKey = [IDENTITY, quotingBlock].join("\n\n");
		const child = `${tailKey}${CHILD_SUFFIX}`;
		const derived = captures.resolveOrDerive(child);
		assert.ok(derived, "the quoted catalogue does not displace the cut");
		assert.equal(derived.inherited[0].end, tailKey.length, "the cut still lands at the real skills heading");
	});

	it("still throws for a child that carries neither the full nor a stripped parent", () => {
		const captures = new PromptCaptures();
		recordParent(captures);

		const child = `A child composed outside pi's pipeline quoting the heading alone:\nThe following skills provide specialized instructions for specific tasks.`;
		assert.throws(
			() => captures.resolveOrDerive(child),
			/no capture/,
			"a quote of one marker line is not an inheritance edge",
		);
	});

	it("records no stripped keys for a prompt carrying no session-resolved layer", () => {
		const captures = new PromptCaptures();
		const plain = "A plain prompt with no catalogue, context block or footer";
		captures.record(plain, capture({ cwd: "/parent" }));

		const stored = captures.resolve(plain);
		assert.ok(stored, "the plain prompt is a capture key");
		assert.equal(stored.tailStrippedPrompt, undefined, "no tail layer means no tail key");
		assert.equal(stored.projectContextStrippedPrompt, undefined, "no context layer means no project-context key");
		assert.equal(stored.skillsSectionStrippedPrompt, undefined, "no section shape means no wrapper key");

		// A child quoting one marker line is not an edge either.
		assert.throws(
			() => captures.resolveOrDerive(`Different prompt\nThe following skills provide specialized instructions for specific tasks.`),
			/no capture/,
			"a quote of one marker line is not an inheritance edge",
		);
	});
});
