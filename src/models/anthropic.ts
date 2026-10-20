import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AgentTool } from "../agent";
import { type Input, type ModelClient, type ModelSettings, type TurnRequest, withoutKey } from "./model";

// Anthropic's Messages API. It keeps nothing between requests, so the conversation's messages are the entries, and
// each turn sends them all. Every reply is kept whole, thinking blocks included, and the history is only ever
// appended to: newer models refuse a conversation whose earlier turns were changed.

type Message = Anthropic.Beta.BetaMessageParam;

/** The models that take a server-side fallback when one declines, and the effort setting. */
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
const NO_EFFORT = /haiku|sonnet-4-5|-3-/;
const MAX_TOKENS = 64000;
/** A reply whose tool input couldn't be read is asked for again, this many times in a row at most. */
const UNREADABLE_RETRIES = 2;

const toolOf = (t: AgentTool): Anthropic.Beta.BetaTool => {
	const { $schema: _version, ...schema } = z.toJSONSchema(t.schema) as Record<string, unknown>;
	return {
		name: t.name,
		description: t.description,
		input_schema: schema as Anthropic.Beta.BetaTool["input_schema"],
		// Files written through write_file arrive as they're generated instead of in one burst; runCall checks each
		// input against the tool's schema before it runs.
		eager_input_streaming: true,
	};
};

/** One user message: tool results first, as the API requires, then words for the model. */
function userMessage(inputs: Input[]): Message {
	const results = inputs.flatMap((input) =>
		input.kind === "result" ? [{ type: "tool_result" as const, tool_use_id: input.callId, content: input.output }] : [],
	);
	const texts = inputs.flatMap((input) => (input.kind === "text" ? [{ type: "text" as const, text: input.text }] : []));
	return { role: "user", content: [...results, ...texts] };
}

export function anthropicClient(settings: ModelSettings): ModelClient {
	const client = new Anthropic({ apiKey: settings.apiKey });
	const fallback = FALLBACK_MODELS.has(settings.model);
	const effort = NO_EFFORT.test(settings.model) ? {} : { output_config: { effort: "high" as const } };

	const reply = async (request: TurnRequest, messages: Message[]) => {
		for (let attempt = 0; ; attempt++) {
			const stream = client.beta.messages.stream({
				model: settings.model,
				max_tokens: MAX_TOKENS,
				system: request.instructions,
				tools: request.tools.map(toolOf),
				messages,
				// Caches the conversation up to its last block, so each turn pays full price only for what's new.
				cache_control: { type: "ephemeral" },
				...effort,
				...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
			});
			try {
				return await stream.finalMessage();
			} catch (err) {
				// An API error is the provider's answer. Anything else here is a tool input that couldn't be parsed.
				if (err instanceof Anthropic.APIError) throw new Error(withoutKey(err.message, settings.apiKey));
				if (attempt >= UNREADABLE_RETRIES) throw new Error("the model's tool input couldn't be read");
			}
		}
	};

	return {
		async turn(request: TurnRequest) {
			const sent = userMessage(request.inputs);
			const answer = await reply(request, [...(request.history as Message[]), sent]);
			if (answer.stop_reason === "refusal")
				throw new Error(`the model declined: ${answer.stop_details?.category ?? "no category given"}`);
			// A tool input cut off at max_tokens can still parse, so it must not run.
			if (answer.stop_reason === "max_tokens") throw new Error("the response was cut short: max_tokens");
			const calls = answer.content.flatMap((block) =>
				block.type === "tool_use" ? [{ id: block.id, name: block.name, arguments: JSON.stringify(block.input) }] : [],
			);
			const text = answer.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
			const cached = answer.usage.cache_read_input_tokens ?? 0;
			const written = answer.usage.cache_creation_input_tokens ?? 0;
			const usage = {
				inputTokens: answer.usage.input_tokens + cached + written,
				outputTokens: answer.usage.output_tokens,
				cacheReadTokens: cached,
			};
			const kept: Message = { role: "assistant", content: answer.content };
			return { reply: { text, calls, usage }, append: [sent, kept] };
		},
	};
}
