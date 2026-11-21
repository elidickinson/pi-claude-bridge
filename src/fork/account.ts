// /claude-account: pick which Claude Code login a project runs on, and sign in to it
// without leaving pi. The choice lives in the project's .pi/claude-bridge.json as
// provider.account; activation maps it to CLAUDE_CONFIG_DIR.

import { execFileSync, spawn } from "child_process";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { homedir } from "os";
import { dirname, join } from "path";
import { loadConfig, type Config } from "../config.js";
import { accountConfigDir } from "./config.js";

const ORIGINAL_CONFIG_DIR = Symbol.for("claude-bridge:original-claude-config-dir");

/** Activate before any Claude Code child or session path is created. Never fall
 *  back to the default login when a selected account is missing. */
export function registerAccount(pi: ExtensionAPI, provider: Config["provider"] = {}): void {
	const dir = applyAccount(provider.account);
	if (provider.account !== undefined && dir !== undefined && !existsSync(dir)) {
		console.error(`claude-bridge: account "${provider.account}" is not signed in. Run /claude-account login`);
	}
	pi.registerCommand("claude-account", claudeAccountCommand);
}

/** Point every Claude Code child at the account's login, or back at whatever
 *  CLAUDE_CONFIG_DIR pi was started with. The original is remembered across
 *  reloads, so switching back to the default undoes an earlier account. */
export function applyAccount(account: string | undefined): string | undefined {
	const dir = accountDir(account);
	if (dir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
	else process.env.CLAUDE_CONFIG_DIR = dir;
	return dir;
}

/** The Claude Code config dir an account uses; undefined account means pi's own. */
function accountDir(account: string | undefined): string | undefined {
	// Captured on the first call, before applyAccount ever changes the variable.
	const g = globalThis as Record<symbol, { value: string | undefined } | undefined>;
	g[ORIGINAL_CONFIG_DIR] ??= { value: process.env.CLAUDE_CONFIG_DIR };
	return account === undefined ? g[ORIGINAL_CONFIG_DIR].value : accountConfigDir(account);
}

function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "claude-bridge.json");
}

/** Set or clear provider.account in the project config, keeping every other field.
 *  Refuses a file that does not parse rather than overwrite the user's settings. */
export function writeProjectAccount(cwd: string, account: string | undefined): string {
	if (account !== undefined) accountConfigDir(account);
	const path = projectConfigPath(cwd);
	let config: Partial<Config> = {};
	if (existsSync(path)) {
		try {
			config = JSON.parse(readFileSync(path, "utf-8"));
		} catch (e) {
			throw new Error(`${path} does not parse, fix it first: ${e}`);
		}
	}
	const provider = { ...config.provider, account };
	if (account === undefined) delete provider.account;
	const next: Partial<Config> = { ...config, provider };
	if (Object.keys(provider).length === 0) delete next.provider;
	if (Object.keys(next).length === 0) {
		rmSync(path, { force: true });
	} else {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
	}
	return path;
}

/** Keep a personal account choice out of the project's git history: exclude the
 *  config locally unless git already ignores or tracks it. Not a repo: nothing to do. */
export function excludeFromGit(cwd: string): void {
	const file = join(CONFIG_DIR_NAME, "claude-bridge.json");
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	try {
		git("rev-parse", "--git-dir");
	} catch {
		return;
	}
	try {
		git("check-ignore", "-q", file);
		return;
	} catch {}
	try {
		git("ls-files", "--error-unmatch", file);
		return;
	} catch {}
	const exclude = join(cwd, git("rev-parse", "--git-path", "info/exclude"));
	mkdirSync(dirname(exclude), { recursive: true });
	const current = existsSync(exclude) ? readFileSync(exclude, "utf-8") : "";
	appendFileSync(exclude, `${current === "" || current.endsWith("\n") ? "" : "\n"}/${file.replaceAll("\\", "/")}\n`);
}

/** The Claude Code binary the Agent SDK runs: the configured path, else the SDK's
 *  bundled native binary, else whatever `claude` is on PATH. */
export function claudeExecutable(configured?: string): string {
	if (configured) return configured;
	const require = createRequire(import.meta.url);
	const ext = process.platform === "win32" ? ".exe" : "";
	const pkg = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
	for (const candidate of process.platform === "linux" ? [pkg, `${pkg}-musl`] : [pkg]) {
		try {
			return require.resolve(`${candidate}/claude${ext}`);
		} catch {}
	}
	return "claude";
}

function childEnv(dir: string | undefined): NodeJS.ProcessEnv {
	const env = { ...process.env };
	if (dir === undefined) delete env.CLAUDE_CONFIG_DIR;
	else env.CLAUDE_CONFIG_DIR = dir;
	return env;
}

interface LoginStatus {
	loggedIn: boolean;
	email?: string;
	orgName?: string;
}

function loginStatus(exe: string, dir: string | undefined): Promise<LoginStatus> {
	return new Promise((resolve) => {
		const child = spawn(exe, ["auth", "status", "--json"], { env: childEnv(dir), stdio: ["ignore", "pipe", "ignore"] });
		let out = "";
		child.stdout.on("data", (chunk) => { out += chunk; });
		child.on("error", () => resolve({ loggedIn: false }));
		child.on("close", () => {
			try {
				resolve(JSON.parse(out));
			} catch {
				resolve({ loggedIn: false });
			}
		});
	});
}

