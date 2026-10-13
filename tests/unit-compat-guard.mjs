/**
 * src/index.ts imports "@earendil-works/pi-ai/compat" at top level. A pi install that
 * resolves pi-ai to a copy without that export used to abort the extension while loading:
 * pi logged a generic error and the "claude-bridge" provider was never registered. These
 * pin the load guard that runs first (src/entry.ts): it names the failure with
 * needs/found/effect/fix, and — because the compat import itself is the check — never
 * rejects a bridge that would load.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	REQUIRED_PI_AI,
	checkPiAiCompat,
	compareVersions,
	defaultGuardDeps,
	dirFromResolved,
	guardedRegister,
} from "../src/compat-guard.js";

const okImport = async () => ({});
const failImport = async () => {
	throw new Error("Cannot find module '@earendil-works/pi-ai/compat'");
};

describe("compareVersions", () => {
	it("orders numerically, not lexically", () => {
		assert.equal(compareVersions("0.79.10", "0.86.1"), -1);
		assert.equal(compareVersions("0.86.1", "0.86.1"), 0);
		assert.equal(compareVersions("1.1.0", "0.86.1"), 1);
		assert.equal(compareVersions("0.100.0", "0.99.9"), 1);
		assert.equal(compareVersions("1.1.0-beta.1", "1.1.0"), 0);
	});
});

describe("checkPiAiCompat", () => {
	it("REQUIRED_PI_AI is the pi-ai peer floor", () => {
		assert.equal(REQUIRED_PI_AI, "0.86.1");
	});

	it("import failure yields a loud named error with needs vs found, effect and fix", async () => {
		const r = await checkPiAiCompat({
			importCompat: failImport,
			resolvePiAi: () => ({ version: "0.79.10", dir: "/x/stale/pi-ai" }),
		});
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.message, /\[pi-claude-bridge\] LOAD FAILED/);
		assert.match(r.message, /needs:    @earendil-works\/pi-ai with a "\.\/compat" export/);
		assert.match(r.message, /found:    0\.79\.10 at \/x\/stale\/pi-ai/);
		assert.match(r.message, /Cannot find module/);
		assert.match(r.message, /NOT registered/);
		assert.match(r.message, /fix:/);
	});

	it("import failure with unresolvable pi-ai says 'not resolvable'", async () => {
		const r = await checkPiAiCompat({ importCompat: failImport, resolvePiAi: () => undefined });
		assert.equal(r.ok, false);
		if (r.ok) return;
		assert.match(r.message, /found:    not resolvable/);
	});

	it("passes when the import succeeds even if the resolved version looks old (the import is the hard check)", async () => {
		// A copy old enough to lack "./compat" cannot import it (see the failure cases above),
		// so a successful import is authoritative. The resolved version is informational:
		// under pi's loader it may name a different copy than the one actually imported.
		const r = await checkPiAiCompat({
			importCompat: okImport,
			resolvePiAi: () => ({ version: "0.80.0", dir: "/old" }),
		});
		assert.deepEqual(r, { ok: true, version: "0.80.0" });
	});

	it("passes when import and version both look fine", async () => {
		const r = await checkPiAiCompat({
			importCompat: okImport,
			resolvePiAi: () => ({ version: "1.1.0", dir: "/new" }),
		});
		assert.deepEqual(r, { ok: true, version: "1.1.0" });
	});

	it("passes with an unknown version when only the import is checked", async () => {
		const r = await checkPiAiCompat({ importCompat: okImport, resolvePiAi: () => undefined });
		assert.deepEqual(r, { ok: true, version: undefined });
	});

	it("never aborts loading when the informational version lookup throws", async () => {
		const boom = () => {
			throw new Error("ERR_INVALID_URL");
		};
		const ok = await checkPiAiCompat({ importCompat: okImport, resolvePiAi: boom });
		assert.equal(ok.ok, true);
		const bad = await checkPiAiCompat({ importCompat: failImport, resolvePiAi: boom });
		assert.equal(bad.ok, false);
		if (bad.ok) return;
		assert.match(bad.message, /found:    not resolvable/);
	});
});

describe("dirFromResolved", () => {
	it("handles both a file URL and a plain path", () => {
		assert.equal(dirFromResolved("file:///x/y/pi-ai/dist/index.js"), "/x/y/pi-ai/dist");
		assert.equal(dirFromResolved("/x/y/pi-ai/dist/index.js"), "/x/y/pi-ai/dist");
	});
});

describe("guardedRegister", () => {
	it("throws and never loads the bridge when the guard fails", async () => {
		let loaded = false;
		const origError = console.error;
		console.error = () => {};
		try {
			await assert.rejects(
				guardedRegister({}, { importCompat: failImport, resolvePiAi: () => undefined }, async () => {
					loaded = true;
					return { default: () => "registered" };
				}),
				/LOAD FAILED/,
			);
		} finally {
			console.error = origError;
		}
		assert.equal(loaded, false);
	});

	it("loads the bridge and passes pi through when the guard passes", async () => {
		const pi = { tag: "pi" };
		let received;
		const out = await guardedRegister(
			pi,
			{ importCompat: okImport, resolvePiAi: () => ({ version: "1.1.0", dir: "/new" }) },
			async () => ({
				default: (p) => {
					received = p;
					return "registered";
				},
			}),
		);
		assert.equal(received, pi);
		assert.equal(out, "registered");
	});
});

describe("defaultGuardDeps", () => {
	it("resolves a real pi-ai >= 0.86.1 in this repo", () => {
		const found = defaultGuardDeps().resolvePiAi();
		assert.ok(found, "pi-ai should be resolvable in this repo");
		assert.ok(compareVersions(found.version, REQUIRED_PI_AI) >= 0, `got ${found.version}`);
	});
});
