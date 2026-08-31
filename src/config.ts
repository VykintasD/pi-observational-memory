import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConfiguredModel {
	provider: string;
	id: string;
	thinking?: ModelThinkingLevel;
}

export interface Config {
	/** Raw-history token size of one observation chunk (fixed boundary). */
	chunkTokens: number;
	/** Overlap between adjacent chunks; default 0 in v1. */
	chunkOverlapTokens: number;
	/** Target size of the active observation pool; the buffer drains back toward this after consolidation. */
	poolTargetTokens: number;
	/** Active-pool token count that triggers a consolidation (200% of target). */
	consolidateAtPoolTokens: number;
	/** Live context-window usage that triggers compaction. */
	compactAtContextTokens: number;
	/** Verbatim raw tail kept after the cutoff; snaps to a chunk boundary. */
	tailTokens: number;
	/**
	 * Target size of the session's JOURNEY (the running descriptive project history, a row in the
	 * om store), which the consolidator appends to and which is pushed into every compaction
	 * block. When it grows past this, the consolidator compresses its oldest entries (recent
	 * history stays detailed).
	 */
	journeyTargetTokens: number;
	/** Max simultaneous in-flight observer subprocesses. */
	observerConcurrency: number;
	models: {
		observer: ConfiguredModel;
		consolidator: ConfiguredModel;
	};
	/**
	 * Resume the agent automatically after a compaction that fired mid-run (a `turn_end` with
	 * pending tool work). A `turn_end` that is also the run's terminal turn never auto-resumes —
	 * it stops as if nothing happened. Default true.
	 */
	resumeAfterMidRunCompaction: boolean;
	/** Power-user setting: disable all triggers (distinct from the on/off gate). */
	passive: boolean;
	/** Emit the NDJSON debug log. */
	debugLog: boolean;
	/**
	 * Metadata (set by loadConfig, not a tunable): name of the active named profile, if any.
	 * Shown by /om status.
	 */
	activeProfile?: string;
}

export const DEFAULTS: Config = {
	chunkTokens: 10_000,
	chunkOverlapTokens: 0,
	poolTargetTokens: 10_000,
	consolidateAtPoolTokens: 15_000,
	compactAtContextTokens: 150_000,
	tailTokens: 20_000,
	journeyTargetTokens: 1_000,
	observerConcurrency: 4,
	resumeAfterMidRunCompaction: true,
	models: {
		observer: { provider: "openrouter", id: "z-ai/glm-5.3", thinking: "low" },
		consolidator: { provider: "openrouter", id: "z-ai/glm-5.3", thinking: "medium" },
	},
	passive: false,
	debugLog: false,
};

const THINKING_LEVEL_VALUES: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

const SETTINGS_KEY = "observational-memory";
const PASSIVE_ENV = "PI_OM_PASSIVE";

function positiveIntegerOrUndefined(value: unknown): number | undefined {
	return Number.isInteger(value) && typeof value === "number" && value > 0 ? value : undefined;
}

