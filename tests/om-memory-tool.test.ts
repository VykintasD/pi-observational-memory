import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerOmMemoryTool } from "../src/memory/om-memory-tool.js";
import { ensureOmDb } from "../src/memory/db.js";
import { journeySet, topicPut } from "../src/memory/paths.js";
import { Runtime } from "../src/runtime.js";

const SESSION = "sess-om-memory-tool";

describe("registerOmMemoryTool (master-side read-only om store access)", () => {
	let tmp: string;
	let tool: any;
	let runtime: Runtime;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), "om-memory-tool-"));
		process.env.OM_DB = join(tmp, "om.db");
		await ensureOmDb();
		runtime = new Runtime();
		const fakePi = { registerTool: (def: any) => (tool = def) } as any;
		registerOmMemoryTool(fakePi, runtime);
	});
	afterEach(() => {
		delete process.env.OM_DB;
		rmSync(tmp, { recursive: true, force: true });
	});

	const ctx = { sessionManager: { getSessionId: () => SESSION } } as any;
	const text = (res: { content: { text: string }[] }) => res.content[0].text;

	it("refuses politely while the /om gate is off", async () => {
		runtime.enabled = false;
		const res = await tool.execute("1", { action: "list" }, undefined, undefined, ctx);
		expect(text(res)).toMatch(/off/);
	});

	it("lists topics with slugs, titles, summaries, and update dates", async () => {
		runtime.enabled = true;
		await topicPut(SESSION, "auth", "Auth", "JWT-based auth", "body auth");
		await topicPut(SESSION, "db", "Database", "Postgres", "body db");
		const res = await tool.execute("1", { action: "list" }, undefined, undefined, ctx);
		const out = text(res);
		expect(out).toContain("- auth — Auth: JWT-based auth (updated ");
		expect(out).toContain("- db — Database: Postgres (updated ");
		expect(res.details.count).toBe(2);
	});

	it("gets a topic body by slug and reports missing slugs", async () => {
		runtime.enabled = true;
		await topicPut(SESSION, "auth", "Auth", "JWT", "we use JWT tokens with rotation");
		expect(text(await tool.execute("1", { action: "get", slug: "auth" }, undefined, undefined, ctx))).toBe(
			"we use JWT tokens with rotation",
		);
		expect(text(await tool.execute("1", { action: "get", slug: "nope" }, undefined, undefined, ctx))).toMatch(
			/not found/,
		);
		expect(text(await tool.execute("1", { action: "get" }, undefined, undefined, ctx))).toMatch(/Usage/);
	});

	it("the reserved JOURNEY slug reads the session journey", async () => {
		runtime.enabled = true;
		await journeySet(SESSION, "2026-08-31 — started the project");
		expect(text(await tool.execute("1", { action: "get", slug: "JOURNEY" }, undefined, undefined, ctx))).toBe(
			"2026-08-31 — started the project",
		);
		// Case-insensitive reserved slug; an empty session has no journey yet.
		const res = await tool.execute("2", { action: "get", slug: "journey" }, undefined, undefined, {
			sessionManager: { getSessionId: () => "empty-session" },
		} as any);
		expect(text(res)).toMatch(/No journey/);
	});

	it("searches with Go regexp and reports no matches", async () => {
		runtime.enabled = true;
		await topicPut(SESSION, "auth", "Auth", "JWT", "rotation happens on expiry");
		const hit = await tool.execute("1", { action: "search", pattern: "expir" }, undefined, undefined, ctx);
		expect(text(hit)).toContain("auth");
		const miss = await tool.execute("2", { action: "search", pattern: "zzz-no-match" }, undefined, undefined, ctx);
		expect(text(miss)).toMatch(/No matches/);
		expect(text(await tool.execute("3", { action: "search" }, undefined, undefined, ctx))).toMatch(/Usage/);
	});
});
