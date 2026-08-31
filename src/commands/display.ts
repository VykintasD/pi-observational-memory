import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DisplayMode } from "../config.js";
import type { Runtime } from "../runtime.js";

const MODES: DisplayMode[] = ["bar", "dense", "off"];

/**
 * `/om:display [bar|dense|off]` — session-scoped display mode switch (no file edit, no reload).
 * Bare `/om:display` shows the active mode (and the config value when overridden). Argument
 * completion supplies the three modes as a menu while typing.
 */
export function registerDisplayCommand(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerCommand("om:display", {
		description: "Set om display mode (/om:display bar|dense|off; bare shows current)",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = MODES.map((mode) => ({ value: mode, label: mode }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string, ctx: any) => {
			const requested = (args ?? "").trim().toLowerCase();
			if (!requested) {
				const current = runtime.effectiveDisplayMode;
				if (ctx.hasUI)
					ctx.ui.notify(
						`om display mode: ${current}${
							current !== runtime.config.displayMode ? ` (override; config: ${runtime.config.displayMode})` : ""
						} — /om:display bar|dense|off`,
						"info",
					);
				return;
			}
			if (!MODES.includes(requested as DisplayMode)) {
				if (ctx.hasUI) ctx.ui.notify(`unknown display mode "${requested}" — use bar, dense, or off`, "error");
				return;
			}
			runtime.setDisplayMode(requested as DisplayMode);
			if (ctx.hasUI)
				ctx.ui.notify(`om display mode: ${requested} (this session only — set displayMode in settings to persist)`, "info");
		},
	});
}
