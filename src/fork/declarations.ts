// pi keeps the tool list and system prompt in system messages, and its
// compaction drops them from the rebuilt history. The call that continues the
// turn then arrives with no system message, so the query Claude Code starts has
// no MCP server and no pi prompt: the model cannot call anything and ends the
// turn with no output. Reuse what the same pi session declared on its last call.
import type { Context, Tool } from "@earendil-works/pi-ai";
import { debug } from "../debug.js";

interface Declared {
	systemPrompt: string | undefined;
	tools: Tool[];
}

const lastDeclared = new Map<string, Declared>();
let activeToolNames: (() => string[]) | undefined;

/** pi's own view of the declared tools, for the warning below. */
export function setActiveToolsProbe(probe: (() => string[]) | undefined): void {
	activeToolNames = probe;
}

/** `context` is in bridge shape (toBridgeContext); `source` is what pi passed. */
export function withRememberedDeclarations(context: Context, source: Context, sessionId: string | undefined): Context {
	if (!sessionId) return context;
	const tools = context.tools ?? [];
	if (context.systemPrompt !== undefined || tools.length > 0) {
		lastDeclared.set(sessionId, { systemPrompt: context.systemPrompt, tools });
		return context;
	}
	// A system message is pi declaring this state, even an empty one.
	if (source.messages.some((message) => message.role === "system")) return context;
	const remembered = lastDeclared.get(sessionId);
	if (!remembered) return context;
	debug(`provider: call carried no system message; restored ${remembered.tools.length} tools and the prompt from the session's last call`);
	return { ...context, systemPrompt: remembered.systemPrompt, tools: remembered.tools.length > 0 ? remembered.tools : undefined };
}

/** A query without tools while pi has some is the failure above; say so in the log. */
export function warnIfToolless(toolCount: number, sessionTag: string): void {
	if (toolCount > 0) return;
	const active = activeToolNames?.().length ?? 0;
	if (active > 0) debug(`provider: query starts with no tools but pi has ${active} active ${sessionTag}`);
}
