import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueryContext } from "../src/query-state.js";
import { headlessReading, ledgerAppendsSettled, recordHeadlessReading } from "../src/usage-ledger.js";

const { __test } = await import("../src/index.js");

const fixtureModel = {
	api: "anthropic-messages", provider: "anthropic", id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const recordedSession = "00000000-0000-4000-8000-000000000001";

function fixture(name) {
	const path = new URL(`./fixtures/sdk-streams/${name}.jsonl`, import.meta.url);
	return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function replay(messages, onResponse = () => {}) {
	const c = new QueryContext();
	c.currentPiStream = { push: () => {}, end: () => {} };
	c.currentOnResponse = onResponse;
	c.resetTurnState(fixtureModel);
	async function* stream() { for (const m of messages) yield m; }
	const outcome = await __test.consumeQuery(stream(), new Map(), fixtureModel, () => false, c);
	await ledgerAppendsSettled();
	return { c, outcome };
}

let root;
let saved;
const usageDir = () => join(root, "state", "tui-dash", "usage");
const ledgerLines = () =>
	existsSync(usageDir())
		? readdirSync(usageDir()).sort().flatMap((name) => readFileSync(join(usageDir(), name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
		: [];

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "usage-ledger-"));
	saved = { XDG_STATE_HOME: process.env.XDG_STATE_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
	process.env.XDG_STATE_HOME = join(root, "state");
	process.env.CLAUDE_CONFIG_DIR = "/srv/claude-accounts/invented-folder-a/";
	mkdirSync(join(root, "state", "tui-dash"), { recursive: true });
});

afterEach(() => {
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("usage ledger headless readings", () => {
	it("appends one tagged entry per rate_limit_event, not one per query", async () => {
		await replay(fixture("parallel-tools"));

		const lines = ledgerLines();
		assert.deepEqual(lines.map(({ at, ...rest }) => rest), [14, 15].map((fiveHour) => ({
			schemaVersion: 1,
			kind: "claude-headless-reading",
			sessionId: recordedSession,
			claudeHome: "/srv/claude-accounts/invented-folder-a",
			windows: [
				{ window: "five_hour", usedPercent: fiveHour, resetsAt: "2026-09-18T22:30:00.000Z" },
				{ window: "seven_day", usedPercent: 1, resetsAt: "2026-09-22T02:00:00.000Z" },
			],
		})));
		assert.deepEqual(readdirSync(usageDir()), lines.map(({ at }) => `${at.slice(0, 10)}.jsonl`).slice(0, 1));
	});

	it("writes nothing when CLAUDE_CONFIG_DIR is unset, instead of an untagged entry", async () => {
		delete process.env.CLAUDE_CONFIG_DIR;

		await replay(fixture("text"));

		assert.deepEqual(ledgerLines(), []);
	});

	it("does not create the ledger on a machine without a tui-dash state folder", async () => {
		rmSync(join(root, "state", "tui-dash"), { recursive: true });

		await replay(fixture("text"));

		assert.equal(existsSync(join(root, "state", "tui-dash")), false);
	});

	it("finishes the turn and still reports usage when the ledger path cannot be written", async () => {
		writeFileSync(usageDir(), "a file where the ledger folder belongs");
		const responses = [];

		const { c, outcome } = await replay(fixture("text"), (response) => responses.push(response));

		assert.equal(outcome.failure, undefined);
		assert.equal(c.turnOutput.stopReason, "stop");
		assert.equal(c.turnOutput.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim(), "ALPHA");
		assert.equal(responses.length, 1);
	});

	it("hands a failed append to onError rather than rejecting", async () => {
		writeFileSync(usageDir(), "a file where the ledger folder belongs");
		const errors = [];

		recordHeadlessReading(fixture("text").find((m) => m.type === "rate_limit_event").rate_limit_info, "session-b", (e) => errors.push(e));
		await ledgerAppendsSettled();

		assert.equal(errors.length, 1);
	});

	it("deletes day files more than 32 days old when a new day file starts, and keeps younger ones", async () => {
		mkdirSync(usageDir());
		const daysAgo = (n) => `${new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)}.jsonl`;
		for (const name of [daysAgo(40), daysAgo(31), "notes.txt"]) writeFileSync(join(usageDir(), name), "");

		await replay(fixture("text"));

		assert.deepEqual(readdirSync(usageDir()).sort(), [daysAgo(31), daysAgo(0), "notes.txt"].sort());
	});
});

describe("headlessReading", () => {
	const at = new Date("2026-10-17T12:00:00.000Z");

	it("leaves out a window that lacks utilization instead of writing a zero", () => {
		const reading = headlessReading(
			{ status: "allowed", unifiedWindows: { five_hour: { resetsAt: 1789770600 }, seven_day: { utilization: 0.68, resetsAt: 1794283200 } } },
			"session-c", "/srv/claude-accounts/invented-folder-b", at,
		);

		assert.deepEqual(reading?.windows, [{ window: "seven_day", usedPercent: 68, resetsAt: "2026-11-10T04:00:00.000Z" }]);
	});

	it("returns nothing for a rejection that carries no unified windows", () => {
		assert.equal(headlessReading({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1789770600 }, "session-c", "/srv/claude-accounts/invented-folder-b", at), undefined);
	});
});
