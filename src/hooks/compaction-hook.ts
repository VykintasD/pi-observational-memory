import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderMemoryMap } from "../memory/index-render.js";
import { journeyGet, topicList } from "../memory/paths.js";
import type { Runtime } from "../runtime.js";
import { estimateEntryTokens } from "../tokens.js";
import {
	buildCompactionProjection,
	entryIndexById,
	isObservationsRecordedEntry,
	isSourceEntry,
	isValidCutPoint,
	rawTokensAfterIndex,
	renderSummary,
	type Entry,
} from "../ledger/index.js";

/** Distinct, branch-resolved coversUpToId indices of committed observation chunks, ascending. */
function chunkBoundaryIndices(branch: Entry[]): number[] {
	const indexes = entryIndexById(branch);
	const set = new Set<number>();
	for (const entry of branch) {
		if (!isObservationsRecordedEntry(entry)) continue;
		const idx = indexes.get(entry.data.coversUpToId);
		if (idx !== undefined) set.add(idx);
	}
	return Array.from(set).sort((a, b) => a - b);
}

/** First source entry after `boundaryIndex` that is a valid cut point, or undefined. */
function firstKeptAfterBoundary(branch: Entry[], boundaryIndex: number): Entry | undefined {
	for (let i = boundaryIndex + 1; i < branch.length; i++) {
		if (!isSourceEntry(branch[i])) continue;
		return isValidCutPoint(branch[i]) ? branch[i] : undefined;
	}
	return undefined;
}

/**
 * Snap pi's proposed `firstKeptEntryId` to a safe cutoff so the verbatim tail is as close to
 * `tailTokens` as possible.
 *
 * Two kinds of cutoff are considered:
 * 1. **Chunk boundaries** (committed `om.observations.recorded` coversUpToId): the tail starts
 *    exactly where an observed chunk ends — nothing before the cutoff is unsummarized, and
 *    nothing is both rendered into the summary and kept verbatim.
 * 2. **Sub-chunk cuts** inside the in-progress chunk (the source entries after the LAST
 *    committed boundary, which no observation covers yet). Without these, a large `chunkTokens`
 *    (set to save observer calls) forces the tail to a whole chunk even when `tailTokens` is
 *    smaller — the post-compaction floor then sits at or above the compaction trigger and
 *    re-fires every turn. The head of the in-progress chunk discarded by such a cut is not
 *    summarized *yet*: the observer's next committed chunk covers it and the projection folds
 *    it into the NEXT compaction's summary (the branch is never truncated, so coverage always
 *    resolves). The cut is therefore loss-free across the compaction cycle, at the cost of a
 *    brief gap where that segment is in neither the summary nor the verbatim tail.
 *
 * Among all candidates whose entry is a valid cut point, the one whose resulting tail is closest
 * to `tailTokens` wins; on a tie the chunk-boundary cut wins (no gap). Falls back to pi's
 * proposal when nothing qualifies (`tail` undefined).
 */
export function snapCutoff(
	branch: Entry[],
	proposedFirstKeptId: string,
	tailTokens: number,
): { firstKeptId: string; tail: number | undefined } {
	const boundaries = chunkBoundaryIndices(branch);

	// Suffix sums of estimated source tokens: tailOf(i) = estimated tokens of source entries
	// from index i to the tip — the verbatim tail if branch[i] were firstKept.
	const suffix = new Array<number>(branch.length + 1).fill(0);
	for (let i = branch.length - 1; i >= 0; i--) {
		suffix[i] = suffix[i + 1] + (isSourceEntry(branch[i]) ? estimateEntryTokens(branch[i]) : 0);
	}

	let bestId: string | undefined;
	let bestTail: number | undefined;
	let bestDelta = Number.POSITIVE_INFINITY;
	const consider = (entry: Entry, tail: number) => {
		const delta = Math.abs(tail - tailTokens);
		if (delta < bestDelta) {
			bestDelta = delta;
			bestId = entry.id;
			bestTail = tail;
		}
	};

	// 1. Chunk-boundary candidates. `tail` includes the firstKept entry itself, matching
	//    rawTokensAfterIndex(boundary) — entries between the boundary and firstKept are
	//    non-source (e.g. om.* custom entries) and contribute no tokens.
	for (const boundaryIndex of boundaries) {
		const firstKept = firstKeptAfterBoundary(branch, boundaryIndex);
		if (!firstKept) continue;
		consider(firstKept, suffix[boundaryIndex + 1]);
	}

	// 2. Sub-chunk candidates: valid cut points in the in-progress chunk (strictly after the
	//    last committed boundary). Scanned oldest-first so a tie keeps the earliest cut —
	//    discarding the least — and step 1 ran first so a true tie still prefers the boundary.
	//    Only when at least one boundary is committed: with none, the whole branch is the
	//    in-progress chunk and the old behavior (pi's proposal + waiting for the first
	//    observation to commit so it can be folded in) is deliberately preserved.
	if (boundaries.length > 0) {
		for (let i = boundaries[boundaries.length - 1] + 1; i < branch.length; i++) {
			const entry = branch[i];
			if (!isSourceEntry(entry) || !isValidCutPoint(entry)) continue;
			consider(entry, suffix[i]);
		}
	}

	return bestId ? { firstKeptId: bestId, tail: bestTail } : { firstKeptId: proposedFirstKeptId, tail: undefined };
}

