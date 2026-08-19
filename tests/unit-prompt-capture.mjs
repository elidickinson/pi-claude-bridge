#!/usr/bin/env node

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	collectPromptSkills,
	projectPromptCapture,
	PromptCaptures,
	sharedPromptCaptures,
} from "../src/prompt-capture.js";

const PI_HARNESS = "You are an expert coding assistant operating inside pi. Pi documentation: pi packages (docs/packages.md).";
const PARENT_KEY = `${PI_HARNESS}\n\n<project_context>raw parent context</project_context>\nCurrent working directory: /parent`;
const CHILD_SUFFIX = `\n\n<sub_agent_context>child rules</sub_agent_context>\n\n<active_agent name="Plan"/>\n\n# Environment\nWorking directory: /child\n\n<agent_instructions>plan carefully</agent_instructions>`;
const CHILD_KEY = `${PARENT_KEY}${CHILD_SUFFIX}\nCurrent working directory: /child`;

function skill(name, { disabled = false } = {}) {
	return {
		name,
		description: `${name} description`,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		sourceInfo: { source: "test", scope: "temporary", origin: "top-level" },
		disableModelInvocation: disabled,
	};
}

function capture(overrides = {}) {
	return { contextFiles: [], skills: [], ...overrides };
}

function project(captures, key, skillReadTool = "mcp") {
	const found = captures.resolve(key);
	assert.ok(found, `missing capture for ${key.slice(0, 30)}`);
	return projectPromptCapture(found, { skillReadTool });
}

function occurrences(text, needle) {
	return text.split(needle).length - 1;
}

