import type OpenAI from "openai";
import { zodResponsesFunction } from "openai/helpers/zod";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { z } from "zod";

// Shared plumbing for the agents (planner, builders): function tools defined
// with Zod, strict schemas for the model, and a call runner that turns every
// failure into text the model can act on.

export const MODEL = "gpt-6-luna";

export interface AgentTool<S extends z.ZodType = z.ZodType> {
	name: string;
	description: string;
	/** Must be a strict object: every field required, no extra properties. */
	schema: S;
	run: (args: z.infer<S>) => Promise<string>;
}

export const tool = <S extends z.ZodType>(t: AgentTool<S>) => t as unknown as AgentTool;

export const openAITools = (tools: AgentTool[]) =>
	tools.map((t) => zodResponsesFunction({ name: t.name, description: t.description, parameters: t.schema }));

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

/** Run every function call in a response, in order, and return their outputs for the next turn. */
export async function runCalls(tools: AgentTool[], response: OpenAI.Responses.Response) {
	const outputs: ResponseInputItem[] = [];
	for (const item of response.output) {
		if (item.type !== "function_call") continue;
		outputs.push({ type: "function_call_output", call_id: item.call_id, output: await runCall(tools, item.name, item.arguments) });
	}
	return outputs;
}

export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });

export function addUsage(usage: Usage, response: OpenAI.Responses.Response) {
	usage.inputTokens += response.usage?.input_tokens ?? 0;
	usage.outputTokens += response.usage?.output_tokens ?? 0;
	usage.cacheReadTokens += response.usage?.input_tokens_details?.cached_tokens ?? 0;
}

export function assertComplete(response: OpenAI.Responses.Response, who: string) {
	if (response.status === "incomplete")
		throw new Error(`${who} response incomplete: ${response.incomplete_details?.reason ?? "unknown"}`);
}
