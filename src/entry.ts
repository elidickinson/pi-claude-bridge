import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultGuardDeps, guardedRegister } from "./compat-guard.js";

// pi's extension entry point (see package.json "pi.extensions"). It must not statically
// import ./index.js: that module imports "@earendil-works/pi-ai/compat" at top level, and
// when the export is missing that import aborts the whole graph before any code runs.
// compat-guard verifies the import first, and only then is the bridge loaded — so a
// missing "./compat" export is a named load error instead of a silently dropped provider.
export default async function (pi: ExtensionAPI): Promise<void> {
	await guardedRegister(pi, defaultGuardDeps(), () => import("./index.js"));
}
