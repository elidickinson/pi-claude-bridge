import type { PromptCapture } from "./prompt-capture.js";

/** What pi hands a before_agent_start handler, narrowed to the fields a guideline comes from. */
export type GuidelineOptions = {
	selectedTools?: string[];
	toolGuidelines?: Record<string, string[]>;
	promptGuidelines?: string[];
};

const GUIDELINES_HEADER =
	"Tool guidelines from the pi harness. These describe the tools exposed here with an `mcp__` prefix: "
	+ "a guideline naming a tool by its bare name (`job`, `memory_edit`) is about that tool.";

/**
 * The guideline lines pi would have put in its own `rules` section.
 *
 * Claude Code replaces pi's system prompt wholesale, so every guideline an extension registers on
 * a tool is dropped unless something forwards it. That is not a cosmetic loss: `memory_edit`'s
 * per-operation argument shapes live in its promptGuidelines and nowhere else -- its JSON schema
 * carries only the `type` enum -- so without this the model gets eight operation names and none of
 * their fields.
 *
 * Selection and dedup follow pi's own buildRules: the per-tool lines of each selected tool in
 * order, then the global ones. What buildRules *generates* is deliberately not reproduced. The
 * ls/grep heuristic and the "be concise" trailers restate what Claude Code's preset already says,
 * and pi's `tools` section names tools without the `mcp__` prefix they carry here, so forwarding
 * it verbatim would document tools that do not exist under those names.
 */
export function selectedGuidelines(options?: GuidelineOptions): string[] {
	const seen = new Set<string>();
	const lines: string[] = [];
	const add = (line: string): void => {
		const normalized = line.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		lines.push(normalized);
	};
	for (const name of options?.selectedTools ?? []) {
		for (const line of options?.toolGuidelines?.[name] ?? []) add(line);
	}
	for (const line of options?.promptGuidelines ?? []) add(line);
	return lines;
}

/** Guidelines visible through inherited prompts, ancestor first and once per line. */
export function collectPromptGuidelines(capture: PromptCapture): string[] {
	const result: string[] = [];
	const seen = new Set<string>();
	const visited = new Set<PromptCapture>();
	const visiting = new Set<PromptCapture>();

	const visit = (node: PromptCapture): void => {
		if (visited.has(node)) return;
		if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");
		visiting.add(node);
		for (const edge of node.inherited) visit(edge.parent);
		for (const line of node.guidelines ?? []) {
			if (seen.has(line)) continue;
			seen.add(line);
			result.push(line);
		}
		visiting.delete(node);
		visited.add(node);
	};

	visit(capture);
	return result;
}

export function renderGuidelinesBlock(guidelines: string[]): string | undefined {
	if (guidelines.length === 0) return undefined;
	return [GUIDELINES_HEADER, ...guidelines.map((line) => `- ${line}`)].join("\n");
}
