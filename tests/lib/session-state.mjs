import { copyRecording, importHistory } from "../../src/session-sync.js";

/** Seeds use the production recording helpers, never positional cursor guesses. */
export function stateFor(session, messages = [], model = "", extra = {}) {
	return { ...importHistory(session, messages), ccSessionId: session.sessionId, cwd: session.projectPath, model, dirtyTail: false, ...extra };
}

export function emptyState(ccSessionId, cwd, extra = {}) {
	return { ...copyRecording(), ccSessionId, cwd, model: "", dirtyTail: false, ...extra };
}
