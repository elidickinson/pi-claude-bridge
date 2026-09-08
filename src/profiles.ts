// Profile-aware providers: each configured profile registers its own provider
// id (claude-bridge-<slug>) bound to its own CLAUDE_CONFIG_DIR, so several
// Claude Code accounts serve pi sessions side by side (upstream issue #57).
//
// The default profile is implicit and inherits the process environment
// untouched — including an inherited CLAUDE_CONFIG_DIR. `configDir: null` on a
// configured profile means "force default resolution" (REMOVE the variable):
// on macOS the keychain entry is namespaced by the config dir, and the default
// profile's .claude.json lives at ~/.claude.json in the home root, so setting
// CLAUDE_CONFIG_DIR=~/.claude explicitly is NOT equivalent to leaving it unset.
//
// Extracted from index.ts so tests can import without activating the extension.

import { homedir } from "os";
import { join } from "path";
import { PROVIDER_ID } from "./convert.js";
import type { Config } from "./config.js";

export interface BridgeProfile {
	/** Provider id this profile serves under; PROVIDER_ID for the default. */
	providerId: string;
	/** Picker label appended to model names, e.g. "Work". */
	label?: string;
	/** Expanded CLAUDE_CONFIG_DIR to pin the child to. */
	configDir?: string;
	/** Remove CLAUDE_CONFIG_DIR from the child env (configDir: null). */
	stripConfigDir?: boolean;
}

export const DEFAULT_PROFILE: BridgeProfile = { providerId: PROVIDER_ID };

export function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// Memoized per settings object: extraProfiles sits on the per-query hot path
// (profileForProvider), and re-validating there would also re-print every
// console.error once per turn into a live TUI. bs.providerSettings is assigned
// once per activation, so object identity is a stable cache key.
const profileCache = new WeakMap<object, BridgeProfile[]>();

/** Configured extra profiles, validated. Invalid entries are dropped with a
 *  console.error so the extension always starts. */
export function extraProfiles(provider: Config["provider"]): BridgeProfile[] {
	if (provider) {
		const cached = profileCache.get(provider);
		if (cached) return cached;
	}
	const out: BridgeProfile[] = [];
	const seen = new Set<string>();
	for (const entry of provider?.profiles ?? []) {
		const slug = typeof entry?.slug === "string" ? entry.slug.toLowerCase() : "";
		if (!SLUG_RE.test(slug)) {
			console.error(`claude-bridge: profile slug ${JSON.stringify(entry?.slug)} is invalid (want [a-z0-9-], starting alphanumeric) — profile skipped`);
			continue;
		}
		if (seen.has(slug)) {
			console.error(`claude-bridge: duplicate profile slug "${slug}" — profile skipped`);
			continue;
		}
		if ((typeof entry.configDir !== "string" || entry.configDir.trim() === "") && entry.configDir !== null) {
			console.error(`claude-bridge: profile "${slug}" needs configDir (non-empty path, or null for default resolution) — profile skipped`);
			continue;
		}
		seen.add(slug);
		out.push({
			providerId: `${PROVIDER_ID}-${slug}`,
			label: typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : slug,
			...(entry.configDir === null
				? { stripConfigDir: true }
				: { configDir: expandHome(entry.configDir) }),
		});
	}
	if (provider) profileCache.set(provider, out);
	return out;
}

/** Resolve the profile serving `providerId`. Non-bridge and default ids map to
 *  the default profile, preserving pre-profile behavior exactly. A
 *  `claude-bridge-*` id with no configured profile throws: it means the profile
 *  was removed or re-slugged while its provider registration (or a tracked
 *  session labeled with it) is still alive, and silently degrading to the
 *  default ACCOUNT is the exact failure mode this module exists to prevent. */
export function profileForProvider(providerId: string | undefined, provider: Config["provider"]): BridgeProfile {
	if (!providerId || !providerId.startsWith(`${PROVIDER_ID}-`)) return DEFAULT_PROFILE;
	const found = extraProfiles(provider).find((p) => p.providerId === providerId);
	if (!found) {
		throw new Error(
			`claude-bridge: no configured profile for provider "${providerId}" — it was removed or renamed in provider.profiles. ` +
			`Restore the profile in the global claude-bridge.json (and /reload), or switch to a configured model.`,
		);
	}
	return found;
}

/** Apply a profile's CLAUDE_CONFIG_DIR policy to a child env (mutates and
 *  returns `env`, which callers construct fresh per query).
 *
 *  A PINNED profile also drops inherited credential overrides: verified
 *  empirically that CLAUDE_CODE_OAUTH_TOKEN beats the config dir's stored
 *  login (auth status flips to `oauth_token`), so a host that authenticates
 *  its default account through the environment (e.g. a token in ~/.zshenv for
 *  daemon use) would otherwise run every profile on that one account — the
 *  silent wrong-account failure profiles exist to prevent. Strip profiles
 *  alias the default account, so they keep inherited credentials. */
export function applyProfileEnv(env: Record<string, string | undefined>, profile: BridgeProfile): Record<string, string | undefined> {
	if (profile.configDir) {
		env.CLAUDE_CONFIG_DIR = profile.configDir;
		delete env.CLAUDE_CODE_OAUTH_TOKEN;
		delete env.ANTHROPIC_API_KEY;
	} else if (profile.stripConfigDir) {
		delete env.CLAUDE_CONFIG_DIR;
	}
	return env;
}

/** The claudeDir under which this profile's CC session files live — what
 *  cc-session-io's createSession/deleteSession must be pointed at. Never
 *  undefined for a strip profile: cc-session-io's own fallback chain is
 *  `claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? ~/.claude`, so returning
 *  undefined would make pi WRITE the session under an inherited
 *  CLAUDE_CONFIG_DIR while the stripped child READS ~/.claude. */
export function effectiveClaudeDir(profile: BridgeProfile): string | undefined {
	if (profile.configDir) return profile.configDir;
	if (profile.stripConfigDir) return join(homedir(), ".claude");
	return process.env.CLAUDE_CONFIG_DIR;
}
