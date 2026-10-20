import type { z } from "zod";

// Shared plumbing for GitHive's hosted builders and reviewers: function tools defined with Zod, and a call runner
// that turns every failure into text the model can act on. Which model runs them is the payer's (see models/).

export interface AgentTool<S extends z.ZodType = z.ZodType> {
	name: string;
	description: string;
	/** Must be a strict object: every field required, no extra properties. */
	schema: S;
	run: (args: z.infer<S>) => Promise<string>;
}

export const tool = <S extends z.ZodType>(t: AgentTool<S>) => t as unknown as AgentTool;

export async function runCall(tools: AgentTool[], name: string, rawArgs: string): Promise<string> {
	const handler = tools.find((t) => t.name === name);
	if (!handler) return `Unknown tool ${name}.`;
	let json: unknown;
	try {
		json = JSON.parse(rawArgs);
	} catch {
		return `Arguments for ${name} were not valid JSON.`;
	}
	const parsed = handler.schema.safeParse(json);
	if (!parsed.success) return `Invalid arguments for ${name}: ${parsed.error.message}`;
	try {
		return await handler.run(parsed.data);
	} catch (err) {
		return `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });

export function addUsage(usage: Usage, more: Usage) {
	usage.inputTokens += more.inputTokens;
	usage.outputTokens += more.outputTokens;
	usage.cacheReadTokens += more.cacheReadTokens;
}
