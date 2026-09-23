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
	/** Which bridge boundary last recorded this key (before_agent_start | agent_start | turn_start). */
	source?: string;
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

/**
 * Carries structured prompt inputs from `before_agent_start` to `agent_start`.
 *
 * Pi chains `before_agent_start` handlers in extension order, so the prompt seen
 * by the bridge may still be rewritten by a later extension. `agent_start`
 * runs after that chain and exposes the finalized prompt through
 * `ctx.getSystemPrompt()`. Keeping the inputs pending until then makes the
 * capture independent of extension load order.
 */
export class PromptCaptureLifecycle {
	private pending: PromptCaptureInput | undefined;

	constructor(private readonly captures: PromptCaptures) {}

	prepare(input: PromptCaptureInput): void {
		this.pending = {
			...input,
			contextFiles: input.contextFiles.map((file) => ({ ...file })),
			skills: [...input.skills],
		};
	}

	recordFinal(systemPrompt: string, source?: string): void {
		const input = this.pending;
		this.pending = undefined;
		if (input) this.captures.record(systemPrompt, input, source);
	}

	clear(): void {
		this.pending = undefined;
	}
}

/** Pi's own preamble, the first section of every prompt pi renders for a session
 *  without a custom prompt. Machine-generated, so operator text never carries it;
 *  forwarding it makes Claude Code's subscription path read the request as a
 *  third-party app. */
export const PI_PREAMBLE = "You are an expert coding assistant operating inside pi";

/** Both doc paths from pi's documentation-routing line. Anthropic's subscription gate
 *  rejects a system prompt carrying both, while either alone passes (issues #883, #88). */
const ANTHROPIC_THIRD_PARTY_TRIGGERS = ["docs/custom-provider.md", "docs/packages.md"];

/** One piece of the append, named so a refusal can say where it found the text. */
type PromptPart = { label: string; text: string };

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
		const parts: PromptPart[] = [];
		const context = formatProjectContext(capture.contextFiles);
		if (context) parts.push({ label: "the project context block", text: context });
		const skills = renderSkillsBlock(ownSkills, options.skillReadTool);
		if (skills) parts.push({ label: "the skills block", text: skills });
		if (custom) parts.push({ label: "the custom prompt", text: custom });
		if (capture.append) parts.push({ label: "the appended instructions", text: capture.append });
		assertSendablePrompt(parts, capture);
		return parts.length > 0 ? parts.map((part) => part.text).join("\n\n") : undefined;
	} finally {
		visiting.delete(capture);
	}
}

function assertSendablePrompt(parts: readonly PromptPart[], capture: PromptCapture): void {
	const findings: string[] = [];
	for (const { label, text } of parts) {
		const offset = preambleAtLineStart(text);
		if (offset !== -1) {
			findings.push(`pi's preamble ("${PI_PREAMBLE}") in ${label}, at offset ${offset} of ${text.length} chars`);
		}
		// The pair has to co-occur in one part; the two phrases split across parts are not detected.
		if (ANTHROPIC_THIRD_PARTY_TRIGGERS.every((trigger) => text.includes(trigger))) {
			findings.push(`${ANTHROPIC_THIRD_PARTY_TRIGGERS.join(" and ")} in ${label}`);
		}
	}
	if (findings.length === 0) return;

	throw new Error([
		"prompt-capture: refusing to send this prompt. Claude Code's Anthropic path reads a request",
		"  carrying pi's harness, or the phrase pair its subscription gate rejects, as a third-party",
		"  app: it fails with 400 or is billed as extra usage.",
		...findings.map((finding) => `  Found: ${finding}.`),
		`  Capture: ${capture.source ?? "unknown"}, ${capture.inherited.length} inherited capture(s) substituted.`,
		"  If this came from an inherited pi prompt, see README \"Compatibility with other extensions\".",
		"  If it is your own text, reword or remove it. CLAUDE_BRIDGE_DEBUG=1 writes the full prompt to",
		"  ~/.pi/agent/claude-bridge.log.",
	].join("\n"));
}

/** Offset of pi's preamble at the start of a line, or -1. Mid-line mentions are someone
 *  describing pi's prompt, not pi's prompt. */
function preambleAtLineStart(text: string): number {
	for (let offset = text.indexOf(PI_PREAMBLE); offset !== -1; offset = text.indexOf(PI_PREAMBLE, offset + PI_PREAMBLE.length)) {
		if (offset === 0 || text[offset - 1] === "\n") return offset;
	}
	return -1;
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
