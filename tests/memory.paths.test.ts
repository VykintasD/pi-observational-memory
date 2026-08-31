import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureOmDb } from "../src/memory/db.js";
import {
	forkCopy,
	journeyGet,
	journeySet,
	topicDelete,
	topicGet,
	topicList,
	topicPut,
	topicSearch,
} from "../src/memory/paths.js";

/**
 * Durable-tier accessors, tested end-to-end against the real cli/om binary. The database is
 * pointed at a temp file via OM_DB (the CLI resolves OM_DB > ~/.pi/agent/om/om.db).
 */
describe("om accessors (real cli/om binary, temp OM_DB)", () => {
	let tmp: string;
	let db: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "om-paths-"));
		db = join(tmp, "om.db");
		process.env.OM_DB = db;
	});
	afterEach(() => {
		delete process.env.OM_DB;
		rmSync(tmp, { recursive: true, force: true });
	});

	it("ensureOmDb creates the database file", async () => {
		await ensureOmDb();
		expect(existsSync(db)).toBe(true);
	});

	it("topic put/list/get round-trip; list is slug-sorted JSON", async () => {
		await ensureOmDb();
		await topicPut("sess-a", "b-topic", "B Topic", "covers b", "body b");
		await topicPut("sess-a", "a-topic", "A Topic", "covers a", "body a");
		const topics = await topicList("sess-a");
		expect(topics.map((t) => t.slug)).toEqual(["a-topic", "b-topic"]);
		expect(topics[0]).toMatchObject({ slug: "a-topic", title: "A Topic", summary: "covers a" });
		expect(await topicGet("sess-a", "a-topic")).toBe("body a");
	});

	it("topicGet returns undefined for an unknown slug", async () => {
		await ensureOmDb();
		expect(await topicGet("sess-a", "nope")).toBeUndefined();
	});

	it("topicSearch returns slug+line hits and '' on no match", async () => {
		await ensureOmDb();
		await topicPut("sess-a", "auth", "Auth", "JWT tokens", "we use JWT for auth");
		const out = await topicSearch("sess-a", "JWT");
		expect(out).toContain("auth");
		expect(out).toContain("JWT");
		expect(await topicSearch("sess-a", "zzz-no-match")).toBe("");
	});

	it("journey set/get round-trip; absent journey is undefined", async () => {
		await ensureOmDb();
		expect(await journeyGet("sess-a")).toBeUndefined();
		await journeySet("sess-a", "## 2026-01-01\nStarted the project.");
		expect(await journeyGet("sess-a")).toBe("## 2026-01-01\nStarted the project.");
	});

	it("topicDelete removes the slug (no-op when absent)", async () => {
		await ensureOmDb();
		await topicPut("sess-a", "auth", "Auth", "s", "body");
		await topicDelete("sess-a", "auth");
		expect(await topicGet("sess-a", "auth")).toBeUndefined();
		await expect(topicDelete("sess-a", "auth")).resolves.toBeUndefined();
	});

	it("forkCopy seeds the child once; later copies are skipped", async () => {
		await ensureOmDb();
		await topicPut("parent", "auth", "Auth", "s", "body");
		await journeySet("parent", "## 2026-01-01\nStarted.");

		await forkCopy("parent", "child");
		expect(await topicGet("child", "auth")).toBe("body");
		expect(await journeyGet("child")).toBe("## 2026-01-01\nStarted.");

		// The child now has rows: further copies are skipped, so parent updates do not leak in.
		await topicPut("parent", "auth", "Auth", "s", "changed");
		await forkCopy("parent", "child");
		expect(await topicGet("child", "auth")).toBe("body");
	});

	it("forkCopy from an empty parent is a harmless no-op", async () => {
		await ensureOmDb();
		await expect(forkCopy("empty-parent", "child")).resolves.toBeUndefined();
		expect(await topicList("child")).toEqual([]);
	});
});
