// Activates the extension with a recording pi stub and starts an isolated fork
// whose Claude Code process is a real node child. Shared by the in-process and
// SIGTERM-subprocess shutdown tests (tests/unit-fork-shutdown.mjs).
//
// CLAUDE_CONFIG_DIR must point at a throwaway dir before this is imported.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { getSessionPath, openSession } from "cc-session-io";

const mod = await import("../../src/index.js");
const { __test } = mod;
const { ISOLATED_FORK_CHANNEL } = await import("../../src/isolated-fork.js");

export const handlers = new Map();
const bus = createEventBus();
let providerConfig;
mod.default({
	on: (event, handler) => handlers.set(event, handler),
	registerProvider: (_name, config) => { providerConfig = config; },
	events: bus,
	registerTool: () => {},
});
const model = providerConfig.models[0];
export const cwd = process.cwd();

const tools = [{ name: "compress", description: "Compress a range", parameters: { type: "object", properties: {} } }];
const scripts = [];
__test.setQuery(({ options }) => {
	const script = scripts.shift();
	if (!script) throw new Error("no fake script queued");
	script.onStart?.(options);
	const gen = (async function* () {
		for (const step of script.steps) {
			if (typeof step === "function") { await step(options); continue; }
			const id = options.forkSession ? options.sessionId : options.resume;
			yield step.type === "system" && id ? { ...step, session_id: id } : step;
		}
	})();
	gen.interrupt = async () => {};
	gen.close = () => {};
	return gen;
});

export const sessionExists = (sessionId) => existsSync(getSessionPath(sessionId, cwd, process.env.CLAUDE_CONFIG_DIR));

/** Starts a main turn, then a fork whose CC process runs `childSource` and
 *  stays alive until killed. Resolves once the child has printed "ready". */
export async function startForkWithChild(childSource) {
	let clock = 0;
	const prompt = "[m00002] next";
	const history = [
		{ role: "user", content: "[m00001] hello", timestamp: clock++ },
		{ role: "assistant", content: [{ type: "text", text: "hi" }], api: "claude-bridge", provider: "claude-bridge", model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: clock++ },
		{ role: "user", content: prompt, timestamp: clock++ },
	];
	let releaseMain;
	const mainHeld = new Promise((r) => { releaseMain = r; });
	const append = (sessionId, record) => {
		const session = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
		const last = session.records.at(-1);
		appendFileSync(session.jsonlPath, JSON.stringify({ uuid: randomUUID(), parentUuid: last?.uuid ?? null, sessionId, timestamp: new Date().toISOString(), ...record }) + "\n");
	};
	// The fork starts once the main turn has answered, so the main turn answers.
	const answer = randomUUID();
	scripts.push({
		onStart: (options) => append(options.resume, { type: "user", message: { role: "user", content: prompt } }),
		steps: [
			{ type: "system", subtype: "init" },
			() => mainHeld,
			(options) => append(options.resume, { type: "assistant", uuid: answer, message: { role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" } }),
			{ type: "assistant", uuid: answer, message: { id: "msg_main", role: "assistant", content: [{ type: "text", text: "ok" }] } },
			{ type: "result", subtype: "success", is_error: false, result: "ok" },
		],
	});
	const main = providerConfig.streamSimple(model, { messages: history, tools }, { sessionId: "pi-shutdown" });

	let child;
	let ready;
	const childReady = new Promise((r) => { ready = r; });
	let forkId;
	scripts.push({
		onStart: (options) => {
			forkId = options.sessionId;
			// What Claude Code does with forkSession: copy the session under the new id.
			writeFileSync(getSessionPath(forkId, cwd, process.env.CLAUDE_CONFIG_DIR), "{}\n");
			child = options.spawnClaudeCodeProcess({ command: process.execPath, args: ["-e", childSource], cwd, env: process.env, signal: options.abortController.signal });
			child.stdout.once("data", () => ready());
		},
		steps: [{ type: "system", subtype: "init" }, (options) => new Promise((r) => options.abortController.signal.addEventListener("abort", r, { once: true }))],
	});
	// ACP asks once the main reply streams, by when CC's init named the main session.
	const mainStarted = () => __test.servedRequests.get("pi-shutdown") && [...__test.activeQueryContexts].some((c) => c.ccSessionId);
	for (let i = 0; i < 1000 && !mainStarted(); i++) await new Promise((r) => setImmediate(r));
	let accepted;
	bus.emit(ISOLATED_FORK_CHANNEL, {
		version: 1, piSessionId: "pi-shutdown", prompt: "NUDGE", captureTool: "compress", signal: new AbortController().signal,
		accept: (result) => { accepted = Promise.resolve(result); accepted.catch(() => {}); return true; },
	});
	if (!accepted) throw new Error("fork was not accepted");
	releaseMain();
	await main.result();
	let timer;
	const declined = accepted.then((result) => { throw new Error(`the fork ended before its process started: ${JSON.stringify(result)}`); });
	declined.catch(() => {});
	await Promise.race([childReady, declined, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("the fork's process never started")), 10_000); })]);
	clearTimeout(timer);
	return { child, forkId, accepted, finishMain: async () => {} };
}
