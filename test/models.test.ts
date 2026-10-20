import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "../src/agent";
import { withoutKey } from "../src/models/model";
import { ModelSettingsStore, checkedSettings } from "../src/models/settings";
import { appendThread, clearThread, loadThread, madeWith } from "../src/models/thread";
import { fakeD1 } from "./fakes/d1";
import { FakeStorage } from "./fakes/env";

// The models GitHive's hosted agents run on: each provider's adapter turns the agent's turn into that provider's
// request and its reply back into calls, the conversation is kept in the agent's own storage, and each person's
// settings are kept with their key sealed.

const sdk = vi.hoisted(() => ({
	stream: vi.fn(),
	chat: vi.fn(),
	responses: vi.fn(),
	APIError: class extends Error {},
}));
vi.mock("@anthropic-ai/sdk", () => ({
	default: Object.assign(
		class {
			beta = { messages: { stream: sdk.stream } };
		},
		{ APIError: sdk.APIError },
	),
}));
vi.mock("openai", () => ({
	default: class {
		chat = { completions: { create: sdk.chat } };
		responses = { create: sdk.responses };
	},
}));

const { anthropicClient } = await import("../src/models/anthropic");
const { openAICompatibleClient } = await import("../src/models/openai-compatible");
const { openAIClient } = await import("../src/models/openai");

const readFile = tool({
	name: "read_file",
	description: "Read a file",
	schema: z.strictObject({ path: z.string() }),
	run: async () => "",
});
const request = (more: object = {}) => ({
	instructions: "Build it.",
	tools: [readFile],
	history: [],
	inputs: [{ kind: "text" as const, text: "Start." }],
	cacheKey: "builder-a",
	...more,
});
const claude = (model = "claude-opus-5-5") =>
	anthropicClient({ provider: "anthropic", model, apiKey: "sk-ant-secret1" });
const finished = (message: object) => ({ finalMessage: async () => message });
const claudeAnswer = (more: object = {}) => ({
	stop_reason: "tool_use",
	content: [
		{ type: "thinking", thinking: "", signature: "sig" },
		{ type: "tool_use", id: "t1", name: "read_file", input: { path: "a.ts" } },
	],
	usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
	...more,
});

beforeEach(() => vi.clearAllMocks());

describe("the Anthropic adapter", () => {
	it("sends tool results first and words after in one user message, with tools that stream their input", async () => {
		sdk.stream.mockReturnValueOnce(finished(claudeAnswer()));
		const inputs = [
			{ kind: "text" as const, text: "The container restarted." },
			{ kind: "result" as const, callId: "t0", output: "ok" },
		];
		await claude().turn(request({ inputs }));
		const sent = sdk.stream.mock.calls[0]![0];
		expect(sent.messages.at(-1)).toEqual({
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: "t0", content: "ok" },
				{ type: "text", text: "The container restarted." },
			],
		});
		expect(sent.tools[0]).toMatchObject({ name: "read_file", eager_input_streaming: true });
		expect(sent.tools[0].input_schema).not.toHaveProperty("$schema");
		expect(sent).toMatchObject({ system: "Build it.", cache_control: { type: "ephemeral" } });
		expect(sent).toMatchObject({ fallbacks: "default", output_config: { effort: "high" } });
	});

	it("asks no fallback or effort of a model that takes neither", async () => {
		sdk.stream.mockReturnValueOnce(finished(claudeAnswer()));
		await claude("claude-haiku-4-5").turn(request());
		const sent = sdk.stream.mock.calls[0]![0];
		expect(sent).not.toHaveProperty("fallbacks");
		expect(sent).not.toHaveProperty("output_config");
	});

	it("keeps the reply whole, thinking included, and reads its calls and usage", async () => {
		const answer = claudeAnswer();
		sdk.stream.mockReturnValueOnce(finished(answer));
		const { reply, append } = await claude().turn(request());
		expect(reply.calls).toEqual([{ id: "t1", name: "read_file", arguments: '{"path":"a.ts"}' }]);
		expect(reply.usage).toEqual({ inputTokens: 100, outputTokens: 5, cacheReadTokens: 90 });
		expect(append).toEqual([
			{ role: "user", content: [{ type: "text", text: "Start." }] },
			{ role: "assistant", content: answer.content },
		]);
	});

	it("never runs tools from a reply cut short or declined", async () => {
		sdk.stream.mockReturnValueOnce(finished(claudeAnswer({ stop_reason: "max_tokens" })));
		await expect(claude().turn(request())).rejects.toThrow(/cut short/);
		sdk.stream.mockReturnValueOnce(
			finished(claudeAnswer({ stop_reason: "refusal", stop_details: { category: "cyber" } })),
		);
		await expect(claude().turn(request())).rejects.toThrow(/declined: cyber/);
	});

	it("names no key when the API refuses it", async () => {
		sdk.stream.mockReturnValueOnce({
			finalMessage: async () => {
				throw new sdk.APIError("401 invalid x-api-key sk-ant-secret1");
			},
		});
		await expect(claude().turn(request())).rejects.toThrow("401 invalid x-api-key [key]");
	});
});

