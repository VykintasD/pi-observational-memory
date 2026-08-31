/**
 * The consolidator's tool belt. `--no-builtin-tools` is set on the worker, so this extension
 * registers its own read/write/edit/ls/grep — all slug-addressed shims over the om CLI. The
 * durable store is global SQLite keyed by the worker's session id (OM_SESSION_ID); there is no
 * directory sandbox — the CLI itself only touches THIS session's rows, so a wayward model
 * cannot read or clobber the user's project or any other session.
 *
 * There is no result file: the store edits ARE the output, and the run ends by natural exit
 * of `pi -p` once the model emits its closing confirmation. The orchestrator then tombstones
 * the whole provided batch (it already knows exactly what it handed over).
 *
 * "JOURNEY" is a reserved slug: read/write/edit on it address the session's journey instead of
 * a topic.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { OmError } from "../../src/memory/om-cli.js";
import { journeyGet, journeySet, topicGet, topicList, topicPut, topicSearch } from "../../src/memory/paths.js";

const JOURNEY_SLUG = "JOURNEY";

type ToolText = { content: { type: "text"; text: string }[]; details: unknown };

function ok(text: string, details: unknown = {}): ToolText {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(text: string): ToolText {
	return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: { error: true } };
}

class ToolFailure extends Error {}

/** Run an async store operation, mapping om CLI errors to tool failure text. */
async function guarded<T>(op: () => Promise<T>): Promise<T> {
	try {
		return await op();
	} catch (e) {
		if (e instanceof OmError) throw new ToolFailure(e.message);
		throw e;
	}
}

const LsSchema = Type.Object({});
const GrepSchema = Type.Object({
	pattern: Type.String({ description: "Regular expression (Go RE2 syntax; prefer simple literal or word patterns)." }),
});
const ReadSchema = Type.Object({
	slug: Type.String({ description: `Slug of the topic to read, or "${JOURNEY_SLUG}" for the journey.` }),
});
const WriteSchema = Type.Object({
	slug: Type.String({ description: `Slug of the topic to create/update, or "${JOURNEY_SLUG}" to rewrite the journey.` }),
	title: Type.Optional(Type.String({ description: "Short human title (topics only; defaults to the slug)." })),
	summary: Type.Optional(Type.String({ description: "One line, <= 140 chars — what this topic covers (topics only)." })),
	content: Type.String({ description: "Full body text (replaces the current body)." }),
});
const EditSchema = Type.Object({
	slug: Type.String({ description: `Slug of the topic to edit, or "${JOURNEY_SLUG}" for the journey.` }),
	oldText: Type.String({ description: "Exact text to replace (must occur exactly once)." }),
	newText: Type.String({ description: "Replacement text." }),
});

type LsInput = Static<typeof LsSchema>;
type GrepInput = Static<typeof GrepSchema>;
type ReadInput = Static<typeof ReadSchema>;
type WriteInput = Static<typeof WriteSchema>;
type EditInput = Static<typeof EditSchema>;

async function readBody(sessionId: string, slug: string): Promise<string | undefined> {
	if (slug === JOURNEY_SLUG) return journeyGet(sessionId);
	return topicGet(sessionId, slug);
}

async function writeBody(sessionId: string, slug: string, content: string, title?: string, summary?: string): Promise<void> {
	if (slug === JOURNEY_SLUG) {
		await journeySet(sessionId, content);
		return;
	}
	await topicPut(sessionId, slug, title ?? slug, summary ?? "", content);
}

/** Register the consolidator's slug-addressed memory tools (ls/grep/read/write/edit). */
export function registerConsolidatorTools(pi: ExtensionAPI, sessionId: string): void {
	pi.registerTool({
		name: "ls",
		label: "List memory topics",
		description: "List this session's durable topics (slug, title, summary).",
		parameters: LsSchema,
		async execute(_id: string, _params: LsInput): Promise<ToolText> {
			try {
				const topics = await guarded(() => topicList(sessionId));
				if (topics.length === 0) return ok("(empty)");
				return ok(topics.map((t) => `${t.slug} — ${t.title} (${t.summary})`).join("\n"));
			} catch (e) {
				return fail(e instanceof ToolFailure ? e.message : String(e));
			}
		},
	});

	pi.registerTool({
		name: "grep",
		label: "Search memory topics",
		description: "Regex-search topic titles/summaries/bodies; returns `slug<TAB>matching line`.",
		parameters: GrepSchema,
		async execute(_id: string, params: GrepInput): Promise<ToolText> {
			try {
				const out = await guarded(() => topicSearch(sessionId, params.pattern));
				return ok(out || "(no matches)");
			} catch (e) {
				return fail(e instanceof ToolFailure ? e.message : String(e));
			}
		},
	});

	pi.registerTool({
		name: "read",
		label: "Read memory topic",
		description: `Read a topic's body by slug (or "${JOURNEY_SLUG}" for the journey).`,
		parameters: ReadSchema,
		async execute(_id: string, params: ReadInput): Promise<ToolText> {
			try {
				const body = await guarded(() => readBody(sessionId, params.slug));
				if (body === undefined) {
					return fail(params.slug === JOURNEY_SLUG ? "no journey yet" : `no such topic: ${params.slug}`);
				}
				return ok(body);
			} catch (e) {
				return fail(e instanceof ToolFailure ? e.message : String(e));
			}
		},
	});

	pi.registerTool({
		name: "write",
		label: "Write memory topic",
		description: `Create or fully replace a topic (slug + title + summary + body), or rewrite the journey (slug "${JOURNEY_SLUG}").`,
		parameters: WriteSchema,
		async execute(_id: string, params: WriteInput): Promise<ToolText> {
			try {
				await guarded(() => writeBody(sessionId, params.slug, params.content, params.title, params.summary));
				return ok(
					params.slug === JOURNEY_SLUG
						? `Wrote journey (${params.content.length} chars).`
						: `Wrote topic ${params.slug} (${params.content.length} chars).`,
				);
			} catch (e) {
				return fail(e instanceof ToolFailure ? e.message : String(e));
			}
		},
	});

	pi.registerTool({
		name: "edit",
		label: "Edit memory topic",
		description: `Replace an exact substring in a topic's body (or the journey, slug "${JOURNEY_SLUG}").`,
		parameters: EditSchema,
		async execute(_id: string, params: EditInput): Promise<ToolText> {
			try {
				const current = await guarded(() => readBody(sessionId, params.slug));
				if (current === undefined) {
					return fail(params.slug === JOURNEY_SLUG ? "no journey yet" : `no such topic: ${params.slug}`);
				}
				const occurrences = current.split(params.oldText).length - 1;
				if (occurrences === 0) return fail("oldText not found");
				if (occurrences > 1) return fail(`oldText is ambiguous (${occurrences} matches); add more context`);
				await guarded(() => writeBody(sessionId, params.slug, current.replace(params.oldText, params.newText)));
				return ok(`Edited ${params.slug}.`);
			} catch (e) {
				return fail(e instanceof ToolFailure ? e.message : String(e));
			}
		},
	});
}
