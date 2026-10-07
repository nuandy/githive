/**
 * MCP tool annotations: a title for people, and hints for clients about what
 * a call does. Read-only tools change nothing; destructive ones can undo or
 * give up work (abandoning a change, releasing a claim, a revert, a new agent
 * key); idempotent ones can be repeated with the same arguments to the same
 * effect. GitHive's tools act only on its own repos and records, not an open
 * world. (Anthropic's connector directory asks for a title and readOnlyHint or
 * destructiveHint on every tool.)
 */
export interface ToolAnnotations {
	title: string;
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: false;
}

export const reads = (title: string): ToolAnnotations => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
export const writes = (title: string, { idempotent = false } = {}): ToolAnnotations => ({ title, readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false });
export const destroys = (title: string, { idempotent = false } = {}): ToolAnnotations => ({ title, readOnlyHint: false, destructiveHint: true, idempotentHint: idempotent, openWorldHint: false });

/** A tool definition with its title, at the top level and in its annotations, as MCP clients read either. */
export function annotate<T extends { name: string }>(tools: readonly T[], annotations: Record<string, ToolAnnotations>) {
	return tools.map((tool) => {
		const a = annotations[tool.name];
		if (!a) throw new Error(`tool ${tool.name} has no annotations`);
		return { ...tool, title: a.title, annotations: a };
	});
}
