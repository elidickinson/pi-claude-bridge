/**
 * Unit-suite preload: redirect the bridge's debug log to a throwaway directory.
 *
 * src/index.ts resolves DEBUG_LOG_PATH into a module-level const at import time
 * (and mkdirs it when CLAUDE_BRIDGE_DEBUG=1), so the override has to be in place
 * before any test imports the module. Doing that per test file is easy to forget,
 * and forgetting is invisible: the suite still passes everywhere except on a
 * developer machine with CLAUDE_BRIDGE_DEBUG=1, where the tests instead append
 * fixture data to the real bridge log in pi's agent dir.
 *
 * Wiring this as `node --import ./tests/lib/setup.mjs` guarantees it runs first
 * in every test child process. tests/unit-debug-path.mjs asserts it took effect.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "claude-bridge-test-log-"));
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(logDir, "claude-bridge.log");
process.on("exit", () => rmSync(logDir, { recursive: true, force: true }));

// Same reason for the persisted pi→CC session links (src/session-links.ts): any test
// that plants a session mirror would otherwise write into the real agent dir.
process.env.CLAUDE_BRIDGE_SESSION_LINKS_PATH = join(logDir, "claude-bridge-sessions.json");
