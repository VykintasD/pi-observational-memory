/**
 * TUI observability for observational memory, driven entirely by the in-process orchestrator
 * (subprocess workers are headless). Display modes (config `displayMode`):
 *
 *   - "bar" (default): footer gauge bars `O▕██░▏ C▕▏ X▕▏ $cost` plus the transient
 *     "om-workers" widget line, shown only while workers run/settle:
 *       ◐ [observer]   ◐ [observer]   ✓ [observer] +4
 *   - "dense": footer keeps a plain "om" label; a PERMANENT 2-line widget above the
 *     editor carries the gauges WITH numbers plus a detail line. Worker indicators
 *     merge into line 1 (no separate workers widget).
 *       O▕██░░░░░░▏ 8.4k/15.0k  C▕██░░░░░░▏ 848/2.0k  X▕████░░░░▏ 38.0k/45.0k  ◐ [observer]
 *       27 obs · 3 topics · journey 412/1.0k · consolidator idle · $0.052 (5 runs)
 *   - "off": no footer, no widget.
 *
 *   Toasts via notify (start/finish/error) always fire, gated on hasUI by the caller.
 */

import type { DisplayMode } from "../config.js";

export type { DisplayMode };

export type WorkerType = "observer" | "consolidator";

/** Live token gauges shown in the footer / dense widget, right of "○ om". */
export interface FooterGauges {
	/** Raw tokens accrued toward the next observer chunk. */
	nextValue: number;
	nextMax: number;
	/** Active pool tokens accrued toward the consolidation threshold. */
	poolValue: number;
	poolMax: number;
	/** Live context-window tokens toward the compaction threshold. */
	ctxValue: number;
	ctxMax: number;
}

/**
 * Facts for the dense widget's detail line. Arrives in partial updates: the runtime pushes
 * what it knows synchronously (activeObs) at gauge-refresh time, and the store facts
 * (topicCount, journeyTokens) come back from CLI spawns via setDetails merges.
 */
export interface GaugeDetails {
	/** Number of active (unconsolidated) observations in the pool. */
	activeObs?: number;
	/** Number of durable topics in the om store (session + global). */
	topicCount?: number;
	/** Current journey-row token estimate, or null when not yet fetched. */
	journeyTokens?: number | null;
	/** Journey target size (config), for the "412/1.0k" display. */
	journeyTarget?: number;
	/** Last worker error (caller-truncated), or undefined when none. */
	lastError?: string;
}

interface Theme {
	fg(color: string, text: string): string;
}

export interface StatusUI {
	setStatus(key: string, text: string | undefined): void;
	setWidget(key: string, content: string[] | undefined): void;
	theme: Theme;
}

type WorkerState =
	| { kind: "running" }
	| { kind: "done"; delta?: number }
	| { kind: "error" };

const FOOTER_KEY = "om";
const WORKERS_WIDGET_KEY = "om-workers";
const DENSE_WIDGET_KEY = "om-detail";
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
/** Separator between worker indicators on the single combined line. */
const WORKER_SEP = "   ";

export interface StatusControllerOptions {
	spinnerIntervalMs?: number;
	settleMs?: number;
}

interface WorkerEntry {
	type: WorkerType;
	state: WorkerState;
	settleTimer?: ReturnType<typeof setTimeout>;
}

/** Human-friendly token count: 848 → "848", 8400 → "8.4k", 900000 → "900k". */
export function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	return `${k >= 100 ? String(Math.round(k)) : k.toFixed(1)}k`;
}

export class StatusController {
	private ui: StatusUI | undefined;
	private displayMode: DisplayMode = "bar";
	private frame = 0;
	private readonly workers = new Map<string, WorkerEntry>();
	private spinnerTimer: ReturnType<typeof setInterval> | undefined;
	private gauges: FooterGauges | undefined;
	private cost: { costUsd: number; runs: number } | undefined;
	private details: GaugeDetails | undefined;
	private readonly spinnerIntervalMs: number;
	private readonly settleMs: number;

	constructor(options: StatusControllerOptions = {}) {
		this.spinnerIntervalMs = options.spinnerIntervalMs ?? 120;
		this.settleMs = options.settleMs ?? 5000;
	}

	attach(ui: StatusUI, displayMode: DisplayMode = "bar"): void {
		this.ui = ui;
		this.displayMode = displayMode;
		if (this.displayMode === "off") return;
		this.ui.setStatus(FOOTER_KEY, this.renderFooter());
		if (this.displayMode === "dense") this.renderWidget();
	}

