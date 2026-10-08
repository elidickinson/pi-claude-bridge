// Content fingerprint for session reuse. The approach comes from PR #136
// (@sonSunnoi): compare prior content, not just the message count.
//
// This version hashes what convertPiMessages produces, so two histories get
// the same fingerprint only when a rebuild would write the same messages.
// Timestamps, usage and other metadata never reach that output.

import { createHash } from "node:crypto";
import type { Message as PiMessage } from "@earendil-works/pi-ai";
import { convertPiMessages } from "./convert.js";

export function fingerprintPriors(messages: PiMessage[], customToolNameToSdk?: Map<string, string>): string {
	const { anthropicMessages } = convertPiMessages(messages, customToolNameToSdk);
	return createHash("sha256").update(JSON.stringify(anthropicMessages)).digest("hex");
}
