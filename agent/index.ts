/**
 * Shared worker agent extension (L4), loaded into a subprocess `pi` via `-e`. Branches on
 * the OM_WORKER env var (`observer` | `consolidator`).
 *
 * The worker is headless (`pi -p`): builtin tools are disabled (`--no-builtin-tools`), the
 * system prompt is fully replaced with the role prompt, and the role registers only the tools
 * it needs. Output is handed back to the orchestrator via the result file (see src/spawn/runs.ts).
 *
 * Chunk delivery: the orchestrator passes the conversation chunk as the `pi -p` prompt, so it
 * is recorded as a real user message. We deliberately do NOT inject it via the `context` hook
 * — that is non-destructive and never persists to the session, which would leave the chunk
 * invisible when inspecting/resuming the observer run and defeat the observability goal
 * (decision 11). The system prompt carries role + rules only.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trackWorkerCost } from "./cost.js";
import { CONSOLIDATOR_SYSTEM } from "./consolidator/prompt.js";
import { registerConsolidatorTools } from "./consolidator/tools.js";
import { OBSERVER_SYSTEM, OBSERVER_SYSTEM_PROSE } from "./observer/prompt.js";
import { mergeFallbackObservations } from "./observer/fallback.js";
import { registerObserverTool } from "./observer/tool.js";

/**
 * Extract the plain-text portion of an assistant message's content array.
 * The content is a union of text / thinking / tool-call parts; only `text`
 * parts are relevant to the fallback observation parser.
 */
function assistantText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } =>
			Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string")
		)
		.map((part) => part.text)
		.join("\n");
}

export default function omWorker(pi: ExtensionAPI): void {
	const role = process.env.OM_WORKER;
	const resultPath = process.env.OM_RESULT_PATH;

	// Shared across roles: pull pi's built-in cost and hand it back via the cost file.
	// Registered first so it writes the cost file before each role's agent_end shutdown.
	trackWorkerCost(pi);

	if (role === "observer") {
		if (!resultPath) throw new Error("OM_RESULT_PATH not set for observer worker");
		// Prose mode (small local models that cannot emit reliable native tool calls): no tool is
		// registered at all, so the model can ONLY emit observations as "YYYY-MM-DD HH:MM: <line>"
		// text lines, which the fallback parser below ingests as the PRIMARY path.
		const outputMode = process.env.OM_OUTPUT_MODE === "prose" ? ("prose" as const) : ("tool-calls" as const);
		if (outputMode === "tool-calls") registerObserverTool(pi, resultPath);

		pi.on("before_agent_start", async () => {
			return { systemPrompt: outputMode === "prose" ? OBSERVER_SYSTEM_PROSE : OBSERVER_SYSTEM };
		});

		// Fallback for models that fail to call record_observations: accumulate the
		// assistant's plain-text replies (all turns) and, at agent_end, recover any
		// "YYYY-MM-DD HH:MM: <content>" lines into the result file. No-op for normal
		// tool-calling runs (the confirmation sentence does not match the pattern).
		const assistantTexts: string[] = [];
		// Structural event type: the `message_end` payload carries the finished
		// message; we only need role + content, and staying structural keeps this
		// compatible across pi-coding-agent versions (the event type is not
		// exported from the package root in the pinned 0.74.x).
		pi.on("message_end", (event: unknown) => {
			const message = (event as { message?: { role?: string; content?: unknown } }).message;
			if (!message || message.role !== "assistant") return;
			const text = assistantText(message.content);
			if (text) assistantTexts.push(text);
		});

		// Headless `pi -p` exits when the agent loop ends; shutdown is a belt-and-suspenders.
		pi.on("agent_end", async (_event: unknown, ctx: { shutdown: () => void }) => {
			let merged = 0;
			try {
				merged = mergeFallbackObservations(resultPath, assistantTexts.join("\n"));
			} catch {
				// Never let the fallback break the worker's exit path.
			}
			if (outputMode === "prose" && merged === 0) {
				// Zero valid lines in prose mode = unparseable output. Failing the run (non-zero
				// exit) makes the orchestrator treat it as a failed chunk: watermark rolls back,
				// retry budget applies. The orchestrator enforces the same check on the result
			// file as a second line of defense; either one suffices to keep the watermark from
				// advancing over an empty observation set.
				process.stderr.write("om-observer: prose mode produced 0 valid observation lines; failing run\n");
				process.exit(1);
			}
			ctx.shutdown();
		});
		return;
	}

	if (role === "consolidator") {
		const sessionId = process.env.OM_SESSION_ID;
		if (!sessionId) throw new Error("OM_SESSION_ID not set for consolidator worker");
		// No result file: the consolidator's output is its om-store edits, and the orchestrator
		// tombstones the whole provided batch on clean exit (it knows what it handed over).
		registerConsolidatorTools(pi, sessionId);

		pi.on("before_agent_start", async () => {
			return { systemPrompt: CONSOLIDATOR_SYSTEM };
		});

		pi.on("agent_end", async (_event: unknown, ctx: { shutdown: () => void }) => {
			ctx.shutdown();
		});
		return;
	}
}
