// Mutable module state shared by every region of the bridge.
//
// These singletons are read and written from the provider path, the session-sync
// path, the AskClaude tool and the extension registration alike, so they belong to
// none of them. Extracted from index.ts so those regions can be split into their
// own modules without any of them owning the others' state.
//
// Two shapes on purpose. Anything that gets *reassigned* lives as a property on
// `bridgeState`, because an importing module binds the value of an `export let`,
// not the variable: assigning to it here would stay invisible to every importer.
// Anything only ever mutated *in place* — a Set, a class instance — has no such
// problem and is a plain export.

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";
import { debug } from "./debug.js";
import type { LongContextSettings } from "./models.js";
import { PromptCaptures } from "./prompt-capture.js";
import type { QueryContext } from "./query-state.js";

export interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. Compact/tree do NOT set
	// this — there's no concurrent CC writer during those events, so
	// in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

// --- Mutated in place: plain exports ---

export const activeQueryContexts = new Set<QueryContext>();

// Captures of what pi assembled per agent; see src/prompt-capture.ts for why this
// is keyed rather than held in a single slot.
export const promptCaptures = new PromptCaptures(256, (diagnostic) => {
	const first = diagnostic.matches[0];
	debug(
		`prompt-capture: no match for ${diagnostic.systemPrompt.length}-char system prompt. `
		+ (first
			? `closest known (${first.key.length}-char) shares its first ${first.firstDivergent} chars and diverges at offset ${first.firstDivergent}: `
			  + JSON.stringify(diagnostic.systemPrompt.slice(first.firstDivergent - 40, first.firstDivergent + 60))
			: "no known captures to compare against."
		) + ` known keys=${diagnostic.matches.length}`,
	);
});

// --- Reassigned: properties on the shared object ---

export interface BridgeState {
	sharedSession: SessionState | null;
	piUI: ExtensionUIContext | null;
	piMode: ExtensionContext["mode"] | null;
	// Defaults that silently cost the user something (no Opus 1M on Max, no
	// AskClaude tool) are announced once. Deferred to the first bridge query rather
	// than session_start: the notice persists a flag to the global config, and
	// firing it on startup would write that file for every pi session that merely
	// has this extension installed. One message, because consecutive info notifies
	// overwrite each other in the TUI.
	pendingNotices: string[];
	providerSettings: NonNullable<Config["provider"]>;
	longContextSettings: LongContextSettings;
	// The name the AskClaude tool is registered under, which config can rename.
	// Both the provider path and the AskClaude path have to exclude that exact name
	// from the pi tools they hand Claude Code, and only the extension registration
	// knows it — so it lives here rather than in either of the two readers.
	askClaudeToolName: string;
}

export const bridgeState: BridgeState = {
	sharedSession: null,
	piUI: null,
	piMode: null,
	pendingNotices: [],
	providerSettings: {},
	longContextSettings: { plan: "pro", longContextExtraUsage: false },
	askClaudeToolName: "AskClaude",
};
