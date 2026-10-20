import type { AgentTool, Usage } from "../agent";

// The models GitHive's hosted builders and reviewers run on. The person who starts them chooses the provider, the
// model and their own key (see settings.ts). Each provider has an adapter of its own; the agent loop in sandbox.ts
// sees only this interface.

export const PROVIDERS = ["openai", "openai-compatible", "anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ModelSettings {
	provider: Provider;
	model: string;
	apiKey: string;
	/** For "openai-compatible": the API's base URL, such as https://openrouter.ai/api/v1. */
	baseUrl?: string;
}

/** What the agent sends besides its instructions and tools: words for the model, or a tool call's result. */
export type Input = { kind: "text"; text: string } | { kind: "result"; callId: string; output: string };

/** A tool call the model asked for; its arguments as the JSON text the tool parses (see agent.ts). */
export interface Call {
	id: string;
	name: string;
	arguments: string;
}

export interface Reply {
	text: string;
	calls: Call[];
	usage: Usage;
}

export interface TurnRequest {
	instructions: string;
	tools: AgentTool[];
	/** The entries this adapter appended in earlier turns, oldest first. */
	history: unknown[];
	inputs: Input[];
	/** A stable key for the agent, so a provider can reuse its cached prompt prefix. */
	cacheKey: string;
}

/** A turn's reply, and the entries to append to the conversation for the next turn. */
export interface TurnResult {
	reply: Reply;
	append: unknown[];
}

export interface ModelClient {
	turn(request: TurnRequest): Promise<TurnResult>;
}

/**
 * A provider's error message with the key taken out. Agents' logs are shown to anyone who can read the repo, and some
 * providers quote part of a key they refuse.
 */
export function withoutKey(message: string, apiKey: string) {
	const hidden = apiKey ? message.split(apiKey).join("[key]") : message;
	return hidden.replace(/\b(sk|key)-[A-Za-z0-9_*-]{6,}/g, "[key]");
}

/** Runs a provider call, rethrowing its failure as an Error whose message names no key. */
export async function keyless<T>(apiKey: string, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (err) {
		throw new Error(withoutKey(err instanceof Error ? err.message : String(err), apiKey));
	}
}
