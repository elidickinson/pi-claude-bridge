// Pi session id -> cwd. In the pi CLI process.cwd() is the session's cwd, but a
// host serving many sessions from one process (pi-web) has a single process cwd,
// so Claude Code would run in, and load project instructions from, the host's
// directory. Kept on globalThis because every module instance's session_start
// only sees its own session while the first instance's streamSimple serves all.
const SESSION_CWDS_KEY = Symbol.for("claude-bridge:sessionCwds");
const SUMMARY_SESSIONS_KEY = Symbol.for("claude-bridge:summarySessions");

function summarySessions(): WeakMap<AbortSignal, string> {
	const g = globalThis as Record<symbol, unknown>;
	return (g[SUMMARY_SESSIONS_KEY] ??= new WeakMap<AbortSignal, string>()) as WeakMap<AbortSignal, string>;
}

// Pi forwards the operation's signal from the before hook to every summary call.
export function rememberSummarySession(signal: AbortSignal, sessionId: string): void {
	summarySessions().set(signal, sessionId);
}

export function summarySessionFor(signal: AbortSignal | undefined): string | undefined {
	return signal ? summarySessions().get(signal) : undefined;
}

function store(): Map<string, string> {
	const g = globalThis as Record<symbol, unknown>;
	return (g[SESSION_CWDS_KEY] ??= new Map<string, string>()) as Map<string, string>;
}

export function rememberSessionCwd(sessionId: string, cwd: string): void {
	store().set(sessionId, cwd);
}

export function forgetSessionCwd(sessionId: string): void {
	store().delete(sessionId);
}

export function sessionCwdFor(sessionId: string | null | undefined): string {
	return (sessionId ? store().get(sessionId) : undefined) ?? process.cwd();
}
