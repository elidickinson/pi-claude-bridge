import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatProjectContext } from "./agents-md.js";
import { renderSkillsBlock, type SkillReadTool } from "./skills.js";

// What pi assembled for one agent, kept so the bridge can append only the
// portable parts after Claude Code's own preset.

export type PromptCaptureInput = {
	custom?: string;
	append?: string;
	contextFiles: { path: string; content: string }[];
	skills: Skill[];
};

type InheritedPrompt = {
	start: number;
	end: number;
	parent: PromptCapture;
};

export type PromptCapture = PromptCaptureInput & {
	assembledPrompt: string;
	/** Exact previously assembled prompts embedded in `custom`. */
	inherited: InheritedPrompt[];
};

/**
 * Captures keyed by the fully assembled prompt pi sends to a provider.
 *
 * A sub-agent's systemPromptOverride embeds its parent's assembled prompt
 * verbatim. Pi currently exposes that override as an ordinary custom prompt,
 * without provenance. Linking exact prior keys recovers the inheritance graph
 * without recognizing pi prose or sub-agent markers. If pi later exposes an
 * inherited-system-prompt field, it should replace this inference.
 */
export class PromptCaptures {
	private readonly captures = new Map<string, PromptCapture>();

	/** Pi rebuilds prompts when tools change, so retain only recent lookup keys.
	 *  Inheritance edges hold direct references and survive key eviction.
	 *
	 *  Set well above any plausible working set because the costs are lopsided: a
	 *  capture is tens of KB, while evicting one that is still live fails the turn.
	 *  A parent that fans out to more distinct sub-agent prompts than this before its
	 *  own next turn would be evicted despite being in use. The bound exists only to
	 *  cap an extension that rebuilds the prompt every turn, which would otherwise
	 *  grow keys without limit. */
	constructor(private readonly limit = 256) {}

	record(systemPrompt: string, input: PromptCaptureInput): void {
		const existing = this.captures.get(systemPrompt);
		const customChanged = existing?.custom !== input.custom;
		const capture = existing ?? {
			...input,
			assembledPrompt: systemPrompt,
			contextFiles: [],
			skills: [],
			inherited: [],
		};

		capture.custom = input.custom;
		capture.append = input.append;
		capture.contextFiles = input.contextFiles.map((file) => ({ ...file }));
		capture.skills = [...input.skills];
		if (!existing || customChanged) {
			capture.inherited = this.findInheritedPrompts(systemPrompt, input.custom);
		}

		// Mutate an existing node in place so descendants retain a live reference,
		// then re-insert its key so Map order tracks recency.
		this.touch(systemPrompt, capture);
	}

	/** Exact lookup only. Callers serving a query want `resolveOrDerive`. */
	resolve(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const capture = this.captures.get(systemPrompt);
		if (capture) this.touch(systemPrompt, capture);
		return capture;
	}

	/** Recency is by use, not just by record. A parent agent records its prompt once
	 *  and then only ever resolves it, so counting writes alone ages it out behind the
	 *  sub-agent prompts churning past it — observed in a real 135-message session,
	 *  where the parent's own prompt was evicted and its next turn resolved to
	 *  nothing. */
	private touch(systemPrompt: string, capture: PromptCapture): void {
		this.captures.delete(systemPrompt);
		this.captures.set(systemPrompt, capture);
		// Trims here, not only in record(): reviving an evicted node re-adds a key that
		// was not in the map, so without this a run of revivals grows it without bound.
		for (const key of this.captures.keys()) {
			if (this.captures.size <= this.limit) break;
			this.captures.delete(key);
		}
	}

	/**
	 * The capture to project for one query, for both the provider and AskClaude.
	 *
	 * An exact key is the normal case. A prompt that only *embeds* known prompts —
	 * anything that wrapped what Pi assembled after we recorded it — resolves to a
	 * transient descendant over the whole prompt, so projection swaps each embedded
	 * capture for its portable parts and carries everything around them through
	 * unchanged. That surrounding text belongs to whatever did the wrapping, and
	 * dropping it would be exactly the silent instruction loss this exists to
	 * prevent. The descendant is not retained — its key is not ours to own.
	 *
	 * Throws when a prompt can be accounted for by neither route. Returning an empty
	 * capture instead would hand Claude Code a turn with none of the user's context
	 * files, skills, custom prompt or append text, and say so only in a debug line —
	 * silently discarding policy the user wrote down. A failed turn is recoverable;
	 * a turn that quietly ignored its instructions is not.
	 */
	resolveOrDerive(systemPrompt?: string): PromptCapture | undefined {
		if (!systemPrompt) return undefined;
		const exact = this.captures.get(systemPrompt);
		if (exact) {
			this.touch(systemPrompt, exact);
			return exact;
		}

		// A capture outlives its lookup key: eviction drops the key while inheritance
		// edges keep the node alive. findInheritedPrompts deliberately skips a node whose
		// key *is* the prompt, so without this an evicted exact match would derive
		// nothing and throw. Touching it puts the key back.
		const revived = this.reachableCaptures().find((node) => node.assembledPrompt === systemPrompt);
		if (revived) {
			this.touch(systemPrompt, revived);
			return revived;
		}

		const embedded = this.findInheritedPrompts(systemPrompt, systemPrompt);
		if (embedded.length === 0) {
			throw new Error(
				`prompt-capture: no capture for this ${systemPrompt.length}-char system prompt, and it embeds none of the ${this.captures.size} known. `
				+ `Claude Code would receive none of this turn's context files, skills or custom instructions. `
				+ `The usual cause is an extension loaded after claude-bridge that rewrites the system prompt from before_agent_start — `
				+ `one that wraps it is fine, one that rebuilds or strips it leaves nothing to match.`,
			);
		}

		// `custom` is the prompt itself and the edges keep their original offsets, so
		// projectCustom substitutes the embedded captures in place and preserves every
		// byte between and around them.
		return { assembledPrompt: systemPrompt, custom: systemPrompt, contextFiles: [], skills: [], inherited: embedded };
	}

