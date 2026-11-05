import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

/** pi's skills block, pointed at the MCP read tool. Without that tool Claude can't load a skill. */
export function renderSkillsBlock(skills: Skill[], hasReadTool: boolean): string | undefined {
	if (!hasReadTool || skills.length === 0) return undefined;
	const block = formatSkillsForPrompt(skills).trim();
	if (!block) return undefined;
	return block.replace(
		"Use the read tool to load a skill's file",
		`Use the read tool (${MCP_TOOL_PREFIX}read) to load a skill's file`,
	);
}
