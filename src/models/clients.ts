import { anthropicClient } from "./anthropic";
import type { ModelClient, ModelSettings } from "./model";
import { openAIClient } from "./openai";
import { openAICompatibleClient } from "./openai-compatible";

/** The client for a person's model settings. */
export function modelClient(settings: ModelSettings): ModelClient {
	if (settings.provider === "anthropic") return anthropicClient(settings);
	if (settings.provider === "openai-compatible") return openAICompatibleClient(settings);
	return openAIClient(settings);
}