function signOut(exe: string, dir: string | undefined): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(exe, ["auth", "logout"], { env: childEnv(dir), stdio: "ignore" });
		child.on("error", () => resolve(false));
		child.on("close", (code) => resolve(code === 0));
	});
}

function describe(status: LoginStatus): string {
	if (!status.loggedIn) return "not signed in";
	return [status.email, status.orgName].filter(Boolean).join(", ") || "signed in";
}

/** Run `claude auth login` for the account: show its sign-in link, ask for the code the
 *  browser page gives, and feed it to Claude Code. A browser that completes the sign-in
 *  on its own closes the code prompt. */
function signIn(ctx: ExtensionCommandContext, exe: string, dir: string | undefined): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(exe, ["auth", "login"], { env: childEnv(dir), stdio: ["pipe", "pipe", "pipe"] });
		const exited = new AbortController();
		let output = "";
		let prompted = false;
		const onOutput = (chunk: Buffer) => {
			output += chunk.toString();
			const url = output.match(/https:\/\/\S+/)?.[0];
			if (prompted || !url || !/paste code/i.test(output)) return;
			prompted = true;
			ctx.ui.notify(`Sign in to Claude: ${url}`, "info");
			void ctx.ui.input("Paste the code from the sign-in page", "code", { signal: exited.signal }).then((code) => {
				if (code?.trim()) child.stdin.end(`${code.trim()}\n`);
				else if (!exited.signal.aborted) child.kill();
			});
		};
		child.stdout.on("data", onOutput);
		child.stderr.on("data", onOutput);
		child.on("error", (e) => {
			ctx.ui.notify(`Could not run ${exe}: ${e.message}`, "error");
			resolve(false);
		});
		child.on("close", (code) => {
			exited.abort();
			if (code !== 0) {
				const reason = output.split("\n").map((line) => line.trim()).filter((line) => /fail|error/i.test(line)).pop();
				ctx.ui.notify(`Sign-in did not finish${reason ? `: ${reason}` : ""}`, "error");
			}
			resolve(code === 0);
		});
	});
}

function knownAccounts(): string[] {
	try {
		return readdirSync(join(homedir(), ".claude-accounts"), { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}

const USAGE = "Usage: /claude-account [<name> | default | login | logout]";

export const claudeAccountCommand = {
	description: "Show, switch or sign in to this project's Claude account",
	getArgumentCompletions(prefix: string) {
		const items = ["default", "login", "logout", ...knownAccounts()]
			.filter((value) => value.startsWith(prefix.trim()))
			.map((value) => ({ value, label: value }));
		return items.length ? items : null;
	},
	async handler(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const arg = args.trim();
		const provider = loadConfig(ctx.cwd).provider ?? {};
		const exe = claudeExecutable(provider.pathToClaudeCodeExecutable);
		const current = provider.account;
		const label = (account: string | undefined) => account ?? "default (your own Claude Code login)";

		if (arg === "" || arg === "login") {
			const dir = accountDir(current);
			let status = await loginStatus(exe, dir);
			if (arg === "login" || (!status.loggedIn && await ctx.ui.confirm("Claude account", `${label(current)} is not signed in. Sign in now?`))) {
				if (!await signIn(ctx, exe, dir)) return;
				status = await loginStatus(exe, dir);
			}
			ctx.ui.notify(`Claude account: ${label(current)}: ${describe(status)}`, status.loggedIn ? "info" : "warning");
			return;
		}

		if (arg === "logout") {
			if (!await ctx.ui.confirm("Claude account", `Sign out of ${label(current)}?`)) return;
			const ok = await signOut(exe, accountDir(current));
			ctx.ui.notify(ok ? `Signed out of ${label(current)}` : `Sign-out of ${label(current)} failed`, ok ? "info" : "error");
			return;
		}

		if (/\s/.test(arg)) {
			ctx.ui.notify(USAGE, "warning");
			return;
		}
		const account = arg === "default" ? undefined : arg;
		let dir: string | undefined;
		try {
			// A typo must not become an account: Claude Code creates the folder on first use.
			if (account !== undefined && !existsSync(accountConfigDir(account))
				&& !await ctx.ui.confirm("Claude account", `No account named ${account} yet. Create it?`)) {
				ctx.ui.notify(USAGE, "info");
				return;
			}
			writeProjectAccount(ctx.cwd, account);
			if (account !== undefined) {
				excludeFromGit(ctx.cwd);
				dir = accountConfigDir(account);
			}
		} catch (e) {
			ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
			return;
		}
		if (dir !== undefined && !(await loginStatus(exe, dir)).loggedIn
			&& await ctx.ui.confirm("Claude account", `${account} is not signed in yet. Sign in now?`)) {
			await signIn(ctx, exe, dir);
		}
		ctx.ui.notify(`Claude account for this project: ${label(account)}`, "info");
		await ctx.waitForIdle();
		await ctx.reload();
	},
};
