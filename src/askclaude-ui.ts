// Status-line rendering helpers for the AskClaude tool.
//
// While Claude Code runs inside an AskClaude call, the pi TUI can't surface
// each tool_use individually — there's only one status row for the whole
// delegation. These helpers shape a tool_use record into a short, path-aware
// label (e.g. "Read(src/foo.ts)", "Bash(git log --oneline…)") and collapse
// runs of the same tool so the line doesn't flicker. Used only by
// promptAndWait; the provider path exposes tools directly through pi's TUI
// and doesn't need this.

export interface ToolCallState {
	name: string;
	status: string;
	rawInput?: unknown;
}

export function extractPath(rawInput: unknown): string | undefined {
	if (!rawInput || typeof rawInput !== "object") return undefined;
	const input = rawInput as Record<string, unknown>;
	if (typeof input.file_path === "string") return input.file_path;
	if (typeof input.path === "string") return input.path;
	if (typeof input.command === "string") return input.command.substring(0, 80);
	return undefined;
}

export function shortPath(p: string): string {
	const cwd = process.cwd();
	if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
	if (p.startsWith("/")) {
		const parts = p.split("/");
		if (parts.length > 3) return parts.slice(-2).join("/");
	}
	return p;
}

export function formatToolAction(tc: ToolCallState): string | undefined {
	const path = extractPath(tc.rawInput);
	const verb = tc.name.toLowerCase().split(/\s/)[0];
	if (verb === "read" || verb === "readfile") {
		return path ? `Read(${shortPath(path)})` : "Read";
	} else if (verb === "glob") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const pat = typeof input?.pattern === "string" ? input.pattern.slice(0, 40) : "";
		return pat ? `Glob(${pat})` : "Glob";
	} else if (verb === "edit" || verb === "write" || verb === "writefile" || verb === "multiedit") {
		return path ? `Edit(${shortPath(path)})` : "Edit";
	} else if (verb === "bashoutput") {
		return undefined; // redundant with preceding Bash call
	} else if (verb === "bash" || verb === "terminal") {
		return path ? `Bash(${path})` : "Bash";
	} else if (verb === "agent") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		return `Agent(${String(input?.description ?? "").slice(0, 40)})`;
	} else if (verb === "grep") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const pat = typeof input?.pattern === "string" ? input.pattern.slice(0, 40) : "";
		return pat ? `Grep(${pat})` : "Grep";
	} else if (verb === "skill") {
		const input = tc.rawInput as Record<string, unknown> | undefined;
		const name = typeof input?.skill === "string" ? input.skill.slice(0, 40) : "";
		return name ? `Skill(${name})` : "Skill";
	} else if (verb === "todowrite" || verb === "taskcreate" || verb === "taskupdate") {
		const todos = Array.isArray((tc.rawInput as any)?.todos) ? (tc.rawInput as any).todos : [];
		const current = todos.find((t: any) => t.status === "in_progress") ?? todos.find((t: any) => t.status === "pending");
		const label = current ? String(current.content ?? "").slice(0, 40) : "";
		return label || undefined;
	} else if (verb === "askclaude") {
		// Recursive — don't show AskClaude in its own action summary
		return undefined;
	}
	return tc.name;
}

export function buildActionSummary(calls: Map<string, ToolCallState>): string {
	const parts: string[] = [];
	let prevVerb = "";
	for (const [, tc] of calls) {
		const action = formatToolAction(tc);
		if (!action) continue;
		const verb = tc.name.toLowerCase().split(/\s/)[0];
		// Collapse consecutive calls to the same tool — keep only the latest
		if (verb === prevVerb) {
			parts[parts.length - 1] = action;
		} else {
			parts.push(action);
		}
		prevVerb = verb;
	}
	return parts.join("; ");
}
