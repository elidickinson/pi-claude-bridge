/**
 * Tests for skills block extraction and rewriting.
 * Verifies we correctly extract skills from pi's system prompt and rewrite
 * the read tool reference for the Claude Code MCP bridge.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractSkillsBlock } from "../src/skills.js";

// Realistic pi system prompt with skills block
const SYSTEM_PROMPT = `You are a coding assistant.

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
  <skill>
    <name>br</name>
    <description>Browser automation CLI.</description>
    <location>/Users/esd/projects/pi-my-stuff/skills/br/SKILL.md</location>
  </skill>
  <skill>
    <name>deep-research</name>
    <description>Deep research via parallel web agents.</description>
    <location>/Users/esd/.pi/agent/skills/deep-research/SKILL.md</location>
  </skill>
</available_skills>

Some other system prompt content after skills.`;

describe("skills block extraction", () => {
	it("extracts and rewrites read tool reference", () => {
		const result = extractSkillsBlock(SYSTEM_PROMPT);
		assert.ok(result, "should extract skills block");
		assert.ok(result.includes("Use the read tool (mcp__custom-tools__read) to load a skill's file"));
		assert.ok(!result.includes("Use the read tool to load a skill's file\n"));
	});

	it("preserves skill paths as-is", () => {
		const result = extractSkillsBlock(SYSTEM_PROMPT);
		assert.ok(result.includes("/Users/esd/projects/pi-my-stuff/skills/br/SKILL.md"));
		assert.ok(result.includes("/Users/esd/.pi/agent/skills/deep-research/SKILL.md"));
	});

	it("correct boundaries", () => {
		const result = extractSkillsBlock(SYSTEM_PROMPT);
		assert.ok(result.startsWith("The following skills"));
		assert.ok(result.endsWith("</available_skills>"));
		assert.ok(!result.includes("Some other system prompt"));
	});

	it("no skills in prompt → undefined", () => {
		assert.strictEqual(extractSkillsBlock("Just a normal prompt"), undefined);
		assert.strictEqual(extractSkillsBlock(undefined), undefined);
		assert.strictEqual(extractSkillsBlock(""), undefined);
	});

	it("malformed: start marker but no end marker → undefined", () => {
		const partial = "The following skills provide specialized instructions for specific tasks.\nBut no closing tag.";
		assert.strictEqual(extractSkillsBlock(partial), undefined);
	});
});
