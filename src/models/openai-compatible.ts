import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { z } from "zod";
import type { AgentTool } from "../agent";
import { keyless, type Input, type ModelClient, type ModelSettings, type TurnRequest } from "./model";

// Any API that speaks OpenAI's Chat Completions at a base URL of its own: OpenRouter (which reaches Claude, Gemini,
// Llama and others under one key), Cloudflare Workers AI, Groq, Together, DeepSeek, or a self-hosted server. The
// API keeps nothing between requests, so the conversation's messages are the entries, and each turn sends them all.

const chatTool = (t: AgentTool): ChatCompletionTool => ({
	type: "function",
	function: {
		name: t.name,
		description: t.description,
		parameters: z.toJSONSchema(t.schema) as Record<string, unknown>,
	},
});

const message = (input: Input): ChatCompletionMessageParam =>
	input.kind === "text"
		? { role: "user", content: input.text }
		: { role: "tool", tool_call_id: input.callId, content: input.output };

export function openAICompatibleClient(settings: ModelSettings): ModelClient {
	if (!settings.baseUrl) throw new Error("an OpenAI-compatible model needs its API's base URL");
	const client = new OpenAI({ apiKey: settings.apiKey, baseURL: settings.baseUrl });
	return {
		async turn(request: TurnRequest) {
			const sent = request.inputs.map(message);
			const history = request.history as ChatCompletionMessageParam[];
			const completion = await keyless(settings.apiKey, () =>
				client.chat.completions.create({
					model: settings.model,
					messages: [{ role: "system", content: request.instructions }, ...history, ...sent],
					tools: request.tools.map(chatTool),
				}),
			);
			const choice = completion.choices[0];
			if (!choice) throw new Error("the model answered with no choices");
			if (choice.finish_reason === "length") throw new Error("the response was cut short: max_tokens");
			const answer = choice.message;
			const calls = (answer.tool_calls ?? []).flatMap((call) =>
				call.type === "function" ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments }] : [],
			);
			const usage = {
				inputTokens: completion.usage?.prompt_tokens ?? 0,
				outputTokens: completion.usage?.completion_tokens ?? 0,
				cacheReadTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
			};
			const kept: ChatCompletionMessageParam = {
				role: "assistant",
				content: answer.content ?? "",
				...(answer.tool_calls?.length ? { tool_calls: answer.tool_calls } : {}),
			};
			return { reply: { text: answer.content ?? "", calls, usage }, append: [...sent, kept] };
		},
	};
}