	get size(): number {
		return this.captures.size;
	}

	private findInheritedPrompts(systemPrompt: string, custom?: string): InheritedPrompt[] {
		if (!custom) return [];

		const candidates: Array<InheritedPrompt & { length: number }> = [];
		for (const parent of this.reachableCaptures()) {
			const key = parent.assembledPrompt;
			if (key === systemPrompt || key.length === 0) continue;
			for (let start = custom.indexOf(key); start !== -1; start = custom.indexOf(key, start + key.length)) {
				candidates.push({ start, end: start + key.length, length: key.length, parent });
			}
		}

		// A grandchild contains both its parent's key and the grandparent key
		// nested inside it. Keep the longest exact non-overlapping matches.
		candidates.sort((a, b) => b.length - a.length || a.start - b.start);
		const selected: InheritedPrompt[] = [];
		for (const candidate of candidates) {
			if (selected.some((edge) => candidate.start < edge.end && candidate.end > edge.start)) continue;
			selected.push({ start: candidate.start, end: candidate.end, parent: candidate.parent });
		}
		return selected.sort((a, b) => a.start - b.start);
	}

	private reachableCaptures(): PromptCapture[] {
		const result: PromptCapture[] = [];
		const seen = new Set<PromptCapture>();
		const visit = (capture: PromptCapture): void => {
			if (seen.has(capture)) return;
			seen.add(capture);
			result.push(capture);
			for (const edge of capture.inherited) visit(edge.parent);
		};
		for (const capture of this.captures.values()) visit(capture);
		return result;
	}
}

const SHARED_CAPTURES_KEY = Symbol.for("claude-bridge:promptCaptures");

/** Isolated agents re-evaluate this module; process-wide state lets the parent stream their captures. */
export function sharedPromptCaptures(): PromptCaptures {
	const globals = globalThis as Record<symbol, PromptCaptures | undefined>;
	return (globals[SHARED_CAPTURES_KEY] ??= new PromptCaptures());
}

export function projectPromptCapture(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
): string | undefined {
	return projectCapture(capture, options, new Set());
}

/** Skills visible through inherited prompts, ancestor first and once per file. */
export function collectPromptSkills(capture: PromptCapture): Skill[] {
	const result: Skill[] = [];
	const seenPaths = new Set<string>();
	const visited = new Set<PromptCapture>();
	const visiting = new Set<PromptCapture>();

	const visit = (node: PromptCapture): void => {
		if (visited.has(node)) return;
		if (visiting.has(node)) throw new Error("Cyclic prompt inheritance");
		visiting.add(node);
		for (const edge of node.inherited) visit(edge.parent);
		for (const skill of node.skills) {
			if (skill.disableModelInvocation || seenPaths.has(skill.filePath)) continue;
			seenPaths.add(skill.filePath);
			result.push(skill);
		}
		visiting.delete(node);
		visited.add(node);
	};

	visit(capture);
	return result;
}

function projectCapture(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
	visiting: Set<PromptCapture>,
): string | undefined {
	if (visiting.has(capture)) throw new Error("Cyclic prompt inheritance");
	visiting.add(capture);
	try {
		const inheritedSkillPaths = new Set(
			capture.inherited.flatMap((edge) => collectPromptSkills(edge.parent).map((skill) => skill.filePath)),
		);
		const ownSkillPaths = new Set<string>();
		const ownSkills = capture.skills.filter((skill) => {
			if (skill.disableModelInvocation || inheritedSkillPaths.has(skill.filePath) || ownSkillPaths.has(skill.filePath)) {
				return false;
			}
			ownSkillPaths.add(skill.filePath);
			return true;
		});

		const custom = projectCustom(capture, options, visiting);
		const parts = [
			formatProjectContext(capture.contextFiles),
			renderSkillsBlock(ownSkills, options.skillReadTool),
			custom,
			capture.append,
		].filter((part): part is string => Boolean(part));
		return parts.length > 0 ? parts.join("\n\n") : undefined;
	} finally {
		visiting.delete(capture);
	}
}

function projectCustom(
	capture: PromptCapture,
	options: { skillReadTool: SkillReadTool },
	visiting: Set<PromptCapture>,
): string | undefined {
	if (!capture.custom || capture.inherited.length === 0) return capture.custom;

	let result = "";
	let cursor = 0;
	for (const edge of capture.inherited) {
		result += capture.custom.slice(cursor, edge.start);
		result += projectCapture(edge.parent, options, visiting) ?? "";
		cursor = edge.end;
	}
	return result + capture.custom.slice(cursor);
}