	detach(): void {
		this.stopSpinner();
		for (const entry of this.workers.values()) {
			if (entry.settleTimer) clearTimeout(entry.settleTimer);
		}
		this.workers.clear();
		this.gauges = undefined;
		this.cost = undefined;
		this.details = undefined;
		this.ui?.setWidget(WORKERS_WIDGET_KEY, undefined);
		this.ui?.setWidget(DENSE_WIDGET_KEY, undefined);
		if (this.ui) this.ui.setStatus(FOOTER_KEY, undefined);
		this.ui = undefined;
	}

	/** Update (or clear) the live gauges and re-render the surfaces in place. */
	setGauges(gauges: FooterGauges | undefined): void {
		this.gauges = gauges;
		this.renderSurfaces();
	}

	/** Update the accumulated session cost and re-render in place. */
	setCost(costUsd: number, runs: number): void {
		this.cost = { costUsd, runs };
		this.renderSurfaces();
	}

	/** Merge a partial details update (any subset of GaugeDetails) and re-render in place. */
	setDetails(partial: GaugeDetails): void {
		this.details = { ...this.details, ...partial };
		this.renderSurfaces();
	}

	/**
	 * Switch display mode live (via `/om display`) without re-attaching: "off" tears down
	 * footer + widget; switching to bar/dense re-renders whatever the new mode owns and
	 * resumes the spinner if a worker is running. A no-op when the mode is unchanged.
	 */
	setDisplayMode(mode: DisplayMode): void {
		if (mode === this.displayMode) return;
		this.displayMode = mode;
		if (mode === "off") {
			this.stopSpinner();
			this.ui?.setWidget(DENSE_WIDGET_KEY, undefined);
			this.ui?.setWidget(WORKERS_WIDGET_KEY, undefined);
			this.ui?.setStatus(FOOTER_KEY, undefined);
			return;
		}
		if (!this.ui) return;
		this.ui.setStatus(FOOTER_KEY, this.renderFooter());
		this.renderWidget();
		if (this.hasRunningWorker()) this.startSpinner();
	}

	workerStart(type: WorkerType, runId: string): void {
		if (!this.ui) return;
		const existing = this.workers.get(runId);
		if (existing?.settleTimer) clearTimeout(existing.settleTimer);
		this.workers.set(runId, { type, state: { kind: "running" } });
		this.startSpinner();
		this.renderSurfaces();
	}

	workerDone(runId: string, delta?: number): void {
		this.settle(runId, { kind: "done", delta });
	}

	workerError(runId: string): void {
		this.settle(runId, { kind: "error" });
	}

	private settle(runId: string, state: WorkerState): void {
		if (!this.ui) return;
		const entry = this.workers.get(runId);
		if (!entry) return;
		if (entry.settleTimer) clearTimeout(entry.settleTimer);
		entry.state = state;
		this.renderSurfaces();
		entry.settleTimer = setTimeout(() => {
			this.workers.delete(runId);
			// Re-render with this worker removed (in dense mode the widget persists
			// with just the gauges once the last worker settles).
			this.renderSurfaces();
			if (!this.hasRunningWorker()) this.stopSpinner();
		}, this.settleMs);
		entry.settleTimer.unref?.();
		if (!this.hasRunningWorker()) this.stopSpinner();
	}

	private hasRunningWorker(type?: WorkerType): boolean {
		for (const entry of this.workers.values()) {
			if (entry.state.kind === "running" && (!type || entry.type === type)) return true;
		}
		return false;
	}

	private startSpinner(): void {
		if (this.spinnerTimer || this.displayMode === "off") return;
		this.spinnerTimer = setInterval(() => {
			this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
			// One re-render per tick covers all running workers (and, in dense mode,
			// the whole 2-line widget).
			if (this.hasRunningWorker()) this.renderSurfaces();
		}, this.spinnerIntervalMs);
		this.spinnerTimer.unref?.();
	}

	private stopSpinner(): void {
		if (!this.spinnerTimer) return;
		clearInterval(this.spinnerTimer);
		this.spinnerTimer = undefined;
	}

	/** Re-render whatever surfaces the active display mode owns (footer always; widget per mode). */
	private renderSurfaces(): void {
		if (!this.ui) return;
		if (this.displayMode === "off") return;
		this.ui.setStatus(FOOTER_KEY, this.renderFooter());
		this.renderWidget();
	}

	/** A compact colored fill bar, e.g. `▕████░░░░▏`. Filled cells use `over` (an alert color) past max. */
	private gaugeBar(value: number, max: number, cells = 8): string {
		const theme = this.ui!.theme;
		const frac = max <= 0 ? 0 : Math.max(0, value / max);
		const filled = Math.min(cells, Math.round(Math.min(1, frac) * cells));
		const fillColor = frac >= 1 ? "warning" : "dim";
		return (
			theme.fg(fillColor, "▕") +
			theme.fg(fillColor, "█".repeat(filled)) +
			theme.fg(fillColor, "░".repeat(cells - filled)) +
			theme.fg(fillColor, "▏")
		);
	}