describe("the OpenAI-compatible adapter", () => {
	const compatible = () =>
		openAICompatibleClient({
			provider: "openai-compatible",
			model: "anthropic/claude-opus-5-5",
			apiKey: "sk-or-secret",
			baseUrl: "https://openrouter.ai/api/v1",
		});
	const completion = (message: object, finish = "tool_calls") => ({
		choices: [{ finish_reason: finish, message }],
		usage: { prompt_tokens: 50, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 40 } },
	});

	it("sends the instructions first, then the conversation and what's new, and keeps the reply", async () => {
		const call = { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } };
		sdk.chat.mockResolvedValueOnce(completion({ role: "assistant", content: null, tool_calls: [call] }));
		const history = [{ role: "user", content: "Start." }];
		const inputs = [{ kind: "result" as const, callId: "c0", output: "done" }];
		const { reply, append } = await compatible().turn(request({ history, inputs }));
		expect(sdk.chat.mock.calls[0]![0].messages).toEqual([
			{ role: "system", content: "Build it." },
			{ role: "user", content: "Start." },
			{ role: "tool", tool_call_id: "c0", content: "done" },
		]);
		expect(reply.calls).toEqual([{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }]);
		expect(reply.usage).toEqual({ inputTokens: 50, outputTokens: 7, cacheReadTokens: 40 });
		expect(append).toEqual([
			{ role: "tool", tool_call_id: "c0", content: "done" },
			{ role: "assistant", content: "", tool_calls: [call] },
		]);
	});

	it("needs its API's address, and won't run tools from a reply cut short", async () => {
		expect(() => openAICompatibleClient({ provider: "openai-compatible", model: "m", apiKey: "k" })).toThrow(
			/base URL/,
		);
		sdk.chat.mockResolvedValueOnce(completion({ role: "assistant", content: "half" }, "length"));
		await expect(compatible().turn(request())).rejects.toThrow(/cut short/);
	});
});

describe("the OpenAI Responses adapter", () => {
	it("continues from the last response, keeping only its id", async () => {
		sdk.responses.mockResolvedValueOnce({ id: "r2", status: "completed", output: [], output_text: "hm" });
		const client = openAIClient({ provider: "openai", model: "gpt-6-luna", apiKey: "sk-secret" });
		const { append } = await client.turn(request({ history: [{ responseId: "r0" }, { responseId: "r1" }] }));
		expect(sdk.responses.mock.calls[0]![0]).toMatchObject({ previous_response_id: "r1", model: "gpt-6-luna" });
		expect(append).toEqual([{ responseId: "r2" }]);
	});
});