describe("PromptCaptures", () => {
	it("keeps parent and child captures isolated", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));

		assert.equal(captures.resolve(PARENT_KEY).contextFiles.length, 1);
		assert.equal(captures.resolve(CHILD_KEY).contextFiles.length, 0);
		assert.equal(captures.resolve("unknown"), undefined);
		assert.equal(captures.resolve(undefined), undefined);
	});

	it("derives a transient capture when a later extension wrapped the prompt", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({
			contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
			skills: [skill("browser")],
		}));

		// What an extension loading after the bridge produces: our recorded prompt,
		// wrapped in text we never saw.
		const wrapped = `PREFIX FROM ANOTHER EXTENSION\n\n${PARENT_KEY}\n\nSUFFIX`;
		const derived = captures.resolveOrDerive(wrapped);
		const projected = projectPromptCapture(derived, { skillReadTool: "mcp" });

		assert.match(projected, /parent rules/, "the wrapped prompt's own instructions must survive");
		assert.match(projected, /browser/, "and so must its skills");
		// The wrapper's own text is instruction too. Substituting the embedded prompt
		// while discarding what surrounds it would be the silent loss the throw exists
		// to prevent — accept the prompt whole or refuse it, never accept and discard.
		assert.match(projected, /PREFIX FROM ANOTHER EXTENSION/, "the wrapper's prefix must survive");
		assert.match(projected, /SUFFIX/, "and so must its suffix");
		assert.doesNotMatch(projected, /Pi documentation/, "but never Pi's harness, which the projection replaces");
		assert.equal(captures.resolve(wrapped), undefined, "a derived capture is not retained");
	});

	it("revives an exact capture whose lookup key was evicted", () => {
		const captures = new PromptCaptures(2);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));
		// A child keeps the parent node alive by reference even once its key is gone.
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		// Evicts PARENT_KEY's lookup key while the child keeps the node itself alive.
		captures.record("unrelated", capture());
		assert.equal(captures.resolve(PARENT_KEY), undefined, "precondition: the key is gone");

		// findInheritedPrompts skips a node whose key IS the prompt, so an evicted
		// exact match would otherwise embed nothing and throw.
		const revived = captures.resolveOrDerive(PARENT_KEY);
		assert.equal(revived.contextFiles[0].content, "parent rules");
		// Revival re-adds a key that was not in the map, so it has to trim like a write.
		assert.equal(captures.size, 2, "reviving must not grow the map past its bound");
	});

	it("keeps a parent alive that is only ever resolved, never re-recorded", () => {
		// The real shape: one long-lived parent agent, then a stream of sub-agents
		// each recording a prompt of its own. Counting only writes ages the parent out.
		const captures = new PromptCaptures(4);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));

		for (let i = 0; i < 8; i++) {
			assert.ok(captures.resolve(PARENT_KEY), `parent evicted after ${i} sub-agents`);
			captures.record(`sub-agent prompt ${i}`, capture());
		}

		assert.ok(captures.resolve(PARENT_KEY), "the parent must survive its own sub-agents");
		assert.equal(captures.resolve(PARENT_KEY).contextFiles.length, 1);
	});

	it("throws rather than silently dropping instructions it cannot account for", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));

		assert.throws(
			() => captures.resolveOrDerive("a prompt sharing nothing with what we recorded"),
			/no capture for this .* system prompt/,
		);
		// No prompt at all is not a loss — there is nothing to forward.
		assert.equal(captures.resolveOrDerive(undefined), undefined);
	});

	it("recursively projects an inherited prompt without Pi's harness", () => {
		const browser = skill("browser");
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({
			contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }],
			skills: [browser],
		}));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [browser] }));

		const parent = project(captures, PARENT_KEY);
		const child = project(captures, CHILD_KEY);
		assert.ok(child.startsWith(parent), "child should retain the parent's projected cache prefix");
		assert.doesNotMatch(child, /operating inside pi|pi packages/);
		assert.match(child, /parent rules/);
		assert.match(child, /<sub_agent_context>child rules<\/sub_agent_context>/);
		assert.match(child, /<active_agent name="Plan"\/>/);
		assert.match(child, /<agent_instructions>plan carefully<\/agent_instructions>/);
		assert.equal(occurrences(child, "/skills/browser/SKILL.md"), 1);
	});

	it("leaves direct custom and replace-mode prompts byte-identical", () => {
		const captures = new PromptCaptures();
		captures.record("direct assembled", capture({ custom: "  direct user instructions\n" }));
		captures.record("replace assembled", capture({ custom: "<active_agent name=\"review\"/>\nreplace instructions" }));

		assert.equal(project(captures, "direct assembled"), "  direct user instructions\n");
		assert.equal(project(captures, "replace assembled"), "<active_agent name=\"review\"/>\nreplace instructions");
	});

	it("uses the longest inherited key for nested agents", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "parent rules" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		const grandSuffix = "\n\n<sub_agent_context>grandchild rules</sub_agent_context>";
		const grandKey = `${CHILD_KEY}${grandSuffix}\nCurrent working directory: /grandchild`;
		captures.record(grandKey, capture({ custom: `${CHILD_KEY}${grandSuffix}` }));

		const grandchild = project(captures, grandKey);
		assert.doesNotMatch(grandchild, /operating inside pi|Current working directory: \/parent|Current working directory: \/child/);
		assert.equal(occurrences(grandchild, "parent rules"), 1);
		assert.match(grandchild, /child rules/);
		assert.match(grandchild, /grandchild rules/);
	});

	it("retains inherited nodes after their lookup keys are evicted", () => {
		const captures = new PromptCaptures(2);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "survives eviction" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		captures.record("unrelated", capture());

		assert.equal(captures.resolve(PARENT_KEY), undefined);
		assert.match(project(captures, CHILD_KEY), /survives eviction/);
	});

	it("relinks an evicted ancestor through the live inheritance graph", () => {
		const captures = new PromptCaptures(2);
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "reachable ancestor" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		captures.record("unrelated", capture());
		const changedKey = "changed child assembled prompt";
		captures.record(changedKey, capture({ custom: `${PARENT_KEY}\n\nchanged child rules` }));

		const changed = project(captures, changedKey);
		assert.doesNotMatch(changed, /operating inside pi/);
		assert.match(changed, /reachable ancestor/);
		assert.match(changed, /changed child rules/);
	});

	it("updates descendants through a re-recorded parent node", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "rules v1" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}` }));
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "rules v2" }] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, append: "child append" }));

		const child = project(captures, CHILD_KEY);
		assert.doesNotMatch(child, /rules v1|operating inside pi/);
		assert.match(child, /rules v2/);
		assert.match(child, /child append$/);
	});

	it("projects every non-overlapping occurrence of an inherited prompt", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ contextFiles: [{ path: "/AGENTS.md", content: "repeated rules" }] }));
		const repeatedCustom = `${PARENT_KEY}\nseparator\n${PARENT_KEY}`;
		captures.record("repeated child", capture({ custom: repeatedCustom }));

		const result = project(captures, "repeated child");
		assert.doesNotMatch(result, /operating inside pi/);
		assert.equal(occurrences(result, "repeated rules"), 2);
	});

	it("deduplicates inherited skills and preserves child-only skills", () => {
		const browser = skill("browser");
		const review = skill("review");
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ skills: [browser] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [browser, review] }));

		const childCapture = captures.resolve(CHILD_KEY);
		assert.deepEqual(collectPromptSkills(childCapture).map(({ name }) => name), ["browser", "review"]);
		const result = projectPromptCapture(childCapture, { skillReadTool: "mcp" });
		assert.equal(occurrences(result, "/skills/browser/SKILL.md"), 1);
		assert.equal(occurrences(result, "/skills/review/SKILL.md"), 1);
	});

	it("allows an enabled child skill when the inherited copy is hidden", () => {
		const captures = new PromptCaptures();
		captures.record(PARENT_KEY, capture({ skills: [skill("browser", { disabled: true })] }));
		captures.record(CHILD_KEY, capture({ custom: `${PARENT_KEY}${CHILD_SUFFIX}`, skills: [skill("browser")] }));
		assert.equal(occurrences(project(captures, CHILD_KEY), "/skills/browser/SKILL.md"), 1);
	});

	it("is bounded and evicts the least-recently-recorded key", () => {
		const captures = new PromptCaptures(3);
		captures.record("a", capture());
		captures.record("b", capture());
		captures.record("c", capture());
		captures.record("a", capture({ custom: "refreshed" }));
		captures.record("d", capture());

		assert.equal(captures.size, 3);
		assert.equal(captures.resolve("b"), undefined);
		assert.equal(captures.resolve("a").custom, "refreshed");
		assert.ok(captures.resolve("c") && captures.resolve("d"));
	});

	it("shares isolated-agent captures across module instances", async () => {
		const childModule = await import("../src/prompt-capture.js?instance=isolated-child");
		assert.notEqual(childModule.PromptCaptures, PromptCaptures);
		const isolatedPrompt = "You are an isolated smoke-test agent.";

		childModule.sharedPromptCaptures().record(isolatedPrompt, capture({
			custom: isolatedPrompt,
			contextFiles: [{ path: "/AGENTS.md", content: "isolated rules" }],
		}));

		const resolved = sharedPromptCaptures().resolveOrDerive(isolatedPrompt);
		assert.equal(resolved?.assembledPrompt, isolatedPrompt);
		assert.equal(resolved?.contextFiles[0].content, "isolated rules");
	});

	it("bounds the process-wide registry", () => {
		const shared = sharedPromptCaptures();
		for (let i = 0; i < 400; i++) shared.record(`shared-session-key-${i}`, capture());
		assert.ok(shared.size <= 256);
		assert.ok(shared.resolve("shared-session-key-399"));
	});
});
