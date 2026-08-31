import { existsSync, readFileSync } from "node:fs";
import { forkCopy } from "./paths.js";

export interface SessionCtx {
	cwd: string;
	sessionManager: {
		getSessionId: () => string;
		getHeader?: () => { id?: string; cwd?: string; parentSession?: string } | null | undefined;
	};
}

/** Read a session file's header id (first JSONL line). Undefined on any parse/IO failure. */
function readSessionHeaderId(file: string): string | undefined {
	try {
		const firstLine = readFileSync(file, "utf-8").split("\n", 1)[0] ?? "";
		const header = JSON.parse(firstLine) as { id?: string } | undefined;
		return typeof header?.id === "string" ? header.id : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the parent session id for copy-on-fork: the header's `parentSession` lineage (set
 * on fork/clone) only while the parent's session file still exists on disk. The id comes from
 * the parent file's header — the immutable session-header UUID (survives /name, /resume,
 * /tree) — never the filename (which can diverge).
 */
export function parentSessionId(ctx: SessionCtx): string | undefined {
	const parentFile = ctx.sessionManager.getHeader?.()?.parentSession;
	if (!parentFile || !existsSync(parentFile)) return undefined;
	return readSessionHeaderId(parentFile);
}

/**
 * Copy-on-fork: seed a freshly forked/continued session's durable rows from its parent.
 * The copy is a one-time event enforced in the database (only an empty destination is copied
 * into), so this is safe to call on every session start, including resumes.
 */
export async function ensureSessionMemory(ctx: SessionCtx): Promise<void> {
	const parent = parentSessionId(ctx);
	if (!parent) return;
	await forkCopy(parent, ctx.sessionManager.getSessionId());
}
