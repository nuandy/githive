/**
 * MCP tool annotations: a title for people and hints for clients. Destructive tools can undo or give up work,
 * such as abandoning a change or releasing a claim. Anthropic's connector directory asks for a title and
 * readOnlyHint or destructiveHint on every tool.
 */
export interface ToolAnnotations {
	title: string;
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
	openWorldHint: false;
}

export const reads = (title: string): ToolAnnotations => ({
	title,
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
});
export const writes = (title: string, { idempotent = false } = {}): ToolAnnotations => ({
	title,
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: idempotent,
	openWorldHint: false,
});
export const destroys = (title: string, { idempotent = false } = {}): ToolAnnotations => ({
	title,
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: idempotent,
	openWorldHint: false,
});

/** Puts each tool's title at the top level and in its annotations, since MCP clients read either. */
export function annotate<T extends { name: string }>(
	tools: readonly T[],
	annotations: Record<string, ToolAnnotations>,
) {
	return tools.map((tool) => {
		const a = annotations[tool.name];
		if (!a) throw new Error(`tool ${tool.name} has no annotations`);
		return { ...tool, title: a.title, annotations: a };
	});
}
