import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RateLimitInfo } from "./rate-limit.js";

const LEDGER_WINDOWS = ["five_hour", "seven_day"] as const;

type LedgerWindow = { window: (typeof LEDGER_WINDOWS)[number]; usedPercent: number; resetsAt: string };

export type HeadlessReading = {
	schemaVersion: 1;
	kind: "claude-headless-reading";
	at: string;
	sessionId: string;
	claudeHome: string;
	windows: [LedgerWindow, ...LedgerWindow[]];
};

const DAY_MS = 86_400_000;
// tui-dash keeps 32 days so the start of a 31 day window stays readable.
const RETAINED_DAYS = 32;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

const nonBlank = (value: string | undefined): string | undefined => (value?.trim() ? value : undefined);

export function ledgerClaudeHome(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return nonBlank(env.CLAUDE_CONFIG_DIR)?.replace(/\/+$/, "");
}

export function tuiDashStateDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(nonBlank(env.XDG_STATE_HOME) ?? join(env.HOME ?? homedir(), ".local", "state"), "tui-dash");
}

// A window needs both numbers, and a reading needs one such window, or tui-dash rejects the line.
export function headlessReading(info: RateLimitInfo, sessionId: string, claudeHome: string, at: Date): HeadlessReading | undefined {
	const windows = LEDGER_WINDOWS.flatMap((window): LedgerWindow[] => {
		const reading = info.unifiedWindows?.[window];
		if (reading?.utilization === undefined || reading.resetsAt === undefined) return [];
		return [{ window, usedPercent: Math.round(reading.utilization * 100), resetsAt: new Date(reading.resetsAt * 1000).toISOString() }];
	});
	const [first, ...rest] = windows;
	if (!first) return undefined;
	return { schemaVersion: 1, kind: "claude-headless-reading", at: at.toISOString(), sessionId, claudeHome, windows: [first, ...rest] };
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

async function appendToLedger(stateDir: string, reading: HeadlessReading): Promise<void> {
	// Creating tui-dash's state folder would litter every bridge user's machine that never ran tui-dash.
	if (!(await stat(stateDir).then((info) => info.isDirectory(), () => false))) return;
	const directory = join(stateDir, "usage");
	const atMs = Date.parse(reading.at);
	const day = `${dayOf(atMs)}.jsonl`;
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const names = await readdir(directory);
	// One write of one line under O_APPEND lands whole beside tui-dash's own writer.
	await appendFile(join(directory, day), `${JSON.stringify(reading)}\n`, { flag: "a", mode: 0o600 });
	if (names.includes(day)) return;
	const oldest = dayOf(atMs - RETAINED_DAYS * DAY_MS);
	const expired = names.filter((name) => (DAY_FILE.exec(name)?.[1] ?? oldest) < oldest);
	await Promise.all(expired.map((name) => rm(join(directory, name), { force: true })));
}

let appends: Promise<void> = Promise.resolve();

// The caller never awaits this, so a slow or failing disk cannot hold up a model request.
export function recordHeadlessReading(
	info: RateLimitInfo,
	sessionId: string,
	onError: (error: unknown) => void,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const claudeHome = ledgerClaudeHome(env);
	if (claudeHome === undefined) return;
	const reading = headlessReading(info, sessionId, claudeHome, new Date());
	if (!reading) return;
	const stateDir = tuiDashStateDir(env);
	appends = appends.then(() => appendToLedger(stateDir, reading)).catch(onError);
}

export function ledgerAppendsSettled(): Promise<void> {
	return appends;
}
