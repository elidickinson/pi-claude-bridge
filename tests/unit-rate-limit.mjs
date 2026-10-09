/**
 * Claude Code's rate_limit_info → the Anthropic API's unified rate-limit headers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rateLimitResponse } from "../src/rate-limit.js";

describe("rateLimitResponse", () => {
	it("names each unified window with Claude Code's header abbreviation", () => {
		const { status, headers } = rateLimitResponse({
			status: "allowed",
			resetsAt: 1789770600,
			rateLimitType: "five_hour",
			unifiedWindows: {
				five_hour: { utilization: 0.14, resetsAt: 1789770600 },
				seven_day: { utilization: 0.01, resetsAt: 1790042400 },
				seven_day_overage_included: { utilization: 0.5, resetsAt: 1790042400 },
			},
		});

		assert.equal(status, 200);
		assert.deepEqual(headers, {
			"anthropic-ratelimit-unified-status": "allowed",
			"anthropic-ratelimit-unified-reset": "1789770600",
			"anthropic-ratelimit-unified-representative-claim": "five_hour",
			"anthropic-ratelimit-unified-5h-utilization": "0.14",
			"anthropic-ratelimit-unified-5h-reset": "1789770600",
			"anthropic-ratelimit-unified-7d-utilization": "0.01",
			"anthropic-ratelimit-unified-7d-reset": "1790042400",
			"anthropic-ratelimit-unified-7d_oi-utilization": "0.5",
			"anthropic-ratelimit-unified-7d_oi-reset": "1790042400",
		});
	});

	it("keeps a window name Claude Code has no abbreviation for", () => {
		const { headers } = rateLimitResponse({ status: "allowed", unifiedWindows: { seven_day_opus: { utilization: 0.3 } } });

		assert.equal(headers["anthropic-ratelimit-unified-seven_day_opus-utilization"], "0.3");
	});

	it("reports a rejection in the headers, not the status code", () => {
		const { status, headers } = rateLimitResponse({
			status: "rejected", rateLimitType: "five_hour", overageStatus: "rejected", overageResetsAt: 1790812800,
		});

		assert.equal(status, 200);
		assert.equal(headers["anthropic-ratelimit-unified-status"], "rejected");
		assert.equal(headers["anthropic-ratelimit-unified-overage-status"], "rejected");
		assert.equal(headers["anthropic-ratelimit-unified-overage-reset"], "1790812800");
	});
});
