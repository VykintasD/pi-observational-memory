import type { Topic } from "./paths.js";

/**
 * One line per topic for the compaction memory map (injected as context, not a file).
 * Topics are addressed by slug; the master reads them with the om_memory tool.
 */
export function renderMemoryMap(topics: Topic[]): string | undefined {
	if (topics.length === 0) return undefined;
	const lines = topics.map((t) => {
		const when = t.updated ? ` (updated ${t.updated})` : "";
		return `- ${t.slug}: ${t.summary}${when}`;
	});
	return `## Memory map\nTopics (read via the om_memory tool, \`get <slug>\`):\n${lines.join("\n")}`;
}
