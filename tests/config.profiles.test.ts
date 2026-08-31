import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULTS, loadConfig, resolveNamespacedBlock } from "../src/config.js";

describe("resolveNamespacedBlock (named profiles)", () => {
	it("applies the named profile's values", () => {
		const { partial, profile } = resolveNamespacedBlock(
			{
				profile: "small",
				profiles: { small: { chunkTokens: 4000, tailTokens: 3000 } },
			},
			DEFAULTS,
		);
		expect(profile).toBe("small");
		expect(partial.chunkTokens).toBe(4000);
		expect(partial.tailTokens).toBe(3000);
	});

	it("direct keys override single knobs of the active profile", () => {
		const { partial } = resolveNamespacedBlock(
			{
				profile: "small",
				profiles: { small: { chunkTokens: 4000, tailTokens: 3000 } },
				tailTokens: 4500,
			},
			DEFAULTS,
		);
		expect(partial.chunkTokens).toBe(4000);
		expect(partial.tailTokens).toBe(4500);
	});

	it("models merge per-model across profile and direct keys", () => {
		const { partial } = resolveNamespacedBlock(
			{
				profile: "p",
				profiles: { p: { models: { observer: { provider: "google", id: "gemini" } } } },
				models: { consolidator: { provider: "openrouter", id: "glm" } },
			},
			DEFAULTS,
		);
		// Profile's observer kept, direct's consolidator kept; unset model fields (thinking) inherit from base.
		expect(partial.models?.observer).toEqual({ provider: "google", id: "gemini", thinking: "low" });
		expect(partial.models?.consolidator).toEqual({ provider: "openrouter", id: "glm", thinking: "medium" });
	});

	it("an unknown profile name is ignored (no overrides, no name)", () => {
		const { partial, profile } = resolveNamespacedBlock(
			{
				profile: "typo",
				profiles: { small: { chunkTokens: 4000 } },
				tailTokens: 3000,
			},
			DEFAULTS,
		);
		expect(profile).toBeUndefined();
		expect(partial.chunkTokens).toBeUndefined();
		expect(partial.tailTokens).toBe(3000);
	});

	it("profile keys are not themselves knobs", () => {
		const { partial } = resolveNamespacedBlock({ profile: "p", profiles: { p: { chunkTokens: 4000 } } }, DEFAULTS);
		expect(Object.keys(partial).sort()).toEqual(["chunkTokens"]);
	});
});

describe("loadConfig (profile across settings files)", () => {
	let tmp: string;
	let globalPath: string;
	let projectPath: string;

	function writeGlobal(obj: unknown): void {
		writeFileSync(globalPath, JSON.stringify(obj, null, 2));
	}
	function writeProject(obj: unknown): void {
		mkdirSync(join(tmp, ".pi"), { recursive: true });
		writeFileSync(projectPath, JSON.stringify(obj, null, 2));
	}

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "om-config-"));
		globalPath = join(tmp, "global-settings.json");
		projectPath = join(tmp, ".pi", "settings.json");
	});
	afterEach(() => rmSync(tmp, { recursive: true, force: true }));

	it("defaults when no settings files exist", () => {
		const config = loadConfig(tmp, {}, { globalPath, projectPath });
		expect(config.chunkTokens).toBe(DEFAULTS.chunkTokens);
		expect(config.activeProfile).toBeUndefined();
	});

	it("global profile applies; project direct key overrides one knob", () => {
		writeGlobal({
			"observational-memory": {
				profile: "small",
				profiles: { small: { chunkTokens: 4000, tailTokens: 3000, poolTargetTokens: 3000 } },
			},
		});
		writeProject({ "observational-memory": { tailTokens: 4500 } });
		const config = loadConfig(tmp, {}, { globalPath, projectPath });
		expect(config.chunkTokens).toBe(4000);
		expect(config.poolTargetTokens).toBe(3000);
		expect(config.tailTokens).toBe(4500);
		expect(config.activeProfile).toBe("small");
	});

	it("a project profile wins over a global profile for the same knob and the reported name", () => {
		writeGlobal({
			"observational-memory": { profile: "a", profiles: { a: { chunkTokens: 111 } } },
		});
		writeProject({
			"observational-memory": { profile: "b", profiles: { b: { chunkTokens: 222, tailTokens: 333 } } },
		});
		const config = loadConfig(tmp, {}, { globalPath, projectPath });
		expect(config.chunkTokens).toBe(222);
		expect(config.tailTokens).toBe(333);
		expect(config.activeProfile).toBe("b");
	});

	it("env still wins over everything", () => {
		writeGlobal({
			"observational-memory": { profile: "small", profiles: { small: { passive: true } } },
		});
		const config = loadConfig(tmp, { PI_OM_PASSIVE: "0" } as NodeJS.ProcessEnv, { globalPath, projectPath });
		expect(config.passive).toBe(false);
	});

	it("invalid JSON file is skipped (defaults stand)", () => {
		writeGlobal("{ not json");
		const config = loadConfig(tmp, {}, { globalPath, projectPath });
		expect(config.chunkTokens).toBe(DEFAULTS.chunkTokens);
		expect(config.activeProfile).toBeUndefined();
	});
});
