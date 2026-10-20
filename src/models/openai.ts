import OpenAI from "openai";
import { zodResponsesFunction } from "openai/helpers/zod";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import { keyless, type Input, type ModelClient, type ModelSettings, type TurnRequest } from "./model";

// OpenAI's Responses API. OpenAI keeps the conversation, so each turn appends only the response's id, and the next
// turn continues from the last one.

interface Entry {
	responseId: string;
}

const inputItem = (input: Input): ResponseInputItem =>
	input.kind === "text"
		? { role: "user", content: input.text }
		: { type: "function_call_output", call_id: input.callId, output: input.output };

export function openAIClient(settings: ModelSettings): ModelClient {
	const client = new OpenAI({ apiKey: settings.apiKey });
	return {
		async turn(request: TurnRequest) {
			const previous = (request.history.at(-1) as Entry | undefined)?.responseId;
			const tools = request.tools.map((t) =>
				zodResponsesFunction({ name: t.name, description: t.description, parameters: t.schema }),
			);
			const response = await keyless(settings.apiKey, () =>
				client.responses.create({
					model: settings.model,
					instructions: request.instructions,
					input: request.inputs.map(inputItem),
					previous_response_id: previous,
					tools,
					reasoning: { effort: "high" },
					max_output_tokens: 32000,
					prompt_cache_key: request.cacheKey,
				}),
			);
			if (response.status === "incomplete")
				throw new Error(`the response was cut short: ${response.incomplete_details?.reason ?? "unknown"}`);
			const calls = response.output
				.filter((item) => item.type === "function_call")
				.map((item) => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
			const usage = {
				inputTokens: response.usage?.input_tokens ?? 0,
				outputTokens: response.usage?.output_tokens ?? 0,
				cacheReadTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
			};
			const entry: Entry = { responseId: response.id };
			return { reply: { text: response.output_text, calls, usage }, append: [entry] };
		},
	};
}
