import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatProjectContext } from "./agents-md.js";
import { renderSkillsBlock, type SkillReadTool } from "./skills.js";

// What pi assembled for one agent, kept so the bridge can append only the
// portable parts after Claude Code's own preset.

export type PromptCaptureInput = {
	custom?: string;
	append?: string;
	/** Session cwd, as pi wrote it into the prompt's `Current working directory:` footer. */
	cwd?: string;
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
	/** Which bridge boundary last recorded this key (before_agent_start | agent_start | turn_start). */
	source?: string;
	/** The assembled prompt minus pi's per-session tail (skills catalogue, cwd
	 *  footer) — the form pi-subagents' `inheritedIdentity` embeds in a child
	 *  whose workspace is the parent's. Recorded so `findInheritedPrompts` can
	 *  match children that carry the parent prompt stripped, which the full key
	 *  never can: the stripping happens before embedding, so an exact substring
	 *  search for the full prompt returns -1 and the whole base is forwarded.
	 *  Undefined when the prompt has no tail to strip. */
	tailStrippedPrompt?: string;
	/** The assembled prompt also minus the `<project_context>` block — the form
	 *  pi-subagents embeds for a child whose workspace is NOT the parent's
	 *  (#918 there): the inherited block names the parent's files by absolute
	 *  path, so a relocated child's cut starts one layer earlier. Matching under
	 *  both keys lets the existing longest-match selection pick the right span
	 *  per child shape. Undefined when neither layer is present. */
	projectContextStrippedPrompt?: string;
	/** ...cut at the `<skills>` wrapper's opening tag — the form the
	 *  embedding side moves to on pi ≥0.86 (gotgenes#959), where the wrapper
	 *  must drop with the layers it carries. */
	skillsSectionStrippedPrompt?: string;
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
export type PromptCaptureDiagnostic = {
	/** The prompt that matched nothing: the full system prompt is too big to log
	 *  inline, so a fingerprint plus the closest match's first divergent offset
	 *  are enough to recognize the pump.
	 *
	 *  Closest is by shared prefix — the case that matters here is pi itself
	 *  rebuilding the prompt outside `before_agent_start` (a changed tool list or
	 *  fresh resource discovery), which edits near the boundary, and a prefix key
	 *  gets us to within a handful of characters of where. */
	systemPrompt: string;
	matches: { key: string; firstDivergent: number; source?: string }[];
};

export class PromptCaptures {
	private readonly captures = new Map<string, PromptCapture>();
	/** Invoked with everything that would otherwise be lost when resolution throws,
	 *  so the bridge can write it to its debug log. Kept off the throw path itself:
	 *  the resolver is hot and the caller may own a faster sink than string-building.
	 *
	 *  Set by the bridge on the shared instance; tests that want the diagnostic can
	 *  pass one per instance. */
	private readonly onDiagnose: (diagnostic: PromptCaptureDiagnostic) => void;

	/** Pi rebuilds prompts when tools change, so retain only recent lookup keys.
	 *  Inheritance edges hold direct references and survive key eviction.
	 *
	 *  Set well above any plausible working set because the costs are lopsided: a
	 *  capture is tens of KB, while evicting one that is still live fails the turn.
	 *  A parent that fans out to more distinct sub-agent prompts than this before its
	 *  own next turn would be evicted despite being in use. The bound exists only to
	 *  cap an extension that rebuilds the prompt every turn, which would otherwise
	 *  grow keys without limit. */
	constructor(private readonly limit = 256, onDiagnose?: (diagnostic: PromptCaptureDiagnostic) => void) {
		this.onDiagnose = onDiagnose ?? (() => {});
	}

	record(systemPrompt: string, input: PromptCaptureInput, source?: string): void {
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
		capture.cwd = input.cwd;
		const stripped = stripSessionLayers(systemPrompt, input.cwd);
		capture.tailStrippedPrompt = stripped.tail;
		capture.projectContextStrippedPrompt = stripped.projectContext;
		capture.skillsSectionStrippedPrompt = stripped.skillsSection;
		capture.contextFiles = input.contextFiles.map((file) => ({ ...file }));
		capture.skills = [...input.skills];
		capture.source = source;
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

		// Inheritance must be tried before any tolerance/adoption route. A sub-agent
		// child that embeds its parent's prompt verbatim contains every portable part
		// of the parent's capture, so an "adopt the capture whose portable parts all
		// appear here" heuristic (as drafted in upstream PR #76's findPortableMatch)
		// placed above this route would match first, re-key the PARENT's capture under
		// the child's prompt, and silently drop the child's wrapper text — exactly the
		// instruction loss the throw exists to prevent. If such a route is ever added,
		// it belongs below this block.
		const embedded = this.findInheritedPrompts(systemPrompt, systemPrompt);
		if (embedded.length === 0) {
			const matches = this.closestKnown(systemPrompt);
			this.onDiagnose({ systemPrompt, matches });
			throw new Error(
				`prompt-capture: no capture for this ${systemPrompt.length}-char system prompt, and it embeds none of the ${this.captures.size} known. `
				+ `Closest known match diverges at offset ${matches[0]?.firstDivergent ?? "?"} `
				+ `(${matches.length ? matches[0].key.length : 0}-char key${matches[0]?.source ? `, last recorded at ${matches[0].source}` : ""}). `
				+ `Claude Code would receive none of this turn's context files, skills or custom instructions. `
				+ `The usual cause is an extension loaded after claude-bridge that rewrites the system prompt from before_agent_start — `
				+ `one that wraps it is fine, one that rebuilds or strips it leaves nothing to match. `
				+ `(Also possible: pi rebuilt the prompt outside before_agent_start — a late-registered tool or fresh resource discovery.)`,
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

	/** Longest shared-prefix matches, best first, for the throw diagnostic. */
	private closestKnown(systemPrompt: string): { key: string; firstDivergent: number; source?: string }[] {
		let shared = 0;
		const matches: { key: string; firstDivergent: number; source?: string }[] = [];
		for (const [key, capture] of this.captures.entries()) {
			const limit = Math.min(key.length, systemPrompt.length);
			let i = 0;
			while (i < limit && key.charCodeAt(i) === systemPrompt.charCodeAt(i)) i++;
			if (i >= shared) {
				if (i > shared) {
					shared = i;
					matches.length = 0;
				}
				matches.push({ key, firstDivergent: i, source: capture.source });
			}
		}
		return matches;
	}

	private findInheritedPrompts(systemPrompt: string, custom?: string): InheritedPrompt[] {
		if (!custom) return [];

		const candidates: Array<InheritedPrompt & { length: number }> = [];
		for (const parent of this.reachableCaptures()) {
			// Full key first, then the two stripped forms pi-subagents embeds —
			// tail-cut for a same-workspace child, project-context-cut for a
			// relocated one. All are exact substring searches, so a match under
			// any key is a real inheritance edge, and the longest-match selection
			// below picks the right span when a child carries several.
			for (const key of [parent.assembledPrompt, parent.tailStrippedPrompt, parent.projectContextStrippedPrompt, parent.skillsSectionStrippedPrompt]) {
				if (!key || key === systemPrompt || key.length === 0) continue;
				for (let start = custom.indexOf(key); start !== -1; start = custom.indexOf(key, start + key.length)) {
					candidates.push({ start, end: start + key.length, length: key.length, parent });
				}
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

/** Isolated agents re-evaluate this module; a process-wide instance lets the pinned
 *  stream resolve their captures (issue #64). The first instance's onDiagnose wins —
 *  later callers reuse the instance as-is. Never cleared at session_shutdown: identical
 *  keys carry identical portable parts, so cross-session reuse is safe. */
export function sharedPromptCaptures(onDiagnose?: (diagnostic: PromptCaptureDiagnostic) => void): PromptCaptures {
	const globals = globalThis as Record<symbol, PromptCaptures | undefined>;
	return (globals[SHARED_CAPTURES_KEY] ??= new PromptCaptures(256, onDiagnose));
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

/** Opening tag of the section Pi ≥0.86 wraps the catalogue in. */
const SKILLS_SECTION_OPEN = "<skills>";

/** Closing tag of that section. */
const SKILLS_SECTION_CLOSE = "</skills>";

/** Opening tag of the section Pi ≥0.86 renders the working directory into. */
const CWD_SECTION_OPEN = "<cwd>";

/** Closing tag of that section. */
const CWD_SECTION_CLOSE = "</cwd>";

/** First line of the section Pi writes above the `<available_skills>` catalogue. */
const SKILLS_SECTION_HEADING =
	"The following skills provide specialized instructions for specific tasks.";

/** Closing tag of that catalogue. */
const SKILLS_CATALOGUE_CLOSE = "</available_skills>";

/** Opening tag of the block Pi renders the session's context files into. */
const PROJECT_CONTEXT_OPEN = "<project_context>";

/** Closing tag of that block. */
const PROJECT_CONTEXT_CLOSE = "</project_context>";

/**
 * The sentence Pi writes below the opening tag — two lines below it through
 * 0.85, whose block opens with a blank line, and directly below it from
 * 0.86's section renderer.
 *
 * Both offsets are accepted because the peer range (`>=0.81.0`) admits both
 * renderers. The 0.85 arm in `projectContextStart` is dead once that floor
 * moves past 0.85; drop it with the fixtures that exercise it rather than
 * carrying it forward. Same disposition as gotgenes/pi-packages#959's note on
 * the embedding side — the mirror retires its arms together.
 */
const PROJECT_CONTEXT_LEAD_IN = "Project-specific instructions and guidelines:";

/** Both cut forms of one prompt: `tail` is the per-session-tail cut
 *  pi-subagents embeds for a same-workspace child, `projectContext` the
 *  one-layer-earlier cut it embeds for a relocated one (#918 there). On
 *  pi ≥0.86's section renderer `skillsSection` carries the additional
 *  wrapper-tag cut the relocated anchors move to (gotgenes#959), and `tail`
 *  keeps the heading cut the pre-#959 embedding produces — both stay keys
 *  while children on either embedding version are in the wild. */
type StrippedPromptKeys = {
	tail?: string;
	projectContext?: string;
	skillsSection?: string;
};

/**
 * Both stripped forms of a parent prompt, or the empty object when neither
 * layer is present.
 *
 * Mirrors line for line the cut pi-subagents' `inheritedIdentity` makes before
 * embedding a parent prompt in a child (ADR 0006 and #918 there): everything
 * from the first session-resolved layer onward — the `<project_context>` block
 * for a relocated child, else the skills catalogue, cwd footer, and any
 * extension-appended blocks — is resolved per session and dropped rather than
 * inherited. The two implementations MUST stay in lockstep: the capture side
 * can only recognize what the embedding side cuts, so when that side's anchors
 * move (a pi `buildSystemPrompt` change, a new layer), these must move with it.
 *
 * Anchoring on the cwd footer and walking back to the catalogue's closing tag
 * keeps a catalogue quoted in a context file from displacing the cut (#801
 * there); the project-context opening accepts only a block carrying the
 * lead-in sentence two lines below it, for the same reason. A prompt carrying
 * none of these layers is not one `buildSystemPrompt` assembled, and is left
 * alone.
 */
function stripSessionLayers(prompt: string, cwd?: string): StrippedPromptKeys {
	const lines = prompt.split("\n");
	const footerAt = cwd
		? lines.lastIndexOf(`Current working directory: ${cwd.replaceAll("\\", "/")}`)
		: -1;
	if (footerAt !== -1) {
		const catalogueAt = skillsSectionStart(lines, footerAt);
		const tailAt = catalogueAt === -1 ? footerAt : catalogueAt;
		return {
			tail: cutAt(lines, tailAt, prompt),
			projectContext: cutAt(lines, projectContextStart(lines, tailAt), prompt),
		};
	}
	const cwdAt = cwd ? cwdSectionStart(lines, cwd) : -1;
	if (cwdAt !== -1) {
		const wrapperAt = skillsSectionWrapperStart(lines, cwdAt);
		return {
			tail: cutAt(lines, wrapperAt + 1, prompt),
			skillsSection: cutAt(lines, wrapperAt, prompt),
			projectContext: cutAt(lines, projectContextStart(lines, wrapperAt), prompt),
		};
	}
	const catalogueAt = skillsSectionStart(lines, -1);
	if (catalogueAt === -1) return {};
	return {
		tail: cutAt(lines, catalogueAt, prompt),
		projectContext: cutAt(lines, projectContextStart(lines, catalogueAt), prompt),
	};
}

/**
 * Line index of the `<skills>` section's opening tag, or the cwd section's own
 * opening when the parent resolved no skills.
 *
 * The catalogue section sits immediately below the cwd section in
 * `buildSystemPrompt`'s order, separated only by the section join, so the
 * closing tag on the other side of that join is Pi's own. Its opening is then
 * accepted only when the heading is its first content line, keeping a custom
 * section that merely ends where Pi's does from being taken for it.
 */
function skillsSectionWrapperStart(lines: readonly string[], cwdAt: number): number {
	let closeAt = cwdAt - 1;
	while (closeAt >= 0 && lines[closeAt] === "") closeAt--;
	if (closeAt < 0 || lines[closeAt] !== SKILLS_SECTION_CLOSE) return cwdAt;
	const openAt = lines.lastIndexOf(SKILLS_SECTION_OPEN, closeAt);
	if (openAt === -1 || lines[openAt + 1] !== SKILLS_SECTION_HEADING) return cwdAt;
	return openAt;
}

/**
 * Line index of pi ≥0.86's `<cwd>` section opening tag, or -1 when it wrote
 * none.
 *
 * Located by content, not document order: the section is accepted only when
 * the line inside it is exactly the session cwd and the closing tag follows,
 * so a `<cwd>` quoted elsewhere — or one naming a directory that merely
 * shares a prefix — is not mistaken for it, the same whole-line discipline
 * the 0.85 footer anchor applies.
 */
function cwdSectionStart(lines: readonly string[], cwd: string): number {
	for (
		let openAt = lines.lastIndexOf(CWD_SECTION_OPEN);
		openAt !== -1;
		openAt = lines.lastIndexOf(CWD_SECTION_OPEN, openAt - 1)
	) {
		if (
			lines[openAt + 1] === cwd.replaceAll("\\", "/") &&
			lines[openAt + 2] === CWD_SECTION_CLOSE
		) {
			return openAt;
		}
	}
	return -1;
}

/** The prompt cut at `cut`, or undefined when there is nothing to cut. */
function cutAt(lines: readonly string[], cut: number, prompt: string): string | undefined {
	if (cut === -1) return undefined;
	const stripped = lines.slice(0, cut).join("\n").trimEnd();
	return stripped && stripped !== prompt ? stripped : undefined;
}

/**
 * Line index of the skills section's heading, or -1 when the section is absent.
 *
 * The heading is located by searching back from the catalogue's closing tag, so
 * prose quoting Pi's heading ahead of the section is not mistaken for it.
 */
function skillsSectionStart(lines: readonly string[], footerAt: number): number {
	const catalogueEnd = catalogueCloseBefore(lines, footerAt);
	return catalogueEnd === -1
		? -1
		: lines.lastIndexOf(SKILLS_SECTION_HEADING, catalogueEnd);
}

/**
 * Line index of Pi's own catalogue closing tag, or -1 when it wrote none.
 *
 * `buildSystemPrompt` writes the cwd footer immediately after the catalogue, in
 * both of its branches and unconditionally, so the tag on the line before the
 * footer is Pi's own. Identifying it by that position rather than by document
 * order keeps a catalogue quoted elsewhere — in a project-context file, or in a
 * block an extension appended after the footer — from being taken for the
 * section, in either direction.
 *
 * Without a footer to anchor on, something downstream has rewritten Pi's
 * output; the last closing tag is the best remaining guess.
 */
function catalogueCloseBefore(lines: readonly string[], footerAt: number): number {
	if (footerAt === -1) {
		return lines.lastIndexOf(SKILLS_CATALOGUE_CLOSE);
	}
	return lines[footerAt - 1] === SKILLS_CATALOGUE_CLOSE ? footerAt - 1 : -1;
}

/**
 * Line index of the project-context block's opening tag, or -1 when the parent
 * session resolved no context files.
 *
 * Located by the same positional discipline as the catalogue: Pi writes the
 * block immediately before whichever session-resolved layer follows, so its
 * closing tag is the last non-blank line above the already-anchored tail. The
 * opening is then the nearest one above that tag carrying Pi's lead-in sentence
 * two lines below it, which keeps a context file quoting the opening — later in
 * the document than the real one — from being taken for it.
 */
function projectContextStart(lines: readonly string[], tailAt: number): number {
	let closeAt = tailAt - 1;
	while (closeAt >= 0 && lines[closeAt] === "") closeAt--;
	if (closeAt < 0 || lines[closeAt] !== PROJECT_CONTEXT_CLOSE) return -1;
	for (
		let openAt = lines.lastIndexOf(PROJECT_CONTEXT_OPEN, closeAt);
		openAt !== -1;
		openAt = lines.lastIndexOf(PROJECT_CONTEXT_OPEN, openAt - 1)
	) {
		if (lines[openAt + 2] === PROJECT_CONTEXT_LEAD_IN) return openAt;
	}
	return -1;
}
