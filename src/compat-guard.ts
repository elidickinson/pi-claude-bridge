import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// src/index.ts imports "@earendil-works/pi-ai/compat" at top level. If a pi install
// resolves @earendil-works/pi-ai to a copy that lacks the "./compat" export, that import
// fails while the module graph is still loading — before any of the bridge's own code
// runs. pi then reports a generic extension-load error, and the "claude-bridge" provider
// is silently absent from /model.
//
// src/entry.ts runs this check first and only then dynamically imports src/index.ts, so
// the same failure surfaces as a named, actionable load error instead of an opaque load
// error with no provider.

export const REQUIRED_PI_AI = "0.86.1";

export interface GuardDeps {
	importCompat: () => Promise<unknown>;
	resolvePiAi: () => { version: string; dir: string } | undefined;
}

export type GuardResult = { ok: true; version?: string } | { ok: false; message: string };

export type BridgeModule = { default: (pi: ExtensionAPI) => unknown };

export function compareVersions(a: string, b: string): number {
	const parse = (v: string) =>
		v
			.split("-")[0]
			.split(".")
			.map((n) => Number.parseInt(n, 10) || 0);
	const pa = parse(a);
	const pb = parse(b);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d < 0 ? -1 : 1;
	}
	return 0;
}

function failureMessage(problem: string, foundText: string): string {
	return [
		`[pi-claude-bridge] LOAD FAILED: ${problem}.`,
		`  needs:    @earendil-works/pi-ai with a "./compat" export (>= ${REQUIRED_PI_AI})`,
		`  found:    ${foundText}`,
		`  effect:   the "claude-bridge" provider was NOT registered; agents pinned to claude-bridge/* will not run on Claude.`,
		`  fix:      remove or upgrade the stale @earendil-works/pi-coding-agent / pi-ai copy that shadows pi's runtime (inspect with: npm ls @earendil-works/pi-ai --prefix ~/.pi/agent/npm), then start a new pi session.`,
	].join("\n");
}

// The hard check is the compat IMPORT itself: pi-ai < 0.86 does not export "./compat" at all, so a
// stale copy fails here with certainty. The resolved version is reported for diagnosis only — it is
// NOT a gate. pi loads extensions through a loader that maps "@earendil-works/pi-ai" to pi's own
// runtime copy, which can differ from the copy this file resolves from disk; gating on that copy
// could reject a bridge that would in fact load fine.
export async function checkPiAiCompat(deps: GuardDeps): Promise<GuardResult> {
	// The version lookup is informational: it must never abort loading, so any throw is swallowed.
	let found: { version: string; dir: string } | undefined;
	try {
		found = deps.resolvePiAi();
	} catch {
		found = undefined;
	}
	const foundText = found
		? `${found.version} at ${found.dir} (resolved from this extension's location; informational)`
		: "not resolvable (informational)";
	try {
		await deps.importCompat();
	} catch (err) {
		const cause = err instanceof Error ? err.message : String(err);
		return { ok: false, message: failureMessage(`cannot import "@earendil-works/pi-ai/compat" (${cause})`, foundText) };
	}
	return { ok: true, version: found?.version };
}

/** Directory of a resolved module path. `import.meta.resolve` yields a file URL;
 *  `require.resolve` yields a plain path (fileURLToPath throws on those). */
export function dirFromResolved(resolved: string): string {
	return dirname(resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved);
}

export function defaultGuardDeps(): GuardDeps {
	const require = createRequire(import.meta.url);
	return {
		importCompat: () => import("@earendil-works/pi-ai/compat"),
		resolvePiAi: () => {
			// pi-ai >=0.86 exports are import-only (no "require" condition), so CJS
			// require.resolve throws; try ESM resolution first, CJS as fallback.
			// Never throws: the caller treats this as informational.
			try {
				let resolved: string | undefined;
				try {
					resolved = import.meta.resolve("@earendil-works/pi-ai");
				} catch {
					resolved = require.resolve("@earendil-works/pi-ai");
				}
				let dir = dirFromResolved(resolved);
				for (let i = 0; i < 8; i++) {
					const pj = join(dir, "package.json");
					if (existsSync(pj)) {
						try {
							const pkg = JSON.parse(readFileSync(pj, "utf8"));
							if (pkg.name === "@earendil-works/pi-ai") return { version: String(pkg.version), dir };
						} catch {
							// unreadable package.json: keep walking up
						}
					}
					const up = dirname(dir);
					if (up === dir) break;
					dir = up;
				}
			} catch {
				// any resolution/read failure is reported as "not resolvable"
			}
			return undefined;
		},
	};
}

export async function guardedRegister(
	pi: ExtensionAPI,
	deps: GuardDeps,
	loadBridge: () => Promise<BridgeModule>,
): Promise<unknown> {
	const result = await checkPiAiCompat(deps);
	if (result.ok === false) {
		console.error(`\n${result.message}\n`);
		throw new Error(result.message);
	}
	const mod = await loadBridge();
	return mod.default(pi);
}
