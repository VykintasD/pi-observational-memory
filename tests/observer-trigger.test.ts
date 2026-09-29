import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULTS } from "../src/config.js";
import { evaluateObserverTriggers } from "../src/hooks/observer-trigger.js";
import { selectSourceSlice } from "../src/ledger/index.js";
import { spawnWorker, type WorkerExit } from "../src/spawn/launch.js";
import { writeObserverResult } from "../src/spawn/runs.js";
import { Runtime } from "../src/runtime.js";
import { rawMessage } from "./fixtures/session.js";

vi.mock("../src/spawn/launch.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/spawn/launch.js")>();
	return { ...actual, spawnWorker: vi.fn() };
});
vi.mock("../src/memory/paths.js", () => ({
	topicList: vi.fn(async () => []),
	journeyGet: vi.fn(async () => null),
}));

const spawnMock = vi.mocked(spawnWorker);

const CHUNK_TOKENS = 500;

/** Five ~100-token messages → one chunk when dispatched with a 500-token budget. */
function makeBranch(n: number) {
	return Array.from({ length: n }, (_, i) => rawMessage(`m${i}`, `msg ${i} ${"x".repeat(396)}`));
}

function makeRuntime(runsRoot: string): Runtime {
	const runtime = new Runtime();
	runtime.enabled = true;
	runtime.sessionId = "sess-rollback";
	runtime.config = { ...DEFAULTS, chunkTokens: CHUNK_TOKENS, observerConcurrency: 1 };
	// Keep hermetic: point the IPC root at a temp dir instead of the real global runs root.
	(runtime as { runsRoot: string }).runsRoot = runsRoot;
	return runtime;
}

function makeCtx(branch: ReturnType<typeof makeBranch>) {
	return {
		hasUI: false,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	} as never;
}

