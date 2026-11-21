// Only the named login is project-controlled; executable and billing settings
// stay global. Keep this policy out of upstream's config loader.
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { homedir } from "os";
import { join } from "path";
import type { Config } from "../config.js";

export interface AccountProvider {
	/** Unset keeps Claude Code's default login. */
	account?: string;
}

/** Reject names that could escape ~/.claude-accounts and select another login. */
export function accountConfigDir(account: string): string {
	if (!/^[\w-][\w.-]*$/.test(account)) {
		throw new Error(`claude-bridge: provider.account ${JSON.stringify(account)} must be a plain name like "banx"`);
	}
	return join(homedir(), ".claude-accounts", account);
}

export function withProjectAccount(config: Config, cwd: string, parse: (path: string) => Partial<Config>): Config {
	const project = parse(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	return {
		...config,
		provider: { ...config.provider, ...(project.provider?.account !== undefined ? { account: project.provider.account } : {}) },
	};
}