	/** One gauge segment: `O` + bar (+ ` value/max` in dense mode). */
	private gaugeSegment(label: string, value: number, max: number, withNumbers: boolean): string {
		const theme = this.ui!.theme;
		const base = `${theme.fg("muted", label)}${this.gaugeBar(value, max)}`;
		return withNumbers ? `${base} ${fmtTokens(value)}/${fmtTokens(max)}` : base;
	}

	private renderFooter(): string {
		const theme = this.ui?.theme;
		if (!theme) return "om";
		if (this.displayMode === "dense") return theme.fg("success", "om");
		const g = this.gauges;
		if (!g) return theme.fg("success", "om");
		const next = this.gaugeSegment("O", g.nextValue, g.nextMax, false);
		const pool = this.gaugeSegment("C", g.poolValue, g.poolMax, false);
		const ctx = this.gaugeSegment("X", g.ctxValue, g.ctxMax, false);
		const cost = this.cost ? ` ${theme.fg("dim", `$${this.cost.costUsd.toFixed(3)}`)}` : "";
		return `${next}  ${pool}  ${ctx}${cost}`;
	}

	/**
	 * Worker indicator parts, shared by the bar-mode workers widget and the dense widget's
	 * line 1: `◐ [observer]` / `✓ [observer] +4` / `✗ [consolidator]`.
	 */
	private workerParts(): string[] {
		const theme = this.ui!.theme;
		const parts: string[] = [];
		for (const entry of this.workers.values()) {
			if (entry.state.kind === "running") {
				parts.push(`${theme.fg("accent", SPINNER_FRAMES[this.frame])} ${theme.fg("accent", `[${entry.type}]`)}`);
			} else if (entry.state.kind === "error") {
				parts.push(`${theme.fg("error", "✗")} ${theme.fg("muted", `[${entry.type}]`)}`);
			} else {
				const delta =
					entry.state.delta && entry.state.delta > 0
						? ` ${theme.fg("success", `+${entry.state.delta}`)}`
						: "";
				parts.push(`${theme.fg("success", "✓")} ${theme.fg("muted", `[${entry.type}]`)}${delta}`);
			}
		}
		return parts;
	}

	/**
	 * The mode-owned widget surface:
	 *  - bar: transient "om-workers" line, cleared when no workers remain.
	 *  - dense: PERMANENT "om-detail" 2-line widget — line 1 gauges with numbers plus
	 *    inline worker indicators, line 2 the detail line.
	 */
	private renderWidget(): void {
		const ui = this.ui;
		if (!ui) return;
		const theme = ui.theme;

		if (this.displayMode === "bar") {
			if (this.workers.size === 0) {
				ui.setWidget(WORKERS_WIDGET_KEY, undefined);
				return;
			}
			ui.setWidget(WORKERS_WIDGET_KEY, [this.workerParts().join(WORKER_SEP)]);
			return;
		}

		// dense
		const g = this.gauges;
		const line1: string[] = [];
		if (g) {
			line1.push(this.gaugeSegment("O", g.nextValue, g.nextMax, true));
			line1.push(this.gaugeSegment("C", g.poolValue, g.poolMax, true));
			line1.push(this.gaugeSegment("X", g.ctxValue, g.ctxMax, true));
		} else {
			line1.push(theme.fg("success", "om"));
		}
		const workers = this.workerParts();
		if (workers.length > 0) line1.push(workers.join(WORKER_SEP));

		const line2: string[] = [];
		const d = this.details;
		if (d?.activeObs !== undefined) line2.push(theme.fg("muted", `${d.activeObs} obs`));
		if (d?.topicCount !== undefined) line2.push(theme.fg("muted", `${d.topicCount} topics`));
		if (d?.journeyTokens != null && d.journeyTarget)
			line2.push(
				theme.fg("muted", `journey ${fmtTokens(d.journeyTokens)}/${fmtTokens(d.journeyTarget)}`),
			);
		line2.push(
			theme.fg("muted", `consolidator ${this.hasRunningWorker("consolidator") ? "running" : "idle"}`),
		);
		if (this.cost) line2.push(theme.fg("dim", `$${this.cost.costUsd.toFixed(3)} (${this.cost.runs} runs)`));
		if (d?.lastError) line2.push(theme.fg("error", `✗ ${d.lastError}`));

		const lines = [line1.join("  ")];
		if (line2.length > 0) lines.push(line2.join(" · "));
		ui.setWidget(DENSE_WIDGET_KEY, lines);
	}
}
