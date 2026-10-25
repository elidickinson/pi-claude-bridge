/**
 * Consumer side of gentle-engram's local bridge ownership protocol. The
 * responder is only reachable over the Pi event bus, so these tests use a fake
 * in-memory bus and script the responder per test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
	claimEngramSession,
	createEngramOwnershipCache,
	ENGRAM_PLUGIN_IDS,
	ENGRAM_MCP_TOOL_PREFIXES,
} = await import("../src/engram-ownership.js");

const CLAIM = "engram:bridge:claim:v1";
const DECISION = "engram:bridge:decision:v1";

/** Fake bus. `responder(request, bus)` runs synchronously inside emit(CLAIM). */
function fakeBus(responder) {
	const handlers = new Map();
	const bus = {
		claims: [],
		emit(channel, data) {
			if (channel === CLAIM) bus.claims.push(data);
			for (const h of [...(handlers.get(channel) ?? [])]) h(data);
			if (channel === CLAIM) responder?.(data, bus);
		},
		on(channel, handler) {
			if (!handlers.has(channel)) handlers.set(channel, new Set());
			handlers.get(channel).add(handler);
			return () => handlers.get(channel).delete(handler);
		},
		listenerCount(channel) {
			return handlers.get(channel)?.size ?? 0;
		},
	};
	return bus;
}

const reply = (status, over = {}) => (req, bus) =>
	bus.emit(DECISION, { runtimeSessionId: req.runtimeSessionId, nonce: req.nonce, operation: req.operation, status, ...over });

describe("claimEngramSession", () => {
	it("emits a session-register claim and resolves owned", async () => {
		const bus = fakeBus(reply("owned"));
		assert.equal(await claimEngramSession(bus, "s1"), "owned");
		assert.equal(bus.claims.length, 1);
		assert.equal(bus.claims[0].runtimeSessionId, "s1");
		assert.equal(bus.claims[0].operation, "session-register");
		assert.ok(typeof bus.claims[0].nonce === "string" && bus.claims[0].nonce.trim() && bus.claims[0].nonce.length <= 256);
		assert.equal("promptDigest" in bus.claims[0], false);
	});

	it("resolves unknown on an unknown reply", async () => {
		assert.equal(await claimEngramSession(fakeBus(reply("unknown")), "s1"), "unknown");
	});

	it("resolves no-reply when nobody answers, distinct from unknown", async () => {
		assert.equal(await claimEngramSession(fakeBus(), "s1", { timeoutMs: 20 }), "no-reply");
	});

	it("uses a fresh nonce per query", async () => {
		const bus = fakeBus(reply("owned"));
		await claimEngramSession(bus, "s1");
		await claimEngramSession(bus, "s1");
		assert.notEqual(bus.claims[0].nonce, bus.claims[1].nonce);
	});

	it("ignores mismatched nonce/session/operation and invalid status, then accepts the real reply", async () => {
		const bus = fakeBus((req, b) => {
			const base = { runtimeSessionId: req.runtimeSessionId, nonce: req.nonce, operation: req.operation, status: "owned" };
			b.emit(DECISION, { ...base, nonce: req.nonce + "x" });
			b.emit(DECISION, { ...base, runtimeSessionId: "other" });
			b.emit(DECISION, { ...base, runtimeSessionId: " s1 " });
			b.emit(DECISION, { ...base, operation: "prompt-capture" });
			b.emit(DECISION, { ...base, status: "maybe" });
			b.emit(DECISION, { ...base, status: undefined });
			b.emit(DECISION, null);
			b.emit(DECISION, "garbage");
			setTimeout(() => b.emit(DECISION, { ...base, status: "unknown" }), 5);
		});
		assert.equal(await claimEngramSession(bus, "s1", { timeoutMs: 500 }), "unknown");
	});

	it("subscribes before emitting (synchronous responder works)", async () => {
		const bus = fakeBus(reply("owned"));
		assert.equal(await claimEngramSession(bus, "s1", { timeoutMs: 20 }), "owned");
	});

	it("unsubscribes after a reply", async () => {
		const bus = fakeBus(reply("owned"));
		await claimEngramSession(bus, "s1");
		assert.equal(bus.listenerCount(DECISION), 0);
	});

	it("unsubscribes after a timeout", async () => {
		const bus = fakeBus();
		await claimEngramSession(bus, "s1", { timeoutMs: 10 });
		assert.equal(bus.listenerCount(DECISION), 0);
	});

	it("resolves unknown without emitting for blank or non-string ids", async () => {
		const bus = fakeBus(reply("owned"));
		for (const id of ["", "   ", undefined, 42, null]) {
			assert.equal(await claimEngramSession(bus, id), "unknown");
		}
		assert.equal(bus.claims.length, 0);
	});

	it("resolves unknown when events is missing", async () => {
		assert.equal(await claimEngramSession(undefined, "s1"), "unknown");
	});

	it("resolves unknown (never throws) when emit or on throws", async () => {
		const badEmit = { on: () => () => {}, emit() { throw new Error("boom"); } };
		const badOn = { on() { throw new Error("boom"); }, emit() {} };
		assert.equal(await claimEngramSession(badEmit, "s1"), "unknown");
		assert.equal(await claimEngramSession(badOn, "s1"), "unknown");
	});

	it("unsubscribes when emit throws", async () => {
		const bus = fakeBus();
		const orig = bus.emit;
		bus.emit = () => { throw new Error("boom"); };
		assert.equal(await claimEngramSession(bus, "s1"), "unknown");
		assert.equal(bus.listenerCount(DECISION), 0);
		bus.emit = orig;
	});
});

