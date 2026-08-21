#!/usr/bin/env node

/**
 * Pi's `onPayload` / `onResponse` are provider-invoked, not runtime-invoked.
 *
 * `ModelRuntime.prepareRequest` consumes only `transformHeaders` and spreads the rest
 * of StreamOptions — both callbacks included — untouched into what it hands
 * `provider.streamSimple`. So a provider that never calls them makes every extension
 * on `before_provider_request` / `after_provider_response` silently inert for its
 * models: payload inspectors, cost and observability trackers, gateway and policy
 * extensions, 429 handlers reading `retry-after`. Pi only emits when `hasHandlers`, so
 * nothing warns — which is why this is pinned by tests rather than left to review.
 *
 * These drive the real `streamClaudeAgentSdk` with a stand-in for the Agent SDK's
 * `query`, so the whole fresh-query path runs without spawning Claude Code.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCtx } from "../src/query-state.js";

const { __test } = await import("../src/index.js");

const model = { api: "anthropic-messages", provider: "claude-bridge", id: "claude-sonnet-4-6" };

/** A throwaway project dir plus CLAUDE_CONFIG_DIR, so syncSharedSession writes its
 *  session file into the sandbox instead of the developer's real ~/.claude. */
function createSandbox() {
	const cwd = mkdtempSync(join(tmpdir(), "provider-hooks-"));
	const claudeDir = mkdtempSync(join(tmpdir(), "provider-hooks-cfg-"));
	const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	return {
		cwd,
		cleanup() {
			if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
			rmSync(claudeDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

/**
 * Stand-in for the SDK's `query`. Records every call's argument, yields no messages
 * (so consumeQuery returns straight away), and reports when it was first iterated —
 * iteration is the first thing that can put anything on the pi stream, so it is the
 * boundary `onResponse` has to land in front of.
 */
function recordingQuery() {
	const calls = [];
	let iterated = false;
	let interrupts = 0;
	let closes = 0;
	let settled;
	const done = new Promise((resolve) => { settled = resolve; });

	const fn = (arg) => {
		calls.push(arg);
		return {
			async *[Symbol.asyncIterator]() { iterated = true; },
			interrupt: async () => { interrupts += 1; },
			// The provider's `.finally` closes the query last, so this is the signal
			// that the whole background chain has settled.
			close: () => { closes += 1; settled(); },
		};
	};

	return {
		fn,
		calls,
		done,
		wasIterated: () => iterated,
		interrupts: () => interrupts,
		closes: () => closes,
	};
}

/** Drive one fresh provider call and wait for its background chain to settle. */
async function callProvider(options, { messages } = {}) {
	const sandbox = createSandbox();
	const sdk = recordingQuery();
	__test.setQueryFn(sdk.fn);
	try {
		const context = {
			messages: messages ?? [{ role: "user", content: "hi" }],
			tools: [],
		};
		const stream = __test.streamClaudeAgentSdk(model, context, { ...options, cwd: sandbox.cwd });
		return { sdk, stream, sandbox };
	} catch (error) {
		sandbox.cleanup();
		throw error;
	}
}

afterEach(() => {
	__test.setQueryFn(null);
	__test.resetSharedSession();
	resetCtx();
});

describe("onResponse", () => {
	it("fires once per provider call, with the synthetic 200 a subprocess has to report", async () => {
		const seen = [];
		const { sdk, sandbox } = await callProvider({
			onResponse: (response, forModel) => { seen.push({ response, forModel }); },
		});
		await sdk.done;
		sandbox.cleanup();

		assert.equal(seen.length, 1, "onResponse must fire exactly once for one provider call");
		// Claude Code is a subprocess: there is no status line or header set to pass
		// on, so we report what pi's own non-HTTP provider (providers/faux.js) reports.
		assert.deepEqual(seen[0].response, { status: 200, headers: {} });
		assert.equal(seen[0].forModel, model, "handlers are handed the model the call is for");
	});

	it("fires before the response body is consumed", async () => {
		const sandbox = createSandbox();
		const sdk = recordingQuery();
		__test.setQueryFn(sdk.fn);
		let iteratedAtCallTime = null;
		__test.streamClaudeAgentSdk(model, { messages: [{ role: "user", content: "hi" }], tools: [] }, {
			cwd: sandbox.cwd,
			onResponse: () => { iteratedAtCallTime = sdk.wasIterated(); },
		});
		await sdk.done;
		sandbox.cleanup();

		assert.equal(
			iteratedAtCallTime,
			false,
			"StreamOptions documents onResponse as running before the body stream is consumed; "
			+ "iterating the query is the first thing that can push to the pi stream",
		);
	});

	it("still fires when an onPayload handler deferred the query", async () => {
		const seen = [];
		const { sdk, sandbox } = await callProvider({
			onPayload: () => undefined,
			onResponse: (response) => { seen.push(response); },
		});
		await sdk.done;
		sandbox.cleanup();

		assert.deepEqual(seen, [{ status: 200, headers: {} }]);
	});
});

describe("onPayload", () => {
	it("is handed the assembled query options and this turn's prompt", async () => {
		const seen = [];
		const { sdk, sandbox } = await callProvider({
			onPayload: (payload, forModel) => { seen.push({ payload, forModel }); },
		});
		await sdk.done;
		sandbox.cleanup();

		assert.equal(seen.length, 1, "onPayload must fire exactly once for one provider call");
		assert.equal(seen[0].forModel, model);
		// The prompt as content blocks, not the parked generator the SDK is actually
		// given — a handler can read this one.
		assert.deepEqual(seen[0].payload.prompt, [{ type: "text", text: "hi" }]);
		const { options } = seen[0].payload;
		assert.equal(options.permissionMode, "bypassPermissions");
		assert.equal(options.includePartialMessages, true);
		assert.equal(options.cwd, sandbox.cwd);
		assert.equal(options.extraArgs.model, "claude-sonnet-4-6");
		assert.equal(
			sdk.calls[0].options,
			options,
			"an inspection-only handler must leave the exact options object the provider assembled",
		);
	});

	it("honours a replacement: a non-undefined return is what reaches query()", async () => {
		const { sdk, sandbox } = await callProvider({
			onPayload: (payload) => ({
				...payload,
				options: { ...payload.options, extraArgs: { ...payload.options.extraArgs, "replaced-by-handler": null } },
			}),
		});
		await sdk.done;
		sandbox.cleanup();

		assert.equal(sdk.calls.length, 1);
		assert.deepEqual(
			Object.keys(sdk.calls[0].options.extraArgs).sort(),
			["model", "replaced-by-handler", "strict-mcp-config"],
			"StreamOptions documents a non-undefined return as replacing the payload",
		);
	});

	it("leaves the call untouched when the handler returns undefined", async () => {
		let called = 0;
		const { sdk, sandbox } = await callProvider({ onPayload: () => { called += 1; return undefined; } });
		await sdk.done;
		sandbox.cleanup();

		assert.equal(called, 1, "the handler still has to run — undefined means unchanged, not unvisited");
		assert.deepEqual(Object.keys(sdk.calls[0].options.extraArgs).sort(), ["model", "strict-mcp-config"]);
	});

	// The prompt we pass is a parked generator this bridge writes steers and tool
	// results into for the rest of the turn. Honouring a replaced prompt would cut
	// Claude Code's stdin off from the tool-result queue — a deadlock, not an error —
	// so replacement is deliberately scoped to `options`.
	it("ignores a replaced prompt, keeping the live stream the tool-result queue writes to", async () => {
		let called = 0;
		const { sdk, sandbox } = await callProvider({
			onPayload: (payload) => { called += 1; return { ...payload, prompt: "a plain string" }; },
		});
		await sdk.done;
		sandbox.cleanup();

		assert.equal(called, 1);
		assert.notEqual(sdk.calls[0].prompt, "a plain string");
		assert.equal(typeof sdk.calls[0].prompt[Symbol.asyncIterator], "function");
	});

	it("fails the turn, rather than the process, when the handler returns a non-payload", async () => {
		const sandbox = createSandbox();
		const sdk = recordingQuery();
		__test.setQueryFn(sdk.fn);
		const events = [];
		const stream = __test.streamClaudeAgentSdk(model, { messages: [{ role: "user", content: "hi" }], tools: [] }, {
			cwd: sandbox.cwd,
			onPayload: () => "not a payload",
		});
		for await (const event of stream) events.push(event);
		sandbox.cleanup();

		assert.equal(sdk.calls.length, 0, "a malformed replacement must not be handed to query()");
		const errors = events.filter((e) => e.type === "error");
		assert.equal(errors.length, 1);
		assert.match(errors[0].error.errorMessage, /onPayload handler returned string/);
	});

	// The deferral is what buys payload replacement, and it is the one window in
	// which no abort listener exists yet. Losing an abort here would leave a Claude
	// Code subprocess running with nothing watching it.
	it("does not lose an abort that lands while the handler is being awaited", async () => {
		const controller = new AbortController();
		const { sdk, sandbox } = await callProvider({
			signal: controller.signal,
			onPayload: async () => {
				controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 1));
				return undefined;
			},
		});
		await sdk.done;
		sandbox.cleanup();

		assert.equal(sdk.calls.length, 1, "the query is still created, then torn down through the normal abort path");
		assert.ok(sdk.interrupts() >= 1, "an abort awaited through onPayload must still interrupt the query");
		assert.ok(sdk.closes() >= 1, "and still close it");
	});
});

describe("the no-handler path", () => {
	// The reentrancy check at the top of the provider reads `activeQuery`, which is
	// published on the line after query(). An await in front of that opens a window
	// where a concurrent call sees no active query and misclassifies itself as a fresh
	// top-level one — so the common path must stay synchronous.
	it("creates and publishes the query synchronously, before the provider returns", async () => {
		const sandbox = createSandbox();
		const sdk = recordingQuery();
		__test.setQueryFn(sdk.fn);
		const stream = __test.streamClaudeAgentSdk(model, { messages: [{ role: "user", content: "hi" }], tools: [] }, { cwd: sandbox.cwd });

		assert.equal(sdk.calls.length, 1, "query() must have been called before streamClaudeAgentSdk returned");
		assert.ok(stream, "and the stream is still returned synchronously");

		await sdk.done;
		sandbox.cleanup();
	});

	it("defers only for onPayload, not for onResponse", async () => {
		const sandbox = createSandbox();
		const sdk = recordingQuery();
		__test.setQueryFn(sdk.fn);
		__test.streamClaudeAgentSdk(model, { messages: [{ role: "user", content: "hi" }], tools: [] }, {
			cwd: sandbox.cwd,
			onResponse: () => {},
		});

		assert.equal(sdk.calls.length, 1, "onResponse runs after the query exists, so it must not defer creation");

		await sdk.done;
		sandbox.cleanup();
	});
});
