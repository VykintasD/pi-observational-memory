import { homedir } from "node:os";
import { join } from "node:path";
import { omRun } from "./om-cli.js";

/**
 * Global om database path: OM_DB env override > ~/.pi/agent/om/om.db.
 * The Go CLI resolves the same order, so the TS side never needs to pass --db.
 */
export function omDbPath(): string {
	return process.env.OM_DB ?? join(homedir(), ".pi", "agent", "om", "om.db");
}

/** Global directory for transient worker IPC (result/cost files): ~/.pi/agent/om/runs. */
export function omRunsRoot(): string {
	return join(homedir(), ".pi", "agent", "om", "runs");
}

/** Create the om database if missing (idempotent; safe on every session start). */
export async function ensureOmDb(): Promise<void> {
	await omRun(["init"]);
}
