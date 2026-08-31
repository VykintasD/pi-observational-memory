import { describe, expect, it, vi } from "vitest";

import { fmtTokens, StatusController, type StatusUI } from "../src/ui/status-controller.js";

function fakeUI() {
	const status = new Map<string, string | undefined>();
	const widgets = new Map<string, string[] | undefined>();
	const ui: StatusUI = {
		setStatus: (key, text) => status.set(key, text),
		setWidget: (key, content) => {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, content);
		},
		// Strip color so assertions read the raw glyphs.
		theme: { fg: (_color, text) => text },
	};
	return {
		ui,
		footer: () => status.get("om"),
		widget: (key: string) => widgets.get(key),
	};
}

describe("StatusController footer gauges", () => {
	it("shows a bare footer until gauges are set", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		expect(footer()).toBe("om");
	});

	it("clearing gauges returns to the bare footer", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges({ nextValue: 1500, nextMax: 3000, poolValue: 5000, poolMax: 10_000, ctxValue: 10_000, ctxMax: 80_000 });
		sc.setGauges(undefined);
		expect(footer()).toBe("om");
	});
});

describe("StatusController dense display mode", () => {
	const gauges = { nextValue: 8400, nextMax: 15000, poolValue: 848, poolMax: 2000, ctxValue: 38000, ctxMax: 45000 };

	it("footer is a bare label; the permanent widget carries gauges with numbers", () => {
		const { ui, footer, widget } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui, "dense");
		sc.setGauges(gauges);
		expect(footer()).toBe("om");
		const lines = widget("om-detail");
		expect(lines).toBeDefined();
		expect(lines![0]).toContain("8.4k/15.0k");
		expect(lines![0]).toContain("848/2.0k");
		expect(lines![0]).toContain("38.0k/45.0k");
	});

	it("detail line merges partial updates (obs, topics, journey, cost, error)", () => {
		const { ui, widget } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui, "dense");
		sc.setGauges(gauges);
		sc.setDetails({ activeObs: 27 });
		sc.setDetails({ topicCount: 3, journeyTokens: 412, journeyTarget: 1000 });
		sc.setCost(0.0521, 5);
		sc.setDetails({ lastError: "observer blew up" });
		const line2 = widget("om-detail")![1];
		expect(line2).toContain("27 obs");
		expect(line2).toContain("3 topics");
		expect(line2).toContain("journey 412/1.0k");
		expect(line2).toContain("consolidator idle");
		expect(line2).toContain("$0.052 (5 runs)");
		expect(line2).toContain("✗ observer blew up");
	});

	it("worker indicators merge into line 1 and settle back to bare gauges", () => {
		vi.useFakeTimers();
		try {
			const { ui, widget } = fakeUI();
			const sc = new StatusController({ settleMs: 5000 });
			sc.attach(ui, "dense");
			sc.setGauges(gauges);
			sc.workerStart("observer", "r1");
			expect(widget("om-detail")![0]).toContain("[observer]");
			sc.workerDone("r1", 4);
			expect(widget("om-detail")![0]).toContain("✓ [observer] +4");
			vi.advanceTimersByTime(5100);
			// settled worker removed, but the PERMANENT widget keeps the gauges
			expect(widget("om-detail")![0]).not.toContain("[observer]");
			expect(widget("om-detail")![0]).toContain("848/2.0k");
		} finally {
			vi.useRealTimers();
		}
	});

	it("consolidator running state shows on the detail line", () => {
		const { ui, widget } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui, "dense");
		sc.setGauges(gauges);
		sc.workerStart("consolidator", "c1");
		expect(widget("om-detail")![1]).toContain("consolidator running");
	});

	it("off mode renders no footer and no widget", () => {
		const { ui, footer, widget } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui, "off");
		sc.setGauges(gauges);
		expect(footer()).toBeUndefined();
		expect(widget("om-detail")).toBeUndefined();
		expect(widget("om-workers")).toBeUndefined();
	});

	it("detach clears both widget keys and the footer", () => {
		const { ui, footer, widget } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui, "dense");
		sc.setGauges(gauges);
		sc.workerStart("observer", "r1");
		sc.detach();
		expect(footer()).toBeUndefined();
		expect(widget("om-detail")).toBeUndefined();
		expect(widget("om-workers")).toBeUndefined();
	});
});

describe("StatusController live display mode switching (/om display)", () => {
	const gauges = { nextValue: 8400, nextMax: 15000, poolValue: 848, poolMax: 2000, ctxValue: 38000, ctxMax: 45000 };

	it("bar → dense: footer becomes a bare label and the permanent widget appears", () => {
		const { ui, footer, widget } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui);
		sc.setGauges(gauges);
		sc.setDisplayMode("dense");
		expect(footer()).toBe("om");
		expect(widget("om-detail")![0]).toContain("848/2.0k");
		expect(widget("om-workers")).toBeUndefined();
	});

	it("dense → off tears down footer and widget; off → bar restores the gauged footer", () => {
		const { ui, footer, widget } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui, "dense");
		sc.setGauges(gauges);
		sc.setDisplayMode("off");
		expect(footer()).toBeUndefined();
		expect(widget("om-detail")).toBeUndefined();
		sc.setDisplayMode("bar");
		expect(footer()).toContain("O");
		expect(widget("om-detail")).toBeUndefined();
	});

	it("is a no-op when the mode is unchanged", () => {
		const { ui, footer } = fakeUI();
		const sc = new StatusController();
		sc.attach(ui, "dense");
		sc.setGauges(gauges);
		sc.setDisplayMode("dense");
		expect(footer()).toBe("om");
	});
});

describe("fmtTokens", () => {
	it("formats below and above 1k and 100k", () => {
		expect(fmtTokens(848)).toBe("848");
		expect(fmtTokens(8400)).toBe("8.4k");
		expect(fmtTokens(15000)).toBe("15.0k");
		expect(fmtTokens(900000)).toBe("900k");
	});
});
