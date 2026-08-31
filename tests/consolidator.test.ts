import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerConsolidatorTools } from "../agent/consolidator/tools.js";
import { buildWorkerEnv } from "../src/spawn/launch.js";
import { ensureOmDb } from "../src/memory/db.js";

describe("buildWorkerEnv(consolidator)", () => {
	it("sets role, run id, IPC paths, and the session key (no directory sandbox)", () => {
		const env = buildWorkerEnv("consolidator", {
			runsRoot: "/tmp/om-runs",
			runId: "c1",
			sessionId: "sess-1",
		});
		expect(env.OM_WORKER).toBe("consolidator");
		expect(env.OM_RUN_ID).toBe("c1");
		expect(env.OM_SESSION_ID).toBe("sess-1");
		expect(env.OM_RESULT_PATH).toBe("/tmp/om-runs/c1.result.json");
		expect(env.OM_MEMORY_DIR).toBeUndefined();
	});

	it("the observer env carries no session key", () => {
		const env = buildWorkerEnv("observer", { runsRoot: "/runs", runId: "r1" });
		expect(env.OM_WORKER).toBe("observer");
		expect(env.OM_SESSION_ID).toBeUndefined();
		expect(env.OM_MEMORY_DIR).toBeUndefined();
	});
});

describe("registerConsolidatorTools (slug-addressed om-store shims)", () => {
	let tmp: string;
	let tools: Map<string, any>;

	beforeEach(async () => {
		tmp = mkdtempSync(join(tmpdir(), "om-cons-tools-"));
		process.env.OM_DB = join(tmp, "om.db");
		await ensureOmDb();
		tools = new Map();
		const fakePi = { registerTool: (def: any) => tools.set(def.name, def) } as any;
		registerConsolidatorTools(fakePi, "sess-1");
	});
	afterEach(() => {
		delete process.env.OM_DB;
		rmSync(tmp, { recursive: true, force: true });
	});

	const text = (res: { content: { text: string }[] }) => res.content[0].text;

	it("registers the slug-addressed tool belt (no terminal report tool)", () => {
		expect([...tools.keys()].sort()).toEqual(["edit", "grep", "ls", "read", "write"]);
	});

	it("write then read a topic by slug", async () => {
		const res = await tools.get("write").execute("1", {
			slug: "auth",
			title: "Auth",
			summary: "JWT-based auth",
			content: "we use JWT tokens",
		});
		expect(text(res)).toContain("Wrote topic auth");
		const read = await tools.get("read").execute("2", { slug: "auth" });
		expect(text(read)).toBe("we use JWT tokens");
	});

	it("read of an unknown topic fails cleanly", async () => {
		const read = await tools.get("read").execute("1", { slug: "nope" });
		expect(text(read)).toContain("no such topic: nope");
	});

	it("the reserved JOURNEY slug addresses the journey", async () => {
		const w = await tools.get("write").execute("1", { slug: "JOURNEY", content: "## 2026-01-01\nStarted." });
		expect(text(w)).toContain("Wrote journey");
		const r = await tools.get("read").execute("2", { slug: "JOURNEY" });
		expect(text(r)).toBe("## 2026-01-01\nStarted.");
	});

	it("edit replaces an exact unique substring and rejects ambiguous matches", async () => {
		await tools.get("write").execute("1", { slug: "t", title: "T", summary: "s", content: "alpha beta alpha" });
		const ambiguous = await tools.get("edit").execute("2", { slug: "t", oldText: "alpha", newText: "X" });
		expect(text(ambiguous)).toContain("ambiguous");
		const ok = await tools.get("edit").execute("3", { slug: "t", oldText: "beta", newText: "BETA" });
		expect(text(ok)).toContain("Edited");
		expect(text(await tools.get("read").execute("4", { slug: "t" }))).toBe("alpha BETA alpha");
	});

	it("ls and grep operate over the store", async () => {
		await tools.get("write").execute("1", { slug: "auth", title: "Auth", summary: "JWT tokens", content: "uses JWT" });
		await tools.get("write").execute("2", { slug: "deploy", title: "Deploy", summary: "fly.io pipeline", content: "uses fly.io" });
		const ls = await tools.get("ls").execute("3", {});
		expect(text(ls).split("\n").sort()).toEqual(["auth — Auth (JWT tokens)", "deploy — Deploy (fly.io pipeline)"]);
		const grep = await tools.get("grep").execute("4", { pattern: "JWT" });
		expect(text(grep)).toContain("auth");
		expect(text(grep)).toContain("JWT");
	});
});
