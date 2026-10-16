// Switchable Claude accounts: which OAuth token Claude Code runs on, and the plan
// usage the last rate_limit_event reported for it. Config holds the token inline,
// or names where it lives (env var or file).

import { createHash } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import type { RateLimitInfo } from "./rate-limit.js";

export type AccountSource = { token?: string; tokenEnv?: string; tokenFile?: string };

/** No override: Claude Code picks its own credentials (settings.json env, then /login). */
export const DEFAULT_ACCOUNT = "default";

export function resolveToken(name: string, source: AccountSource | undefined, env: NodeJS.ProcessEnv = process.env): string {
	if (!source) throw new Error(`claude-bridge: account "${name}" is not in claude-bridge.json "accounts"`);
	const where = source.token !== undefined ? "inline token" : source.tokenEnv ? `env ${source.tokenEnv}` : source.tokenFile ? `file ${source.tokenFile}` : "no token/tokenEnv/tokenFile";
	let raw: string | undefined;
	if (source.token !== undefined) raw = source.token;
	else if (source.tokenEnv) raw = env[source.tokenEnv];
	else if (source.tokenFile) raw = readFileSync(source.tokenFile.replace(/^~(?=\/)/, homedir()), "utf-8");
	const token = raw?.trim();
	if (!token) throw new Error(`claude-bridge: account "${name}" has no token (${where})`);
	return token;
}

let settingsDir: string | undefined;

/**
 * `settings` with the token layered into its env, as a path to a 0600 file. The SDK hands
 * inline settings to the CLI as an argv JSON string, readable by anyone via `ps`. Flag
 * settings outrank ~/.claude/settings.json, whose env would otherwise win over the child env.
 */
export function settingsWithToken(settings: Settings, token: string): string {
	const body = JSON.stringify({ ...settings, env: { ...settings.env, CLAUDE_CODE_OAUTH_TOKEN: token } });
	// Recreated if tmp cleanup removed it mid-session. mkdtemp creates it 0700.
	if (!settingsDir || !existsSync(settingsDir)) {
		if (!settingsDir) process.once("exit", removeSettingsDir);
		settingsDir = mkdtempSync(join(tmpdir(), "claude-bridge-"));
	}
	const path = join(settingsDir, `${createHash("sha256").update(body).digest("hex").slice(0, 16)}.json`);
	if (!existsSync(path)) writeFileSync(path, body, { mode: 0o600 });
	return path;
}

// ponytail: SIGTERM/crash skip "exit" and leave the 0700 dir in tmp; tmpfs or reboot clears it.
function removeSettingsDir(): void {
	if (settingsDir) rmSync(settingsDir, { recursive: true, force: true });
}

type Windows = NonNullable<RateLimitInfo["unifiedWindows"]>;

/** Merges a rate_limit_event into the windows seen so far: an event may carry only some windows. */
export function mergeWindows(previous: Windows, info: RateLimitInfo & { utilization?: number }): Windows {
	const next = { ...previous, ...info.unifiedWindows };
	if (!info.unifiedWindows && info.rateLimitType && info.utilization !== undefined) {
		next[info.rateLimitType] = { utilization: info.utilization, resetsAt: info.resetsAt };
	}
	return next;
}

export function formatAccountStatus(account: string, windows: Windows): string {
	const pct = (name: string) => {
		const u = windows[name]?.utilization;
		return u === undefined ? "–" : `${Math.round(u * 100)}%`;
	};
	// Nerd Font glyphs: nf-fa-user, nf-fa-clock_o, nf-fa-calendar.
	return `\uf007 ${account}  \uf017 5h ${pct("five_hour")}  \uf073 7d ${pct("seven_day")}`;
}
