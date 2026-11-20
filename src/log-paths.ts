/**
 * The bridge's debug and diagnostics logs live in pi's agent dir, so a layout
 * that sets PI_CODING_AGENT_DIR keeps them beside pi's other state instead of a
 * fixed ~/.pi/agent. The debug log alone stays overridable, because the test
 * harness and the probes redirect it to a throwaway path.
 *
 * Paths resolve per call rather than at import time, so tests can swap the
 * environment mid-process and see the new paths immediately.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "path";

export function debugLogPath(): string {
	return process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(getAgentDir(), "claude-bridge.log");
}

export function diagLogPath(): string {
	return join(getAgentDir(), "claude-bridge-diag.log");
}
