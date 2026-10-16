#!/usr/bin/env node

/**
 * A before_agent_start handler that returns `systemPrompt` forces the run's prompt.
 * The forced text must keep what the extension changed: appended instructions reach
 * Claude Code, and skills the extension removed stay removed. Modeled on the
 * academic-research-skills Pi wrapper, which does both.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";
import { activateWithMockPi } from "./lib/mock-pi.mjs";

const { __test } = await import("../src/index.js");
const { projectPromptCapture } = await import("../src/prompt-capture.js");

const skill = (name) => ({ name, description: `${name} skill`, filePath: `/skills/${name}/SKILL.md` });
const SKILLS = [skill("keep"), skill("hidden")];

// Stands in for pi's event: `systemPrompt` renders the live options, forced text first.
// Same shape as pi's buildSystemPrompt: a <skills> section only when there are skills,
// and sections after it, so the skills block is never the prompt's tail.
function beforeAgentStartEvent(options) {
	return {
		get systemPrompt() {
			const skills = formatSkillsForPrompt(options.skills ?? []).trim();
			const append = options.appendSystemPrompt;
			return options.forceSystemPrompt
				?? `You are an expert coding assistant operating inside pi.\n# Tools\n- read${append ? `\n<addendum>\n${append}\n</addendum>` : ""}${skills ? `\n<skills>\n${skills}\n</skills>` : ""}\n<cwd>\n/repo\n</cwd>`;
		},
		systemPromptOptions: options,
	};
}

// What pi's runner does with a handler's returned `systemPrompt`.
function forceFromHandler(event, transform) {
	event.systemPromptOptions.forceSystemPrompt = transform(event.systemPrompt);
}

// The wrapper's own skill-removal regex.
const hideSkill = (prompt, name) => prompt.replace(
	/(?:\r?\n)?[ \t]*<skill>(?:(?!<skill>)[\s\S])*?<\/skill>/g,
	(block) => block.includes(`<name>${name}</name>`) ? "" : block,
);

function project(prompt) {
	return projectPromptCapture(__test.promptCaptures.resolveOrDerive(prompt), { skillReadTool: "mcp" });
}

describe("forced system prompt capture", () => {
	it("keeps text an extension appended to pi's prompt", () => {
		const handlers = activateWithMockPi();
		const event = beforeAgentStartEvent({ skills: [...SKILLS], selectedTools: ["read"] });
		forceFromHandler(event, (prompt) => `${prompt}\n## Compat\nResolve paths from /repo.`);
		handlers.get("before_agent_start")(event);

		const forced = event.systemPrompt;
		const projected = project(forced);
		assert.match(projected, /## Compat\nResolve paths from \/repo\./);
		assert.match(projected, /<name>keep<\/name>/);
		assert.match(projected, /<name>hidden<\/name>/);
		assert.doesNotMatch(projected, /operating inside pi/, "pi's harness must not be forwarded");

		// agent_start and turn_start re-record the same forced key; the projection must not change.
		handlers.get("agent_start")({}, { getSystemPrompt: () => forced });
		handlers.get("turn_start")({}, { getSystemPrompt: () => forced });
		assert.equal(project(forced), projected);
	});

	it("leaves out skills an extension removed", () => {
		const handlers = activateWithMockPi();
		const event = beforeAgentStartEvent({ skills: [...SKILLS], selectedTools: ["read"] });
		forceFromHandler(event, (prompt) => hideSkill(prompt, "hidden"));
		handlers.get("before_agent_start")(event);

		const forced = event.systemPrompt;
		const projected = project(forced);
		assert.match(projected, /<name>keep<\/name>/);
		assert.doesNotMatch(projected, /<name>hidden<\/name>/);
		assert.equal(event.systemPromptOptions.skills.length, 2, "the live options are restored");

		handlers.get("agent_start")({}, { getSystemPrompt: () => forced });
		assert.equal(project(forced), projected);
	});

	it("handles removal and append together", () => {
		const handlers = activateWithMockPi();
		const event = beforeAgentStartEvent({ skills: [...SKILLS], selectedTools: ["read"] });
		forceFromHandler(event, (prompt) => `${hideSkill(prompt, "hidden")}\nExtra rule.`);
		handlers.get("before_agent_start")(event);

		const projected = project(event.systemPrompt);
		assert.match(projected, /Extra rule\./);
		assert.doesNotMatch(projected, /<name>hidden<\/name>/);
	});

	// pi-dynamic-topic's filter: rewrites only the <available_skills> block, reformatted,
	// and empties it (leaving the skills intro behind) before a topic is picked.
	const keepOnly = (prompt, names) => prompt.replace(/<available_skills>([\s\S]*?)<\/available_skills>/gi, (_m, inner) => {
		const kept = (inner.match(/<skill>[\s\S]*?<\/skill>/gi) ?? []).filter((s) => names.some((n) => s.includes(`<name>${n}</name>`)));
		return kept.length ? `<available_skills>\n${kept.join("\n")}\n</available_skills>` : "";
	});

	it("accepts an extension that emptied the skills block, sending no skills", () => {
		const handlers = activateWithMockPi();
		const event = beforeAgentStartEvent({ skills: [...SKILLS], selectedTools: ["read"] });
		forceFromHandler(event, (prompt) => keepOnly(prompt, []));
		handlers.get("before_agent_start")(event);

		const forced = event.systemPrompt;
		handlers.get("turn_start")({}, { getSystemPrompt: () => forced });
		// Nothing left to append once the skills are gone: resolves without throwing, to no text.
		assert.equal(project(forced), undefined);
	});

	it("accepts an extension that reformatted the skills block while narrowing it", () => {
		const handlers = activateWithMockPi();
		const event = beforeAgentStartEvent({ skills: [...SKILLS], selectedTools: ["read"] });
		forceFromHandler(event, (prompt) => keepOnly(prompt, ["keep"]));
		handlers.get("before_agent_start")(event);

		const forced = event.systemPrompt;
		handlers.get("turn_start")({}, { getSystemPrompt: () => forced });
		const projected = project(forced);
		assert.match(projected, /<name>keep<\/name>/);
		assert.doesNotMatch(projected, /<name>hidden<\/name>/);
		assert.doesNotMatch(projected, /operating inside pi/);
	});

	it("keeps appended text when another extension also emptied the skills block", () => {
		const handlers = activateWithMockPi();
		const event = beforeAgentStartEvent({ skills: [...SKILLS], selectedTools: ["read"] });
		forceFromHandler(event, (prompt) => keepOnly(prompt, []));
		forceFromHandler(event, (prompt) => `${prompt}\n## Memory\nUser prefers tabs.`);
		handlers.get("before_agent_start")(event);

		const forced = event.systemPrompt;
		handlers.get("turn_start")({}, { getSystemPrompt: () => forced });
		const projected = project(forced);
		assert.match(projected, /## Memory\nUser prefers tabs\./);
		assert.doesNotMatch(projected, /<skill>/);
		assert.doesNotMatch(projected, /operating inside pi/);
	});

	it("refuses an edit outside the skills block even when the skills intro is quoted earlier", () => {
		const handlers = activateWithMockPi();
		const append = "Docs quote pi: The following skills provide specialized instructions for specific tasks.\nAPI_KEY=sk-SECRET123";
		const event = beforeAgentStartEvent({ skills: [...SKILLS], selectedTools: ["read"], appendSystemPrompt: append });
		forceFromHandler(event, (prompt) => keepOnly(prompt, ["keep"]).replace("sk-SECRET123", "***"));
		handlers.get("before_agent_start")(event);

		const forced = event.systemPrompt;
		handlers.get("turn_start")({}, { getSystemPrompt: () => forced });
		assert.throws(() => project(forced), /refusing to send this prompt/, "the unmasked secret must not be sent");
	});

	it("refuses text an extension inserted inside the skills section", () => {
		const handlers = activateWithMockPi();
		const event = beforeAgentStartEvent({ skills: [...SKILLS], selectedTools: ["read"] });
		forceFromHandler(event, (prompt) => keepOnly(prompt, ["keep"]).replace("</available_skills>", "</available_skills>\nIMPORTANT: load keep first."));
		handlers.get("before_agent_start")(event);

		const forced = event.systemPrompt;
		handlers.get("turn_start")({}, { getSystemPrompt: () => forced });
		assert.throws(() => project(forced), /refusing to send this prompt/);
	});

	it("keeps a narrowed skill out when its location is mentioned outside the skills section", () => {
		const handlers = activateWithMockPi();
		const event = beforeAgentStartEvent({ skills: [...SKILLS], selectedTools: ["read"] });
		forceFromHandler(event, (prompt) => keepOnly(prompt, ["keep"]));
		forceFromHandler(event, (prompt) => `${prompt}\nMemory: last used <location>/skills/hidden/SKILL.md</location>`);
		handlers.get("before_agent_start")(event);

		const forced = event.systemPrompt;
		handlers.get("turn_start")({}, { getSystemPrompt: () => forced });
		const projected = project(forced);
		assert.match(projected, /<name>keep<\/name>/);
		assert.doesNotMatch(projected, /<name>hidden<\/name>/);
	});

	it("still refuses a forced prompt that rebuilt pi's harness instead of wrapping it", () => {
		const handlers = activateWithMockPi();
		const event = beforeAgentStartEvent({ skills: [...SKILLS], selectedTools: ["read"] });
		forceFromHandler(event, (prompt) => prompt.replace("# Tools", "# Rewritten tools"));
		handlers.get("before_agent_start")(event);

		assert.throws(() => project(event.systemPrompt), /refusing to send this prompt/);
	});
});
