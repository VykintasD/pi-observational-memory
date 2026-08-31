import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { OmError } from "./om-cli.js";
import { journeyGet, topicGet, topicList, topicSearch } from "./paths.js";
import type { Runtime } from "../runtime.js";

/**
 * Reserved slug for the session's journey row — same convention as the consolidator's tool
 * belt (agent/consolidator/tools.ts). `get JOURNEY` reads the journey.
 */
const JOURNEY_SLUG = "JOURNEY";

const OmMemorySchema = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("get"), Type.Literal("search")], {
		description:
			"list: index of all topics. get: full body of one topic (requires slug; 'JOURNEY' reads the session journey). search: regexp search across topics (requires pattern).",
	}),
	slug: Type.Optional(
		Type.String({ description: "Topic slug for 'get' (e.g. 'auth', or 'JOURNEY' for the journey)." }),
	),
	pattern: Type.Optional(
		Type.String({ description: "Go regexp (RE2) for 'search', matched against titles, summaries, and bodies." }),
	),
});

export type OmMemoryInput = Static<typeof OmMemorySchema>;

type OmMemoryDetails =
	| { action: "list"; count: number }
	| { action: "get"; slug: string }
	| { action: "search"; pattern: string }
	| undefined;

/**
 * The master-side read-only window into the durable om store. Registered once at extension
 * setup; self-gates per session (the /om gate), so it is inert in sessions with om off.
 * Writes happen only in the background consolidator — the main agent can only read.
 */
export function registerOmMemoryTool(pi: ExtensionAPI, runtime: Runtime): void {
	pi.registerTool<typeof OmMemorySchema, OmMemoryDetails>({
		name: "om_memory",
		label: "om memory",
		description:
			"Read the session's durable memory store. Actions: 'list' — topic index (slug, title, summary); " +
			"'get <slug>' — full body of one topic (the reserved slug 'JOURNEY' returns the session's running project history); " +
			"'search <pattern>' — Go regexp search across titles, summaries, and bodies. Read-only: memory is written by a background consolidator.",
		parameters: OmMemorySchema,
		async execute(_id: string, params: OmMemoryInput, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
			if (!runtime.enabled) {
				return text("om is off for this session (enable it with /om on).");
			}
			const sessionId = ctx.sessionManager.getSessionId();
			try {
				if (params.action === "list") {
					const topics = await topicList(sessionId);
					if (topics.length === 0) return text("No topics yet.");
					const lines = topics.map((t) => `- ${t.slug} — ${t.title}: ${t.summary} (updated ${t.updated})`);
					return { content: [block(lines.join("\n"))], details: { action: "list", count: topics.length } };
				}
				if (params.action === "get") {
					const slug = params.slug?.trim();
					if (!slug) return text("Usage: om_memory get <slug> (use 'list' to see slugs).");
					if (slug.toUpperCase() === JOURNEY_SLUG) {
						const journey = await journeyGet(sessionId);
						return journey
							? { content: [block(journey)], details: { action: "get", slug: JOURNEY_SLUG } }
							: text("No journey recorded yet.");
					}
					const body = await topicGet(sessionId, slug);
					return body
						? { content: [block(body)], details: { action: "get", slug } }
						: text(`Topic '${slug}' not found. Use 'list' to see available slugs or 'search' to find them.`);
				}
				// action === "search"
				const pattern = params.pattern?.trim();
				if (!pattern) return text("Usage: om_memory search <pattern> (Go regexp, e.g. 'auth.*jwt').");
				const out = await topicSearch(sessionId, pattern);
				return out
					? { content: [block(out)], details: { action: "search", pattern } }
					: text(`No matches for '${pattern}'.`);
			} catch (e) {
				if (e instanceof OmError) {
					return text(`om store error (exit ${e.code}): ${e.message}`);
				}
				throw e;
			}
		},
	});
}

function block(t: string): { type: "text"; text: string } {
	return { type: "text" as const, text: t };
}

function text(t: string): { content: { type: "text"; text: string }[]; details: undefined } {
	return { content: [block(t)], details: undefined };
}
