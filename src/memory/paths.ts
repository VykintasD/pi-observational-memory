import { omRun, OmError } from "./om-cli.js";

/** A topic row as listed by `om topics list` (JSON). */
export interface Topic {
	slug: string;
	title: string;
	summary: string;
	updated: string;
}

/**
 * Durable-tier accessors, backed by the om CLI (global SQLite, one row per session id).
 * The CLI resolves the database from OM_DB > ~/.pi/agent/om/om.db, so accessors are keyed
 * by sessionId alone. Exit-code conventions from the CLI: 1 = usage or search no-match
 * (normal "empty" result), 2 = db error, 3 = not found.
 */

function emptyToUndefined(s: string): string | undefined {
	const t = s.trim();
	return t.length > 0 ? t : undefined;
}

/** The session's JOURNEY body; undefined when absent or empty. */
export async function journeyGet(sessionId: string): Promise<string | undefined> {
	const out = await omRun(["journey", "get", sessionId]);
	return emptyToUndefined(out);
}

/** Replace the session's JOURNEY body; an empty string clears it. */
export async function journeySet(sessionId: string, body: string): Promise<void> {
	await omRun(["journey", "set", sessionId], body);
}

/** All topics of the session, sorted by slug. */
export async function topicList(sessionId: string): Promise<Topic[]> {
	const out = (await omRun(["topics", "list", sessionId])).trim();
	if (!out) return [];
	return JSON.parse(out) as Topic[];
}

/** The topic body (frontmatter excluded); undefined when the slug does not exist. */
export async function topicGet(sessionId: string, slug: string): Promise<string | undefined> {
	try {
		const out = await omRun(["topic", "get", sessionId, slug]);
		return emptyToUndefined(out);
	} catch (e) {
		if (e instanceof OmError && e.code === 3) return undefined;
		throw e;
	}
}

/** Create or update a topic by slug (title/summary in the index, body via stdin). */
export async function topicPut(sessionId: string, slug: string, title: string, summary: string, body: string): Promise<void> {
	await omRun(["topic", "put", sessionId, slug, "--title", title, "--summary", summary], body);
}

/** Delete a topic; no-op when the slug does not exist. */
export async function topicDelete(sessionId: string, slug: string): Promise<void> {
	await omRun(["topic", "del", sessionId, slug]);
}

/**
 * Regex search (Go regexp) across topic titles, summaries, and bodies.
 * Returns lines of `slug<TAB>matching line` (capped at 200); "" when there are no matches.
 */
export async function topicSearch(sessionId: string, pattern: string): Promise<string> {
	try {
		return await omRun(["topic", "search", sessionId, pattern]);
	} catch (e) {
		if (e instanceof OmError && e.code === 1) return "";
		throw e;
	}
}

/**
 * Copy-on-fork: copy the parent session's rows into the child session.
 * No-op when the child already has any rows (forking is a one-time event).
 */
export async function forkCopy(fromSessionId: string, toSessionId: string): Promise<void> {
	await omRun(["fork-copy", fromSessionId, toSessionId]);
}

/** One-time migration of a legacy .memory/<session>/ directory into the database. */
export async function legacyImport(sessionId: string, legacyDir: string): Promise<void> {
	await omRun(["import", sessionId, legacyDir]);
}