export function snapFirstKeptEntryId(branch: Entry[], proposedFirstKeptId: string, tailTokens: number): string {
	return snapCutoff(branch, proposedFirstKeptId, tailTokens).firstKeptId;
}

/**
 * Fast-path test: can compaction skip waiting for in-flight observers entirely?
 *
 * The wait exists so just-committed observations are folded before rendering. But an observer
 * only affects the rendered block if its chunk's `coversUpToId` lands at-or-before the cutoff
 * (the projection includes an `om.observations.recorded` entry iff its coverage index is
 * `< index(firstKeptId)` — see `buildCompactionProjection`'s `beforeEntry` boundary). Observers
 * working a chunk in the verbatim tail are excluded regardless, so waiting for them is dead time.
 *
 * Two conditions must hold for a truly no-op skip (identical block AND identical cutoff):
 *  1. No in-flight observer has `coversUpToId` strictly before the cutoff entry (none can enter
 *     the projection). Unresolved ids are treated conservatively as "before" → wait.
 *  2. The snapped cutoff's tail is already `<= tailTokens`. Then committing the (tail-region)
 *     skipped observers can only produce SMALLER tails (further from target), so the snap is
 *     provably stable. If the tail is `> tailTokens` (nothing committed near the tip), a
 *     just-committed tail boundary could become a better snap target — so we wait, which also
 *     yields a tighter tail.
 */
export function canSkipObserverWait(
	branch: Entry[],
	snappedFirstKeptId: string,
	snappedTail: number | undefined,
	tailTokens: number,
	observersInFlight: Iterable<{ coversUpToId: string }>,
): boolean {
	// Condition 2: snap is only stable under skipped observers when its tail is already <= target.
	if (snappedTail === undefined || snappedTail > tailTokens) return false;

	const indexes = entryIndexById(branch);
	const cutoffIndex = indexes.get(snappedFirstKeptId);
	if (cutoffIndex === undefined) return false; // can't reason about the boundary → wait

	// Condition 1: every in-flight observer must cover a chunk that ends at-or-after the cutoff.
	for (const { coversUpToId } of observersInFlight) {
		const idx = indexes.get(coversUpToId);
		if (idx === undefined || idx < cutoffIndex) return false;
	}
	return true;
}

export function registerCompactionHook(pi: ExtensionAPI, runtime: Runtime): void {
	pi.on("session_before_compact", async (event: any, ctx: any) => {
		if (!runtime.enabled || runtime.config.passive) return undefined;

		const hasUI = ctx.hasUI;
		if (runtime.compactHookInFlight) {
			if (hasUI) ctx.ui.notify("om: another compaction is already in progress; cancelling duplicate", "warning");
			return { cancel: true };
		}

		runtime.compactHookInFlight = true;
		try {
			runtime.ensureConfig(ctx.cwd);
			const tailTokens = runtime.config.tailTokens;
			const { firstKeptEntryId, tokensBefore } = event.preparation;

			// Compute the snap from the CURRENT (pre-wait) branch. The snap only reads committed
			// chunk boundaries (fixed at hook entry), so this is safe to do before any wait and lets
			// us decide whether the wait is needed at all.
			let branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
			let snap = snapCutoff(branch, firstKeptEntryId, tailTokens);

			// R5 fast path: skip the wait when no in-flight observer can affect this compaction
			// (its chunk lands in the verbatim tail and the snap is stable). Otherwise wait for
			// observers to settle, then re-read the branch and recompute the snap so just-committed
			// `om.observations.recorded` entries are folded (pi's `event.branchEntries` is stale).
			const skip = canSkipObserverWait(branch, snap.firstKeptId, snap.tail, tailTokens, runtime.observersInFlight.values());
			runtime.lastCompactionObserverWait = skip ? "skipped" : "waited";
			if (!skip) {
				if (hasUI) ctx.ui.notify("om: waiting for in-flight observers before folding…", "info");
				await runtime.whenObserversIdle();
				branch = (ctx.sessionManager?.getBranch?.() as Entry[] | undefined) ?? (event.branchEntries as Entry[]);
				snap = snapCutoff(branch, firstKeptEntryId, tailTokens);
			}

			const snapped = snap.firstKeptId;
			const projection = buildCompactionProjection(branch, snapped);
			// Phase B: render the long-term tier live from disk, regenerated each compaction
			// (throwaway projections — cannot decay). The journey is the running descriptive history
			// the consolidator maintains; the map is the topic-file index.
			const journey = await journeyGet(runtime.sessionId);
			const map = renderMemoryMap(await topicList(runtime.sessionId));
			const summary = renderSummary(journey, map, projection.observations);

			return {
				compaction: {
					summary,
					firstKeptEntryId: snapped,
					tokensBefore,
					details: projection.details,
				},
			};
		} finally {
			runtime.compactHookInFlight = false;
		}
	});
}
