import type { Context, Hono } from "hono";
import { escape, html, page } from "../auth/authorize";
import type { Principal } from "../auth/principal";
import { fail, statusOf } from "../errors";
import { PROVIDERS, type Provider } from "../models/model";
import { type ModelSettingsView, ModelSettingsStore, checkedSettings } from "../models/settings";
import type { AppEnv } from "./shared";

// Where a person sets the model GitHive's hosted agents run on for them: a page of its own at /settings/model, which
// works without the dashboard, and the same as JSON at /me/model. Only a person signed in sets theirs; an agent's
// token can't, since the model it names reads the code its builders and reviewers work on.

const PROVIDER_LABELS: Record<Provider, string> = {
	openai: "OpenAI",
	anthropic: "Anthropic",
	"openai-compatible": "An OpenAI-compatible API: OpenRouter, Workers AI, Groq, Together, or a server of your own",
};
const SUGGESTED_MODELS: Record<Provider, string> = {
	openai: "gpt-6-luna",
	anthropic: "claude-opus-5-5",
	"openai-compatible": "anthropic/claude-opus-5-5",
};

const store = (env: Env) => new ModelSettingsStore(env.DB, env.MODEL_KEYS_SECRET);

function person(principal: Principal | undefined) {
	if (!principal) fail(401, "sign in to GitHive first");
	if (principal.kind !== "user") fail(403, "a person signed in sets their own model; an agent's token can't");
	return principal.user;
}

function form(saved: ModelSettingsView | null) {
	const chosen = saved?.provider ?? "anthropic";
	const radio = (provider: Provider) =>
		`<label><input type="radio" name="provider" value="${provider}"${provider === chosen ? " checked" : ""}> ` +
		`${escape(PROVIDER_LABELS[provider])}</label>`;
	const keyHint = saved ? `Leave it empty to keep the key ending in ${escape(saved.keyEnding)}.` : "";
	return `<form method="post">
<fieldset><legend>Provider</legend>${PROVIDERS.map(radio).join("")}</fieldset>
<fieldset><legend>Model</legend>
<label><input type="text" name="model" value="${escape(saved?.model ?? SUGGESTED_MODELS[chosen])}" required></label>
<p class="muted">For example ${Object.values(SUGGESTED_MODELS).map(escape).join(", ")}.</p></fieldset>
<fieldset><legend>Base URL, for an OpenAI-compatible API</legend>
<label><input type="url" name="baseUrl" value="${escape(saved?.baseUrl ?? "")}" placeholder="https://openrouter.ai/api/v1"></label></fieldset>
<fieldset><legend>Your API key</legend>
<label><input type="password" name="apiKey" autocomplete="off"${saved ? "" : " required"}></label>
<p class="muted">Sealed before it's stored, and never shown again. ${keyHint}</p></fieldset>
<div class="actions"><button class="primary" name="action" value="save">Save</button>
${saved ? '<button name="action" value="remove">Remove my model</button>' : ""}</div></form>`;
}

function settingsPage(saved: ModelSettingsView | null, notice?: { text: string; warn?: boolean }) {
	const current = saved
		? `<p>Your hosted agents run on <strong>${escape(saved.model)}</strong> (${escape(PROVIDER_LABELS[saved.provider])}).</p>`
		: "<p>You haven't set a model yet, so hosted agents can't start for you.</p>";
	const told = notice ? `<p class="${notice.warn ? "warn" : "note"}" role="status">${escape(notice.text)}</p>` : "";
	return page(
		"Your model",
		`<h1>Your model for hosted agents</h1>
<p class="muted">GitHive's hosted builders and reviewers run on your own model and key: the ones you start, and the ones
your agents start with build and request_review.</p>${told}${current}${form(saved)}`,
	);
}

const signInPage = () =>
	page(
		"Your model",
		`<h1>Your model for hosted agents</h1><p>Sign in to set the model GitHive's hosted agents run on for you.</p>
<div class="actions"><a class="button primary" href="/auth/github?return=${encodeURIComponent("/settings/model")}">Sign in with GitHub</a></div>`,
	);

/** Saves what the form sent, keeping the stored key when none was typed. */
async function saveForm(env: Env, userId: string, fields: Record<string, unknown>) {
	const typed = typeof fields.apiKey === "string" ? fields.apiKey.trim() : "";
	const kept = typed ? undefined : await store(env).settings(userId);
	if (!typed && !kept) fail(400, "type your API key");
	const baseUrl = fields.baseUrl === "" ? undefined : fields.baseUrl;
	const settings = checkedSettings({ ...fields, baseUrl, apiKey: typed || kept!.apiKey });
	await store(env).save(userId, settings);
}

async function postForm(c: Context<AppEnv>) {
	const user = person(c.get("principal"));
	const fields = Object.fromEntries(await c.req.formData()) as Record<string, unknown>;
	try {
		if (fields.action === "remove") await store(c.env).remove(user.id);
		else await saveForm(c.env, user.id, fields);
		return c.redirect(`/settings/model?${fields.action === "remove" ? "removed" : "saved"}`, 303);
	} catch (err) {
		const { status, message } = statusOf(err);
		const saved = await store(c.env).view(user.id);
		return html(settingsPage(saved, { text: message, warn: true }), status);
	}
}

export function modelSettingsRoutes(app: Hono<AppEnv>) {
	app.get("/settings/model", async (c) => {
		const principal = c.get("principal");
		if (!principal) return html(signInPage());
		const user = person(principal);
		const saved = await store(c.env).view(user.id);
		const query = new URL(c.req.url).searchParams;
		if (query.has("saved")) return html(settingsPage(saved, { text: "Saved." }));
		if (query.has("removed")) return html(settingsPage(saved, { text: "Removed." }));
		return html(settingsPage(saved));
	});
	app.post("/settings/model", postForm);

	app.get("/me/model", async (c) => {
		const user = person(c.get("principal"));
		return c.json({ model: await store(c.env).view(user.id) });
	});
	app.put("/me/model", async (c) => {
		const user = person(c.get("principal"));
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		await store(c.env).save(user.id, checkedSettings(body));
		return c.json({ model: await store(c.env).view(user.id) });
	});
	app.delete("/me/model", async (c) => {
		const user = person(c.get("principal"));
		await store(c.env).remove(user.id);
		return c.json({ model: null });
	});
}