function isThinkingLevel(value: unknown): value is ModelThinkingLevel {
	return typeof value === "string" && (THINKING_LEVEL_VALUES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeModel(value: unknown, fallback: ConfiguredModel): ConfiguredModel {
	if (!isRecord(value)) return fallback;
	const provider = nonEmptyString(value.provider) ?? fallback.provider;
	const id = nonEmptyString(value.id) ?? fallback.id;
	const model: ConfiguredModel = { provider, id };
	const thinking = isThinkingLevel(value.thinking) ? value.thinking : fallback.thinking;
	if (thinking) model.thinking = thinking;
	return model;
}

/**
 * The normalized shape of one settings block: like Partial<Config> but with models allowed
 * to be present per-model (a block may set only `models.observer`).
 */
type NormalizedSettings = Omit<Partial<Config>, "models"> & { models?: Partial<Config["models"]> };

/** One parsed settings source (global or project file): the normalized overrides plus the
 * requested profile name (only when the profile actually exists). */
interface NamespacedSource {
	partial: Partial<Config>;
	profile?: string;
}

function normalizeSettingsConfig(value: Record<string, unknown>, base: Config): NormalizedSettings {
	const normalized: NormalizedSettings = {};
	const numberKeys = [
		"chunkTokens",
		"chunkOverlapTokens",
		"poolTargetTokens",
		"consolidateAtPoolTokens",
		"compactAtContextTokens",
		"tailTokens",
		"journeyTargetTokens",
		"observerConcurrency",
	] as const;
	for (const key of numberKeys) {
		const normalizedValue = positiveIntegerOrUndefined(value[key]);
		if (normalizedValue !== undefined) normalized[key] = normalizedValue;
	}
	// chunkOverlapTokens may legitimately be 0.
	if (value.chunkOverlapTokens === 0) normalized.chunkOverlapTokens = 0;
	if (typeof value.resumeAfterMidRunCompaction === "boolean")
		normalized.resumeAfterMidRunCompaction = value.resumeAfterMidRunCompaction;
	if (typeof value.passive === "boolean") normalized.passive = value.passive;
	if (typeof value.debugLog === "boolean") normalized.debugLog = value.debugLog;
	if (isRecord(value.models)) {
		const models: Partial<Config["models"]> = {};
		if (isRecord(value.models.observer)) models.observer = normalizeModel(value.models.observer, base.models.observer);
		if (isRecord(value.models.consolidator))
			models.consolidator = normalizeModel(value.models.consolidator, base.models.consolidator);
		if (models.observer || models.consolidator) normalized.models = models;
	}
	return normalized;
}

/**
 * Resolve one `observational-memory` settings block against `base`, with named-profile support.
 *
 * A block may name a profile (`"profile": "small-ctx"`) and define profiles as nested blocks:
 * ```json
 * "observational-memory": {
 *   "profile": "small-ctx",
 *   "profiles": {
 *     "small-ctx": {
 *       "chunkTokens": 4000, "tailTokens": 3000, "poolTargetTokens": 3000,
 *       "consolidateAtPoolTokens": 5000, "compactAtContextTokens": 18000
 *     }
 *   }
 * }
 * ```
 * Precedence inside one file: the profile's values first, then the block's direct keys —
 * so a single direct key overrides one knob of the active profile. Models merge per-model
 * across profile and direct keys. An unknown profile name is ignored (no overrides, no name
 * reported). Across files the usual order holds (defaults < global < project < env); a
 * profile in either file applies at that file's layer.
 */
export function resolveNamespacedBlock(nested: Record<string, unknown>, base: Config): NamespacedSource {
	const { profile: rawProfile, profiles: rawProfiles, ...direct } = nested;
	const profileBlock =
		typeof rawProfile === "string" && rawProfile.length > 0 && isRecord(rawProfiles) ? rawProfiles[rawProfile] : undefined;
	const profileNorm = isRecord(profileBlock) ? normalizeSettingsConfig(profileBlock, base) : {};
	const directNorm = normalizeSettingsConfig(direct, base);
	// NormalizedSettings allows per-model presence; only after filling in from base does the models
	// field become a complete Config["models"].
	const partial = { ...profileNorm, ...directNorm } as Partial<Config>;
	const models: Partial<Config["models"]> = { ...profileNorm.models, ...directNorm.models };
	if (models.observer || models.consolidator) partial.models = { ...base.models, ...models };
	return {
		partial,
		profile: isRecord(profileBlock) ? (rawProfile as string) : undefined,
	};
}

export function readEnvConfig(env: NodeJS.ProcessEnv = process.env): Partial<Config> {
	const rawPassive = env[PASSIVE_ENV];
	if (rawPassive === undefined) return {};
	const passive = rawPassive.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(passive)) return { passive: true };
	if (["0", "false", "no", "off"].includes(passive)) return { passive: false };
	return {};
}

function readNamespacedConfig(path: string, base: Config): NamespacedSource {
	if (!existsSync(path)) return { partial: {} };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		const nested = raw[SETTINGS_KEY];
		return isRecord(nested) ? resolveNamespacedBlock(nested, base) : { partial: {} };
	} catch {
		return { partial: {} };
	}
}

export function loadConfig(
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
	paths: { globalPath?: string; projectPath?: string } = {},
): Config {
	const globalPath = paths.globalPath ?? join(getAgentDir(), "settings.json");
	const projectPath = paths.projectPath ?? join(cwd, ".pi", "settings.json");
	const globalSource = readNamespacedConfig(globalPath, DEFAULTS);
	const projectSource = readNamespacedConfig(projectPath, DEFAULTS);
	const envConfig = readEnvConfig(env);
	const config: Config = {
		...DEFAULTS,
		...globalSource.partial,
		...projectSource.partial,
		...envConfig,
		models: {
			...DEFAULTS.models,
			...globalSource.partial.models,
			...projectSource.partial.models,
		},
	};
	const activeProfile = projectSource.profile ?? globalSource.profile;
	if (activeProfile !== undefined) config.activeProfile = activeProfile;
	return config;
}
