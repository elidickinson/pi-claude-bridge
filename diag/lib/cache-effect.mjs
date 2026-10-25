/** Assess whether normalized request changes are limited to the mutation target. */
export function assessMutationAttribution(name, diffs, invariants = {}, { targetObserved: observedOverride } = {}) {
	const shapePath = /^messages\[\d+\]\.content\[\d+\]\.content$/;
	const keyPath = /^messages\[\d+\]\.content\[\d+\]$/;
	const targetKinds = {
		"tool-result-content-shape": (diff) => diff.kind === "type-or-shape" && shapePath.test(diff.path ?? ""),
		"tool-result-key-order": (diff) => diff.kind === "key-order" && keyPath.test(diff.path ?? ""),
		"drop-context-attachments": (diff) => ["missing-array-item", "missing-element"].includes(diff.kind),
	};
	const isTarget = targetKinds[name];
	if (!isTarget) throw new Error(`unknown session mutation: ${name}`);
	const sideEffects = diffs.filter((diff) => !isTarget(diff));
	const targetDiffObserved = diffs.some(isTarget);
	const targetObserved = observedOverride ?? targetDiffObserved;
	const reasons = [];
	if (!targetObserved) reasons.push("target-wire-change-not-observed");
	else if (!targetDiffObserved) reasons.push("target-diff-not-aligned");
	const checks = {
		modelSame: "model-mismatch", toolsSame: "tools-mismatch", thinkingSame: "thinking-mismatch",
		normalizedSystemSame: "normalized-system-changed", controlHistoryComplete: "control-history-incomplete",
		changedHistoryComplete: "changed-history-incomplete", resumeSessionSame: "resume-session-mismatch",
	};
	for (const [key, reason] of Object.entries(checks)) if (invariants[key] === false) reasons.push(reason);
	if (sideEffects.length) reasons.push("normalized-history-changes-outside-target");
	return {
		status: !targetObserved ? "not-attributed-no-target-wire-change" : reasons.length ? "confounded" : "valid",
		targetObserved,
		reasons,
		sideEffects,
	};
}

/** Compare measured read loss only against the prefix length actually cached by the seed. */
export function compareCacheUsage(control, changed, targetObserved, { validityIssues = [] } = {}) {
	const rawReadDifference = control.cacheRead === null || changed.cacheRead === null ? null : control.cacheRead - changed.cacheRead;
	const expectedPrefix = control.expected ?? changed.expected ?? null;
	const expectedMismatch = control.expected !== null && changed.expected !== null && control.expected !== changed.expected;
	const readLoss = rawReadDifference === null || expectedPrefix === null ? null
		: Math.min(control.cacheRead, expectedPrefix) - Math.min(changed.cacheRead, expectedPrefix);
	const writeIncrease = control.cacheWrite === null || changed.cacheWrite === null ? null : changed.cacheWrite - control.cacheWrite;
	const controlCoversExpectedPrefix = expectedPrefix !== null && control.cacheRead !== null && control.cacheRead >= expectedPrefix;
	let status;
	if (!targetObserved) status = "not-attributed-no-target-wire-change";
	else if (expectedPrefix === null || readLoss === null) status = "inconclusive-usage-missing";
	else if (expectedMismatch) status = "inconclusive-expected-prefix-mismatch";
	else if (!controlCoversExpectedPrefix) status = "inconclusive-control-prefix-incomplete";
	else if (validityIssues.length) status = "confounded";
	else if (readLoss > 0) status = "measured-cache-read-loss";
	else if (readLoss < 0) status = "changed-arm-read-more";
	else status = "no-cache-read-change";
	return { status, expectedPrefix, controlCoversExpectedPrefix, rawReadDifference, readLoss, writeIncrease, validityIssues };
}