describe("createEngramOwnershipCache", () => {
	it("memoizes owned", async () => {
		const bus = fakeBus(reply("owned"));
		const cache = createEngramOwnershipCache();
		assert.equal(await cache.get(bus, "s1"), "owned");
		assert.equal(await cache.get(bus, "s1"), "owned");
		assert.equal(bus.claims.length, 1);
	});

	it("memoizes no-reply so the timeout is not re-waited", async () => {
		const bus = fakeBus();
		const cache = createEngramOwnershipCache({ timeoutMs: 10 });
		assert.equal(await cache.get(bus, "s1"), "no-reply");
		assert.equal(await cache.get(bus, "s1"), "no-reply");
		assert.equal(bus.claims.length, 1);
	});

	it("does not memoize unknown", async () => {
		const bus = fakeBus(reply("unknown"));
		const cache = createEngramOwnershipCache();
		await cache.get(bus, "s1");
		await cache.get(bus, "s1");
		assert.equal(bus.claims.length, 2);
	});

	it("does not memoize unknown from a blank id", async () => {
		const bus = fakeBus(reply("owned"));
		const cache = createEngramOwnershipCache();
		assert.equal(await cache.get(bus, ""), "unknown");
		assert.equal(await cache.get(bus, "s1"), "owned");
	});

	it("keys by runtimeSessionId", async () => {
		const bus = fakeBus(reply("owned"));
		const cache = createEngramOwnershipCache();
		await cache.get(bus, "s1");
		await cache.get(bus, "s2");
		assert.equal(bus.claims.length, 2);
	});

	it("shares one in-flight query across concurrent gets", async () => {
		const bus = fakeBus((req, b) => setTimeout(() => reply("owned")(req, b), 5));
		const cache = createEngramOwnershipCache();
		const results = await Promise.all([cache.get(bus, "s1"), cache.get(bus, "s1"), cache.get(bus, "s1")]);
		assert.deepEqual(results, ["owned", "owned", "owned"]);
		assert.equal(bus.claims.length, 1);
	});

	it("reset clears memoized results", async () => {
		const bus = fakeBus(reply("owned"));
		const cache = createEngramOwnershipCache();
		await cache.get(bus, "s1");
		cache.reset();
		await cache.get(bus, "s1");
		assert.equal(bus.claims.length, 2);
	});
});

describe("Engram identifiers", () => {
	it("exports the plugin id and MCP tool prefixes", () => {
		assert.deepEqual(ENGRAM_PLUGIN_IDS, ["engram@engram"]);
		assert.deepEqual(ENGRAM_MCP_TOOL_PREFIXES, ["mcp__engram", "mcp__plugin_engram_engram"]);
	});
});