describe("a hosted agent's conversation", () => {
	it("keeps entries in order, a large one in parts, under the model they were made with", async () => {
		const storage = new FakeStorage() as unknown as DurableObjectStorage;
		const large = JSON.stringify({ content: "x".repeat(150_000) });
		await appendThread(storage, "anthropic  claude-opus-5-5", 0, ['{"a":1}', large]);
		await appendThread(storage, "anthropic  claude-opus-5-5", 2, ['{"b":2}']);
		expect(await loadThread(storage)).toEqual({
			madeWith: "anthropic  claude-opus-5-5",
			entries: ['{"a":1}', large, '{"b":2}'],
		});
		await clearThread(storage);
		expect(await loadThread(storage)).toBeNull();
	});

	it("is made with a provider, an address and a model", () => {
		expect(madeWith({ provider: "openai-compatible", baseUrl: "https://x.test/v1", model: "m" })).toBe(
			"openai-compatible https://x.test/v1 m",
		);
	});
});

describe("a person's model settings", () => {
	const secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

	it("keep the key sealed, show only its last four characters, and open it to call the model", async () => {
		const db = fakeD1();
		await db
			.prepare("INSERT INTO users (id, handle, email, created_at) VALUES ('u1', 'ada', 'ada@x.test', '2026-10-20')")
			.run();
		const store = new ModelSettingsStore(db as unknown as D1Database, secret);
		await store.save("u1", { provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-abcdef1234" });
		const row = await db.prepare("SELECT sealed_key FROM model_settings").first<{ sealed_key: string }>();
		expect(row?.sealed_key).not.toContain("abcdef1234");
		expect(await store.view("u1")).toMatchObject({ provider: "anthropic", keyEnding: "1234" });
		expect(await store.settings("u1")).toEqual({
			provider: "anthropic",
			model: "claude-opus-5-5",
			apiKey: "sk-ant-abcdef1234",
		});
		await store.remove("u1");
		expect(await store.view("u1")).toBeNull();
	});

	it("asks for the key again once it was sealed under another secret", async () => {
		const db = fakeD1();
		await db
			.prepare("INSERT INTO users (id, handle, email, created_at) VALUES ('u1', 'ada', 'ada@x.test', '2026-10-20')")
			.run();
		await new ModelSettingsStore(db as unknown as D1Database, secret).save("u1", {
			provider: "openai",
			model: "gpt-6-luna",
			apiKey: "sk-12345678",
		});
		const replaced = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
		const store = new ModelSettingsStore(db as unknown as D1Database, replaced);
		await expect(store.settings("u1")).rejects.toThrow(/set your key again at \/settings\/model/);
	});

	it("won't keep a key without the secret to seal it", async () => {
		const store = new ModelSettingsStore(fakeD1() as unknown as D1Database, undefined);
		await expect(store.save("u1", { provider: "openai", model: "gpt-6-luna", apiKey: "sk-12345678" })).rejects.toThrow(
			/MODEL_KEYS_SECRET/,
		);
	});

	it("are checked as sent: a known provider, a model, a key, and an https address where one is needed", () => {
		const base = { provider: "anthropic", model: " claude-opus-5-5 ", apiKey: "sk-ant-12345678" };
		expect(checkedSettings(base)).toEqual({
			provider: "anthropic",
			model: "claude-opus-5-5",
			apiKey: "sk-ant-12345678",
		});
		expect(() => checkedSettings({ ...base, provider: "gemini" })).toThrow(/provider must be one of/);
		expect(() => checkedSettings({ ...base, apiKey: "short" })).toThrow(/apiKey/);
		const compatible = { ...base, provider: "openai-compatible" };
		expect(() => checkedSettings(compatible)).toThrow(/baseUrl/);
		expect(() => checkedSettings({ ...compatible, baseUrl: "http://x.test/v1" })).toThrow(/https/);
		expect(checkedSettings({ ...compatible, baseUrl: "https://x.test/v1/" }).baseUrl).toBe("https://x.test/v1");
	});
});

describe("provider errors", () => {
	it("name no key, the person's or one quoted back", () => {
		expect(withoutKey("bad key sk-live-abc123def", "other")).toBe("bad key [key]");
		expect(withoutKey("refused secret-key-9", "secret-key-9")).toBe("refused [key]");
	});
});
