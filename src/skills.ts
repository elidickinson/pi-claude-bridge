import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "./host-compat.js";

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

export type SkillReadTool = "mcp" | "native" | "none";

export function renderSkillsBlock(skills: Skill[], readTool: SkillReadTool): string | undefined {
	if (readTool === "none" || skills.length === 0) return undefined;
	const block = formatSkillsForPrompt(skills).trim();
	if (!block) return undefined;
	return readTool === "mcp" ? rewriteSkillsBlock(block) : block;
}

export function rewriteSkillsBlock(skillsBlock: string): string {
	return skillsBlock.replace(
		"Use the read tool to load a skill's file",
		`Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`,
	);
}
