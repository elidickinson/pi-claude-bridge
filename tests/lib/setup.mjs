/**
 * Unit preload and nested fixture helper. Bootstrap only creates its own temp
 * root; all home/config/log paths must pass preflight before tests can run.
 * Cleanup is restricted to the exact freshly-created roots owned here.
 */
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const TEST_ENV_KEYS = [
	"HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR",
	"CLAUDE_CONFIG_DIR", "CLAUDE_BRIDGE_DEBUG_PATH", "CLAUDE_BRIDGE_RECORD_STREAM",
	"TMPDIR", "TMP", "TEMP",
];
function assertContained(root, path, label) {
	const distance = relative(root, path);
	if (distance === ".." || distance.startsWith(`..${sep}`) || isAbsolute(distance)) {
		throw new Error(`${label} escapes owned test root: ${path}`);
	}
}
export function assertOwnedPath(root, path, label = "test path") {
	if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} is not absolute: ${path}`);
	const absolute = resolve(path);
	assertContained(resolve(root), absolute, label);
	// Also reject an existing symlink ancestor that redirects a future write.
	let ancestor = absolute;
	while (!existsSync(ancestor)) ancestor = dirname(ancestor);
	assertContained(realpathSync(root), realpathSync(ancestor), label);
	return path;
}
function isolateEnvironment(root) {
	const previous = Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]]));
	Object.assign(process.env, {
		HOME: root,
		USERPROFILE: root,
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
		CLAUDE_CONFIG_DIR: join(root, "claude"),
		CLAUDE_BRIDGE_DEBUG_PATH: join(root, "claude-bridge.log"),
		TMPDIR: root, TMP: root, TEMP: root,
	});
	delete process.env.CLAUDE_BRIDGE_RECORD_STREAM;
	return () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

export const testRoot = mkdtempSync(join(tmpdir(), "claude-bridge-test-log-"));
const restoreRunnerEnvironment = isolateEnvironment(testRoot);
process.on("exit", () => {
	restoreRunnerEnvironment();
	rmSync(testRoot, { recursive: true, force: true });
});
// Import only after redirecting environment: these modules may capture paths.
const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
const { globalConfigPath } = await import("../../src/config.js");
// Check real exported values without priming the production module's cache:
// a test may install another owned fixture before its first bridge import.
const { DEBUG_LOG_PATH, DIAG_LOG_PATH } = await import("../../src/log-paths.js?isolation-preflight");

/** Source-grounded resolvers: getAgentDir/globalConfigPath, and log-paths.ts. */
export function assertEffectiveTestPaths(root) {
	const agent = getAgentDir();
	const paths = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		homedir: homedir(),
		getAgentDir: agent,
		globalConfigPath: globalConfigPath(),
		claudeConfig: process.env.CLAUDE_CONFIG_DIR,
		sessions: process.env.PI_CODING_AGENT_SESSION_DIR,
		debug: process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(agent, "claude-bridge.log"),
		diagnostics: join(agent, "claude-bridge-diag.log"),
	};
	for (const [label, path] of Object.entries(paths)) assertOwnedPath(root, path, label);
	if (process.env.CLAUDE_BRIDGE_RECORD_STREAM) assertOwnedPath(root, process.env.CLAUDE_BRIDGE_RECORD_STREAM, "stream recording");
	return paths;
}
assertEffectiveTestPaths(testRoot);
assertOwnedPath(testRoot, DEBUG_LOG_PATH, "captured DEBUG_LOG_PATH");
assertOwnedPath(testRoot, DIAG_LOG_PATH, "captured DIAG_LOG_PATH");

/** Synchronous config tests receive a fresh scope, including inherited overrides. */
export function withTempHome(fn) {
	const home = mkdtempSync(join(testRoot, "home-"));
	const restore = isolateEnvironment(home);
	try {
		assertEffectiveTestPaths(home);
		const result = fn(home);
		if (result && typeof result.then === "function") throw new Error("withTempHome requires a synchronous fixture callback");
		return result;
	} finally {
		restore();
		rmSync(home, { recursive: true, force: true });
	}
}
