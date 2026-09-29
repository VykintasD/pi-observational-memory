import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { mergeFallbackObservations, parsePlainTextObservations } from "../agent/observer/fallback.js";
import { readObserverResult, writeObserverResult } from "../src/spawn/runs.js";

describe("parsePlainTextObservations", () => {
	it("parses timestamped lines into observations", () => {
		const text = [
			"2026-09-02 01:30: User fixed the flaky test in tests/ledger.test.ts.",
			"2026-09-02 01:31: User asked how to configure JWT auth middleware.",
		].join("\n");
		expect(parsePlainTextObservations(text)).toEqual([
			{ timestamp: "2026-09-02 01:30", content: "User fixed the flaky test in tests/ledger.test.ts." },
			{ timestamp: "2026-09-02 01:31", content: "User asked how to configure JWT auth middleware." },
		]);
	});

	it("parses the structural-anchor variants (bullet, brackets, or both)", () => {
		const text = [
			"- [2026-09-02 01:30]: User fixed the flaky test.",
			"- 2026-09-02 01:31: User asked a question.",
			"[2026-09-02 01:32]: Model answered.",
			"2026-09-02 01:33: Bare format still works.",
		].join("\n");
		expect(parsePlainTextObservations(text)).toEqual([
			{ timestamp: "2026-09-02 01:30", content: "User fixed the flaky test." },
			{ timestamp: "2026-09-02 01:31", content: "User asked a question." },
			{ timestamp: "2026-09-02 01:32", content: "Model answered." },
			{ timestamp: "2026-09-02 01:33", content: "Bare format still works." },
		]);
	});

	it("ignores the mandated CONFIRMATION marker line", () => {
		const text = [
			"2026-09-02 01:30: User fixed the flaky test.",
			"CONFIRMATION: Observation pass complete.",
		].join("\n");
		expect(parsePlainTextObservations(text)).toEqual([
			{ timestamp: "2026-09-02 01:30", content: "User fixed the flaky test." },
		]);
	});

	it("ignores prose that does not start with a timestamp (confirmation replies, continuation prose)", () => {
		const text = [
			"The chunk is fully covered as of 2026-09-02 01:31.",
			"Sure, here is how to configure JWT auth middleware:",
			"First, install the package: npm i jsonwebtoken.",
			"",
		].join("\n");
		expect(parsePlainTextObservations(text)).toEqual([]);
	});

	it("dedupes exact repeated lines (degenerate model repetition)", () => {
		const text = "2026-09-02 01:30: User fixed the flaky test.\n2026-09-02 01:30: User fixed the flaky test.\n2026-09-02 01:31: User asked a question.";
		expect(parsePlainTextObservations(text)).toEqual([
			{ timestamp: "2026-09-02 01:30", content: "User fixed the flaky test." },
			{ timestamp: "2026-09-02 01:31", content: "User asked a question." },
		]);
	});

	it("returns [] for empty or whitespace-only input", () => {
		expect(parsePlainTextObservations("")).toEqual([]);
		expect(parsePlainTextObservations("   \n  \n")).toEqual([]);
	});

	it("caps pathological runs at 500 observations", () => {
		const lines = Array.from({ length: 600 }, (_, i) => `2026-09-02 01:3${i % 10}: Observation number ${i}.`);
		expect(parsePlainTextObservations(lines.join("\n")).length).toBe(500);
	});
});

describe("mergeFallbackObservations", () => {
	let dir: string;
	let resultPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "om-fallback-"));
		resultPath = join(dir, "obs.result.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("creates the result file when the tool was never called", () => {
		const added = mergeFallbackObservations(resultPath, "2026-09-02 01:30: User fixed the flaky test.");
		expect(added).toBe(1);
		expect(readObserverResult(resultPath).observations).toEqual([
			{ timestamp: "2026-09-02 01:30", content: "User fixed the flaky test." },
		]);
	});

	it("merges only observations not already recorded by the tool call", () => {
		// Pre-existing result file from an earlier record_observations call.
		writeFileFirst(resultPath);
		const added = mergeFallbackObservations(
			resultPath,
			[
				"2026-09-02 01:30: User fixed the flaky test.", // duplicate of recorded
				"2026-09-02 01:31: User asked how to configure JWT auth.", // new
			].join("\n"),
		);
		expect(added).toBe(1);
		const observations = readObserverResult(resultPath).observations;
		expect(observations).toEqual([
			{ timestamp: "2026-09-02 01:30", content: "User fixed the flaky test." },
			{ timestamp: "2026-09-02 01:31", content: "User asked how to configure JWT auth." },
		]);
	});

	it("is a no-op when the text has no matching lines (normal tool-calling run)", () => {
		const added = mergeFallbackObservations(resultPath, "The chunk is fully covered as of 2026-09-02 01:31.");
		expect(added).toBe(0);
		expect(readObserverResult).toThrow(); // file was never created
	});
});

function writeFileFirst(path: string): void {
	writeObserverResult(path, {
		observations: [{ timestamp: "2026-09-02 01:30", content: "User fixed the flaky test." }],
	});
}
