// Child process for the SIGTERM test in tests/unit-fork-shutdown.mjs. Handles
// SIGTERM the way pi's print and rpc modes do: await the session_shutdown
// handlers, then exit 143. Prints the fork session id once its child is ready.
import { handlers, startForkWithChild } from "./fork-shutdown-setup.mjs";

process.on("SIGTERM", () => {
	void Promise.resolve(handlers.get("session_shutdown")?.()).finally(() => process.exit(143));
});
const { forkId } = await startForkWithChild(process.argv[2]);
process.stdout.write(JSON.stringify({ forkId }) + "\n");
