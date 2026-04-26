// SDK-level provider settings read from pi's shared settings.json.
//
// Distinct from config.ts (user-facing AskClaude config). These are low-level
// knobs passed straight to the Claude Agent SDK: appendSystemPrompt, which
// setting sources to load, and strictMcpConfig. Read from
// ~/.pi/agent/settings.json and .pi/settings.json (project overrides global).
// Accepts three key variants for the settings block —
// `claudeAgentSdkProvider`, `claude-agent-sdk-provider`, `claudeAgentSdk` —
// for tolerance with how pi users may already have their settings laid out.

import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const PROJECT_SETTINGS_PATH = join(process.cwd(), ".pi", "settings.json");

export type ProviderSettings = {
	appendSystemPrompt?: boolean;
	settingSources?: SettingSource[];
	strictMcpConfig?: boolean;
};

export function loadProviderSettings(): ProviderSettings {
	const globalSettings = readSettingsFile(GLOBAL_SETTINGS_PATH);
	const projectSettings = readSettingsFile(PROJECT_SETTINGS_PATH);
	return { ...globalSettings, ...projectSettings };
}

export function readSettingsFile(filePath: string): ProviderSettings {
	if (!existsSync(filePath)) return {};
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const settingsBlock =
			(parsed["claudeAgentSdkProvider"] as Record<string, unknown> | undefined) ??
			(parsed["claude-agent-sdk-provider"] as Record<string, unknown> | undefined) ??
			(parsed["claudeAgentSdk"] as Record<string, unknown> | undefined);
		if (!settingsBlock || typeof settingsBlock !== "object") return {};
		const appendSystemPrompt =
			typeof settingsBlock["appendSystemPrompt"] === "boolean" ? settingsBlock["appendSystemPrompt"] : undefined;
		const settingSourcesRaw = settingsBlock["settingSources"];
		const settingSources =
			Array.isArray(settingSourcesRaw) &&
			settingSourcesRaw.every((value) => typeof value === "string" && (value === "user" || value === "project" || value === "local"))
				? (settingSourcesRaw as SettingSource[])
				: undefined;
		const strictMcpConfig =
			typeof settingsBlock["strictMcpConfig"] === "boolean" ? settingsBlock["strictMcpConfig"] : undefined;
		return { appendSystemPrompt, settingSources, strictMcpConfig };
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${filePath}: ${e}`);
		return {};
	}
}
