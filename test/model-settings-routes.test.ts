import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityStore } from "../src/auth/store";
import { HOUSE, hasModel, modelSettingsFor, useHouseModel } from "../src/models/payer";
import { fakeD1 } from "./fakes/d1";

// Where a person sets the model GitHive's hosted agents run on for them: the /settings/model page, which works
// without the dashboard, and /me/model as JSON. Only a person signed in sets theirs, never an agent's token.

vi.mock("../src/access", () => ({ verifyAccessRequest: vi.fn(async () => null) }));
const worker = (await import("../src/index")).default;
const ORIGIN = "https://githive.test";
const SECRET = btoa(String.fromCharCode(...new Uint8Array(32).fill(3)));

let env: { DB: ReturnType<typeof fakeD1>; MODEL_KEYS_SECRET: string };
let ada: { id: string; session: string; token: string };

beforeEach(async () => {
	const DB = fakeD1();
	const ids = new IdentityStore(DB);
	await ids.invite("ada@example.com", "admin");
	const { user } = (await ids.signIn({
		provider: "github",
		providerId: "ada",
		email: "ada@example.com",
		login: "ada",
	})) as { user: { id: string } };
	const agent = await ids.createAgent(user.id, "builder");
	ada = {
		id: user.id,
		session: `__Host-githive_session=${encodeURIComponent(await ids.createSession(user.id))}`,
		token: (await ids.createToken(user.id, agent.id)).token,
	};
	env = { DB, MODEL_KEYS_SECRET: SECRET };
});

const send = (path: string, init: RequestInit & { as?: string; token?: string } = {}) => {
	const headers = new Headers(init.headers);
	if (init.as) headers.set("Cookie", init.as);
	if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
	if (init.method && init.method !== "GET") headers.set("Origin", ORIGIN);
	return worker.fetch(new Request(`${ORIGIN}${path}`, { ...init, headers }), env as never, {} as never);
};
const json = (body: object) => ({ body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
const claude = { provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-abcdefgh9876" };

describe("a person's model, as JSON", () => {
	it("is saved, shown without its key, used for the agents they start, and removed", async () => {
		const saved = await send("/me/model", { method: "PUT", as: ada.session, ...json(claude) });
		expect(await saved.json()).toEqual({
			model: { provider: "anthropic", model: "claude-opus-5-5", keyEnding: "9876", updatedAt: expect.any(String) },
		});
		expect(JSON.stringify(await (await send("/me/model", { as: ada.session })).json())).not.toContain("abcdefgh");
		expect(await modelSettingsFor(env as never, ada.id)).toEqual(claude);
		expect(await hasModel(env as never, ada.id)).toBe(true);
		await send("/me/model", { method: "DELETE", as: ada.session });
		expect(await hasModel(env as never, ada.id)).toBe(false);
	});

	it("is set by a person signed in, never with an agent's token", async () => {
		const byAgent = await send("/me/model", { method: "PUT", token: ada.token, ...json(claude) });
		expect(byAgent.status).toBe(403);
		expect((await send("/me/model", { method: "PUT", ...json(claude) })).status).toBe(401);
	});

	it("refuses settings it can't use, saying why", async () => {
		const bad = await send("/me/model", { method: "PUT", as: ada.session, ...json({ ...claude, provider: "x" }) });
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: string }).error).toMatch(/provider must be one of/);
	});
});

describe("the /settings/model page", () => {
	const form = (fields: Record<string, string>) => ({ body: new URLSearchParams(fields) });

	it("asks someone signed out to sign in", async () => {
		const page = await (await send("/settings/model")).text();
		expect(page).toContain("Sign in with GitHub");
		expect(page).toContain("/auth/github?return=%2Fsettings%2Fmodel");
	});

	it("saves a person's model, then keeps their key when they change only the model", async () => {
		const saved = await send("/settings/model", {
			method: "POST",
			as: ada.session,
			...form({ ...claude, action: "save" }),
		});
		expect(saved.status).toBe(303);
		expect(await (await send("/settings/model?saved", { as: ada.session })).text()).toContain("claude-opus-5-5");
		const changed = { provider: "anthropic", model: "claude-sonnet-5-5", apiKey: "", action: "save" };
		await send("/settings/model", { method: "POST", as: ada.session, ...form(changed) });
		expect(await modelSettingsFor(env as never, ada.id)).toEqual({ ...claude, model: "claude-sonnet-5-5" });
	});

	it("says what's wrong instead of saving, and never shows the key back", async () => {
		const bad = await send("/settings/model", {
			method: "POST",
			as: ada.session,
			...form({ provider: "openai-compatible", model: "m", apiKey: "sk-or-1234567890", action: "save" }),
		});
		expect(bad.status).toBe(400);
		const page = await bad.text();
		expect(page).toContain("baseUrl");
		expect(page).not.toContain("sk-or-1234567890");
	});
});

describe("whose model an agent runs on", () => {
	it("is nobody's unless they set one, and the house's only where the Worker names one", async () => {
		await expect(modelSettingsFor(env as never, ada.id)).rejects.toThrow(/set a provider, a model and your key/);
		await expect(modelSettingsFor(env as never, undefined)).rejects.toThrow(/settings\/model/);
		expect(await hasModel(env as never, HOUSE)).toBe(false);
		await expect(modelSettingsFor(env as never, HOUSE)).rejects.toThrow(/no model of its own/);
		const house = { provider: "openai", model: "gpt-6-luna", apiKey: "sk-house" } as const;
		useHouseModel(() => house);
		expect(await modelSettingsFor(env as never, HOUSE)).toEqual(house);
	});
});
