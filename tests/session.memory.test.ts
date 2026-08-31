import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureOmDb } from "../src/memory/db.js";
import { topicGet, topicList, topicPut } from "../src/memory/paths.js";
import { ensureSessionMemory, parentSessionId, type SessionCtx } from "../src/memory/session.js";

/**
 * Copy-on-fork seeding: a forked session's durable rows are seeded from its parent once.
 * The parent is discovered via the header's parentSession lineage; the parent id is the
 * immutable id in the parent session file's header (first JSONL line), not the filename.
 */
describe("copy-on-fork session seeding", () => {
	let tmp: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "om-session-"));
		process.env.OM_DB = join(tmp, "om.db");
	});
	afterEach(() => {
		delete process.env.OM_DB;
		rmSync(tmp, { recursive: true, force: true });
	});

	/** Write a fake pi session file whose header carries the given id. */
	function sessionFile(name: string, id: string): string {
		const file = join(tmp, name);
		writeFileSync(file, `${JSON.stringify({ type: "header", id })}\n`);
		return file;
	}

	function ctx(sessionId: string, parentFile?: string): SessionCtx {
		return {
			cwd: tmp,
			sessionManager: {
				getSessionId: () => sessionId,
				getHeader: () => ({ id: sessionId, cwd: tmp, ...(parentFile ? { parentSession: parentFile } : {}) }),
			},
		};
	}

	it("parentSessionId reads the parent file's header id, not the filename", () => {
		const file = sessionFile("2026-08-31T10-00-00Z_wrong-name.jsonl", "parent-uuid-1");
		expect(parentSessionId(ctx("child", file))).toBe("parent-uuid-1");
	});

	it("parentSessionId is undefined without a parent or when the file is gone", () => {
		expect(parentSessionId(ctx("child"))).toBeUndefined();
		expect(parentSessionId(ctx("child", join(tmp, "missing.jsonl")))).toBeUndefined();
	});

	it("does nothing when there is no parent", async () => {
		await ensureOmDb();
		await ensureSessionMemory(ctx("child"));
		expect(await topicList("child")).toEqual([]);
	});

	it("seeds the child's rows from the parent once", async () => {
		await ensureOmDb();
		await topicPut("parent-uuid-1", "auth", "Auth", "s", "body");
		const parentFile = sessionFile("2026-08-31T10-00-00Z_p.jsonl", "parent-uuid-1");

		await ensureSessionMemory(ctx("child-uuid", parentFile));
		expect(await topicGet("child-uuid", "auth")).toBe("body");

		// Re-running (resume) never re-seeds: the copy is a one-time event in the database.
		await topicPut("parent-uuid-1", "auth", "Auth", "s", "changed");
		await ensureSessionMemory(ctx("child-uuid", parentFile));
		expect(await topicGet("child-uuid", "auth")).toBe("body");
	});
});
