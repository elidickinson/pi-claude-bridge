/**
 * Fallbacks for helpers that some pi-compatible hosts do not export.
 *
 * oh-my-pi (omp) loads pi extensions through its own shim of
 * `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent`. That shim
 * lacks `contentText` and `formatSkillsForPrompt`, and a named import of a
 * missing export fails the whole extension at load time. Importing the module
 * namespace and falling back to a local copy keeps pi's own implementation
 * whenever it exists.
 */
import * as piAi from "@earendil-works/pi-ai";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import type { Skill } from "@earendil-works/pi-coding-agent";

type TextBlock = { type: string; text?: string };

/** Copy of pi-ai's `contentText`. */
export function fallbackContentText(content: string | readonly TextBlock[], separator = "\n"): string {
	if (typeof content === "string") return content;
	return content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(separator);
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Copy of pi-coding-agent's `formatSkillsForPrompt` with its default read tool. */
export function fallbackFormatSkillsForPrompt(skills: readonly Skill[]): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
	if (visibleSkills.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

const hostAi = piAi as Partial<typeof piAi>;
const hostCodingAgent = piCodingAgent as Partial<typeof piCodingAgent>;

export const contentText: typeof fallbackContentText = hostAi.contentText ?? fallbackContentText;
export const formatSkillsForPrompt: (skills: Skill[]) => string =
	hostCodingAgent.formatSkillsForPrompt ?? fallbackFormatSkillsForPrompt;
