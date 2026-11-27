// Recovers a Claude Code launch when the SDK can no longer find its native binary.
//
// The SDK finds the binary with require.resolve, and Node caches that answer for the
// life of the process. pi updates packages under running sessions, and npm can move the
// SDK when it does: with this package and AskClaude pinning different SDK versions, the
// bridge's copy is installed nested under this package, then hoisted (and the nested
// copy deleted) once AskClaude pins the same version. Every later launch in a pi that
// started in between fails with "Native CLI binary for darwin-arm64 not found" until pi
// restarts, though the binary is installed. query() throws that synchronously, so the
// launch is retried once with the binary looked up on disk again.

import type { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { debug } from "./debug.js";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const MISSING_BINARY = /^Native CLI binary for \S+ not found\./;

function isMusl(): boolean {
	if (process.platform !== "linux" || typeof process.report?.getReport !== "function") return false;
	const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
	return report.header?.glibcVersionRuntime === undefined;
}

// The SDK's own candidates, in its order (vJ() in sdk.mjs 0.3.321).
function binaryCandidates(): string[] {
	const { platform, arch } = process;
	const names = platform === "android" ? [`linux-${arch}-android`]
		: platform !== "linux" ? [`${platform}-${arch}`]
		: isMusl() ? [`linux-${arch}-musl`, `linux-${arch}`] : [`linux-${arch}`, `linux-${arch}-musl`];
	return names.map((name) => join(`${SDK_PACKAGE}-${name}`, platform === "win32" ? "claude.exe" : "claude"));
}

/** The binary that node_modules lookup from `from` finds on disk now, ignoring Node's resolution cache. */
export function findClaudeExecutable(from = dirname(fileURLToPath(import.meta.url))): string | undefined {
	for (const candidate of binaryCandidates()) {
		for (let dir = from; ; dir = dirname(dir)) {
			const path = join(dir, "node_modules", candidate);
			if (basename(dir) !== "node_modules" && existsSync(path)) return path;
			if (dirname(dir) === dir) break;
		}
	}
	return undefined;
}

/** query(), retried once with a freshly found binary if the SDK's cached lookup points at a deleted one. */
export function queryWithFreshBinary(
	queryImpl: typeof query,
	params: Parameters<typeof query>[0],
	from?: string,
): ReturnType<typeof query> {
	try {
		return queryImpl(params);
	} catch (error) {
		if (params.options?.pathToClaudeCodeExecutable || !(error instanceof Error) || !MISSING_BINARY.test(error.message)) throw error;
		const found = findClaudeExecutable(from);
		if (!found) throw error;
		debug(`claude executable: the SDK's lookup failed, retrying with ${found}`);
		return queryImpl({ ...params, options: { ...params.options, pathToClaudeCodeExecutable: found } });
	}
}
