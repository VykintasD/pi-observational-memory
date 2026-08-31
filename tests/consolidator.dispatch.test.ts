import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { evaluateConsolidatorTrigger } from "../src/hooks/consolidator-trigger.js";
import { spawnWorker } from "../src/spawn/launch.js";
import { Runtime } from "../src/runtime.js";
import { observation, observationsRecordedEntry } from "./fixtures/session.js";

vi.mock("../src/spawn/launch.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/spawn/launch.js")>();
	return { ...actual, spawnWorker: vi.fn() };
});
vi.mock("../src/memory/paths.js", () => ({
	topicList: vi.fn(async () => []),
	journeyGet: vi.fn(async () => null),
}));

const spawnMock = vi.mocked(spawnWorker);

function makeRuntime(sessionId: string): Runtime {
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.sessionId = sessionId;
	// Tiny thresholds so a handful of observations crosses the consolidation clock.
	runtime.config = { ...DEFAULTS, poolTargetTokens: 50, consolidateAtPoolTokens: 100 };
	return runtime;
}

function makeBranch(obsCount: number) {
	const observations = Array.from({ length: obsCount }, (_, i) => observation(`t${i}`, { tokenCount: 60 }));
	return [observationsRecordedEntry("e1", { observations, coversUpToId: "src1" })];
}

const ctx = { hasUI: false, sessionManager: { getBranch: () => [], getEntries: () => [] } };
const pi = { appendEntry: vi.fn() };

describe("consolidator dispatch env (regression: OM_SESSION_ID must reach the worker)", () => {
	beforeEach(() => {
		spawnMock.mockClear();
	});

	it("passes the runtime session id as OM_SESSION_ID", async () => {
		spawnMock.mockResolvedValue({ code: 0, signal: null, stderr: "" } as never);
		const branch = makeBranch(3);
		const runtime = makeRuntime("sess-42");
		evaluateConsolidatorTrigger(pi as never, runtime, { ...ctx, sessionManager: { getBranch: () => branch, getEntries: () => branch } } as never);

		await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
		const { env } = spawnMock.mock.calls[0][0];
		expect(env.OM_SESSION_ID).toBe("sess-42");
		expect(env.OM_WORKER).toBe("consolidator");
	});

	it("skips locally (no spawn) when the session id is empty and records the error", async () => {
		const branch = makeBranch(3);
		const runtime = makeRuntime("");
		evaluateConsolidatorTrigger(pi as never, runtime, { ...ctx, sessionManager: { getBranch: () => branch, getEntries: () => branch } } as never);

		expect(runtime.lastWorkerError).toContain("no session id");
		expect(spawnMock).not.toHaveBeenCalled();
		expect(runtime.consolidatorInFlight).toBe(false);
	});
});