describe("observer watermark rollback", () => {
	let runsRoot: string;

	beforeEach(() => {
		spawnMock.mockReset();
		runsRoot = mkdtempSync(join(tmpdir(), "om-runs-"));
	});

	afterEach(() => {
		rmSync(runsRoot, { recursive: true, force: true });
	});

	it("clears the dispatched watermark when the worker fails, so the chunk is reselected next trigger", async () => {
		spawnMock.mockRejectedValue(new Error("spawn exploded"));
		const branch = makeBranch(5);
		const runtime = makeRuntime(runsRoot);

		evaluateObserverTriggers({ appendEntry: vi.fn() } as never, runtime, makeCtx(branch));

		await vi.waitFor(() => expect(runtime.observersInFlight.size).toBe(0));
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(runtime.dispatchedCoversUpToId).toBeUndefined();
		expect(runtime.lastWorkerError).toContain("spawn exploded");
		const failedSlice = selectSourceSlice(branch, undefined, CHUNK_TOKENS);
		expect(runtime.sliceFailures.get(failedSlice.coversUpToId!)).toEqual({
			attempts: 1,
			lastAttemptAt: expect.any(Number),
		});
	});

	it("does not re-dispatch a failed chunk until the 30 s retry cooldown has elapsed", async () => {
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		spawnMock.mockRejectedValue(new Error("spawn exploded"));
		const branch = makeBranch(5);
		const runtime = makeRuntime(runsRoot);

		evaluateObserverTriggers({ appendEntry: vi.fn() } as never, runtime, makeCtx(branch));
		await vi.waitFor(() => expect(runtime.observersInFlight.size).toBe(0));
		expect(spawnMock).toHaveBeenCalledTimes(1);

		// 29 s later: still inside the cooldown — the trigger must not dispatch again.
		nowSpy.mockReturnValue(1_000_000 + 29_000);
		evaluateObserverTriggers({ appendEntry: vi.fn() } as never, runtime, makeCtx(branch));
		await vi.waitFor(() => expect(runtime.observersInFlight.size).toBe(0));
		expect(spawnMock).toHaveBeenCalledTimes(1);

		// 31 s later: cooldown elapsed — the failed chunk is retried.
		nowSpy.mockReturnValue(1_000_000 + 31_000);
		evaluateObserverTriggers({ appendEntry: vi.fn() } as never, runtime, makeCtx(branch));
		await vi.waitFor(() => expect(runtime.observersInFlight.size).toBe(0));
		expect(spawnMock).toHaveBeenCalledTimes(2);
		nowSpy.mockRestore();
	});

	it("gives up after 3 failed attempts, advancing the watermark past the chunk", async () => {
		const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
		spawnMock.mockRejectedValue(new Error("spawn exploded"));
		const branch = makeBranch(5);
		const runtime = makeRuntime(runsRoot);
		const ui = { notify: vi.fn() };
		const ctx = {
			hasUI: true,
			ui,
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
		} as never;
		const failedSlice = selectSourceSlice(branch, undefined, CHUNK_TOKENS);

		// Attempt 1 and 2: the chunk is retried after each cooldown.
		for (let attempt = 1; attempt <= 2; attempt++) {
			nowSpy.mockReturnValue(1_000_000 + attempt * 31_000);
			evaluateObserverTriggers({ appendEntry: vi.fn() } as never, runtime, ctx);
			await vi.waitFor(() => expect(runtime.observersInFlight.size).toBe(0));
		}
		// Attempt 3: the final failure — give up and advance the marker past the chunk.
		nowSpy.mockReturnValue(1_000_000 + 3 * 31_000);
		evaluateObserverTriggers({ appendEntry: vi.fn() } as never, runtime, ctx);
		await vi.waitFor(() => expect(runtime.observersInFlight.size).toBe(0));

		expect(spawnMock).toHaveBeenCalledTimes(3);
		expect(runtime.sliceFailures.size).toBe(0);
		expect(runtime.dispatchedCoversUpToId).toBe(failedSlice.coversUpToId);
		expect(ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("gave up"),
			"warning",
		);

		// No further triggers re-dispatch the skipped chunk.
		nowSpy.mockReturnValue(1_000_000 + 4 * 31_000);
		evaluateObserverTriggers({ appendEntry: vi.fn() } as never, runtime, ctx);
		await vi.waitFor(() => expect(runtime.observersInFlight.size).toBe(0));
		expect(spawnMock).toHaveBeenCalledTimes(3);
		nowSpy.mockRestore();
	});

	it("keeps the dispatched watermark when the worker succeeds and commits observations", async () => {
		spawnMock.mockImplementation(async (opts: { cwd: string; env: Record<string, string | undefined> }): Promise<WorkerExit> => {
			const runId = opts.env.OM_RUN_ID as string;
			writeObserverResult(join(opts.cwd, `${runId}.result.json`), {
				observations: [{ timestamp: "2026-09-02 01:30", content: "User fixed the flaky test." }],
			});
			return { code: 0, signal: null, stderr: "" };
		});
		const branch = makeBranch(5);
		const runtime = makeRuntime(runsRoot);
		const appendEntry = vi.fn();

		evaluateObserverTriggers({ appendEntry } as never, runtime, makeCtx(branch));

		await vi.waitFor(() => expect(runtime.observersInFlight.size).toBe(0));
		const expectedCoversUpTo = selectSourceSlice(branch, undefined, CHUNK_TOKENS).coversUpToId;
		expect(runtime.dispatchedCoversUpToId).toBe(expectedCoversUpTo);
		expect(appendEntry).toHaveBeenCalledTimes(1);
		expect(runtime.sliceFailures.size).toBe(0);
	});

	it("rolls back when the worker exits 0 but writes no result file", async () => {
		spawnMock.mockResolvedValue({ code: 0, signal: null, stderr: "" });
		const branch = makeBranch(5);
		const runtime = makeRuntime(runsRoot);

		evaluateObserverTriggers({ appendEntry: vi.fn() } as never, runtime, makeCtx(branch));

		await vi.waitFor(() => expect(runtime.observersInFlight.size).toBe(0));
		expect(runtime.dispatchedCoversUpToId).toBeUndefined();
	});
});
