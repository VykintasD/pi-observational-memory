/**
 * Fallback plain-text parser for the observer worker.
 *
 * Small models (e.g. Phi-4-mini via a local llama-server) may fail to emit a
 * `record_observations` tool call and instead write the observations as plain
 * text in the assistant reply, one line each:
 *
 *     YYYY-MM-DD HH:MM: <single-line observation>
 *
 * This module recovers such observations from the assistant text and merges
 * them into the result file, so a zero-tool-call run still returns observations
 * instead of silently losing the chunk.
 *
 * The line pattern requires a leading timestamp and a colon, so the mandated
 * confirmation reply ("The chunk is fully covered as of …" /
 * "CONFIRMATION: Observation pass complete.") does NOT match and normal
 * tool-calling runs stay a no-op. Bullet/bullet-bracket prefixes are
 * tolerated (see LINE_PATTERN).
 */
import {
	readObserverResult,
	writeObserverResult,
	type RawObservation,
} from "../../src/spawn/runs.js";

/**
 * One plain-text observation line. Accepts both formats the small models
 * produce:
 *   "YYYY-MM-DD HH:MM: content"            (mandated prose format)
 *   "- [YYYY-MM-DD HH:MM]: content"        (structural-anchor variant)
 * The optional leading "- " bullet and brackets keep the parser robust when
 * a model adds markdown bullet syntax on its own. The mandated confirmation
 * line ("CONFIRMATION: ...") never matches: no timestamp prefix.
 */
const LINE_PATTERN = /^(?:-\s*)?\[?(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]?\s*:\s*(.+)$/;

/**
 * Safety cap against degenerate repetition loops (a small model repeating the
 * same line until it hits the output token budget). Dedup already collapses
 * exact repeats; the cap bounds a pathological run.
 */
const MAX_FALLBACK_OBSERVATIONS = 500;

/**
 * Parse plain-text assistant output into raw observations.
 * Returns [] when nothing matches (the normal tool-calling run case).
 */
export function parsePlainTextObservations(text: string): RawObservation[] {
	if (!text) return [];
	const out: RawObservation[] = [];
	const seen = new Set<string>();
	for (const rawLine of text.split(/\r?\n/)) {
		const m = LINE_PATTERN.exec(rawLine.trim());
		if (!m) continue;
		const content = m[2].trim();
		if (!content) continue;
		const key = `${m[1]}␞${content}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ timestamp: m[1], content });
		if (out.length >= MAX_FALLBACK_OBSERVATIONS) break;
	}
	return out;
}

/**
 * Recover observations that were written as plain text instead of a tool call.
 * Reads the current result file (missing → empty), merges the parsed
 * observations (deduped against what is already recorded), and rewrites the
 * file only when something new was added. Returns the number added.
 */
export function mergeFallbackObservations(resultPath: string, assistantText: string): number {
	const parsed = parsePlainTextObservations(assistantText);
	if (parsed.length === 0) return 0;

	let existing: RawObservation[] = [];
	try {
		existing = readObserverResult(resultPath).observations;
	} catch {
		// No result file yet — the tool was never called, which is exactly
		// the failure mode we are recovering from.
	}

	const seen = new Set(existing.map((o) => `${o.timestamp}␞${o.content}`));
	const merged = [...existing];
	let added = 0;
	for (const obs of parsed) {
		const key = `${obs.timestamp}␞${obs.content}`;
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(obs);
		added++;
	}
	if (added > 0) {
		writeObserverResult(resultPath, { observations: merged });
	}
	return added;
}
