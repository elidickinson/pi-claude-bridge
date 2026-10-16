import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

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

/** pi's escaping for skill fields in the skills block. */
export function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

const SKILLS_BLOCK = /<available_skills>[\s\S]*?<\/available_skills>/g;

/**
 * Where `edited` holds pi's `original` prompt with only the skill list changed — narrowed,
 * reformatted or emptied (pi-dynamic-topic empties it and leaves the intro) — as the span of
 * that prompt and its edited skills section, or undefined. `bare` is pi's render without
 * skills: the two renders differ exactly at the skills section. Fails closed: any other
 * change inside the section, or outside it within pi's prompt, finds no span. Text other
 * extensions wrapped around the span is theirs and stays outside it.
 */
export function skillsEditedPrompt(original: string, bare: string, edited: string): { span: string; section: string } | undefined {
	let prefix = 0;
	while (prefix < bare.length && original[prefix] === bare[prefix]) prefix++;
	let suffix = 0;
	while (suffix < bare.length - prefix && original[original.length - 1 - suffix] === bare[bare.length - 1 - suffix]) suffix++;
	if (prefix + suffix >= original.length) return undefined; // no skills section
	const head = original.slice(0, prefix);
	const tail = original.slice(original.length - suffix);
	const from = edited.indexOf(head);
	const to = from < 0 ? -1 : edited.indexOf(tail, from + head.length);
	if (to < 0) return undefined;
	const section = edited.slice(from + head.length, to);
	const strip = (text: string) => text.replace(SKILLS_BLOCK, "");
	if (strip(section) !== strip(original.slice(prefix, original.length - suffix))) return undefined;
	return { span: edited.slice(from, to + tail.length), section };
}
