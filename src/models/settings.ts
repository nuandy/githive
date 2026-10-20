import { fail } from "../errors";
import { PROVIDERS, type ModelSettings, type Provider } from "./model";

// Each person's model for GitHive's hosted agents: provider, model, base URL and their own key. The key is sealed
// with AES-GCM under MODEL_KEYS_SECRET before it reaches D1 and opened only to call the model; nothing shows it again
// but its last four characters.

/** Settings as a person may see them: everything but the key. */
export interface ModelSettingsView {
	provider: Provider;
	model: string;
	baseUrl?: string;
	keyEnding: string;
	updatedAt: string;
}

interface Row {
	provider: Provider;
	model: string;
	base_url: string | null;
	sealed_key: string;
	key_ending: string;
	updated_at: string;
}

const MAX_MODEL = 200;
const MAX_KEY = 500;
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

async function sealingKey(secret: string | undefined) {
	if (!secret) fail(501, "this GitHive can't keep model keys yet: MODEL_KEYS_SECRET isn't set");
	const raw = fromBase64(secret);
	if (raw.length !== 32) fail(500, "MODEL_KEYS_SECRET must be 32 bytes, base64-encoded");
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(secret: string | undefined, apiKey: string) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const key = await sealingKey(secret);
	const sealed = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(apiKey)),
	);
	return `${toBase64(iv)}.${toBase64(sealed)}`;
}

async function open(secret: string | undefined, sealedKey: string) {
	const [iv, sealed] = sealedKey.split(".");
	const key = await sealingKey(secret);
	let opened: ArrayBuffer;
	try {
		opened = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(iv ?? "") }, key, fromBase64(sealed ?? ""));
	} catch {
		// Sealed under an earlier MODEL_KEYS_SECRET: only the person can put their key back.
		fail(
			409,
			"your API key can't be read any more, since this GitHive changed how it keeps keys: " +
				"set your key again at /settings/model",
		);
	}
	return new TextDecoder().decode(opened);
}

/** Checks settings a person sent, as given, or fails saying what's wrong. */
export function checkedSettings(input: Record<string, unknown>): ModelSettings {
	const { provider, model, apiKey, baseUrl } = input;
	if (typeof provider !== "string" || !PROVIDERS.includes(provider as Provider))
		fail(400, `provider must be one of ${PROVIDERS.join(", ")}`);
	if (typeof model !== "string" || !model.trim() || model.length > MAX_MODEL) fail(400, "model must name a model");
	if (typeof apiKey !== "string" || apiKey.trim().length < 8 || apiKey.length > MAX_KEY)
		fail(400, "apiKey must be a key");
	const settings: ModelSettings = { provider: provider as Provider, model: model.trim(), apiKey: apiKey.trim() };
	if (provider !== "openai-compatible") return settings;
	if (typeof baseUrl !== "string") fail(400, "an OpenAI-compatible model needs baseUrl, its API's address");
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		fail(400, "baseUrl must be a URL");
	}
	if (url.protocol !== "https:") fail(400, "baseUrl must be an https:// address");
	return { ...settings, baseUrl: url.toString().replace(/\/$/, "") };
}

export class ModelSettingsStore {
	constructor(
		private readonly db: D1Database,
		private readonly secret: string | undefined,
	) {}

	async save(userId: string, settings: ModelSettings) {
		const sealed = await seal(this.secret, settings.apiKey);
		await this.db
			.prepare(
				"INSERT INTO model_settings (user_id, provider, model, base_url, sealed_key, key_ending, updated_at) " +
					"VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET provider = excluded.provider, " +
					"model = excluded.model, base_url = excluded.base_url, sealed_key = excluded.sealed_key, " +
					"key_ending = excluded.key_ending, updated_at = excluded.updated_at",
			)
			.bind(
				userId,
				settings.provider,
				settings.model,
				settings.baseUrl ?? null,
				sealed,
				settings.apiKey.slice(-4),
				new Date().toISOString(),
			)
			.run();
	}

	private row(userId: string) {
		return this.db.prepare("SELECT * FROM model_settings WHERE user_id = ?").bind(userId).first<Row>();
	}

	/** A person's settings without the key, or null when they've saved none. */
	async view(userId: string): Promise<ModelSettingsView | null> {
		const row = await this.row(userId);
		if (!row) return null;
		const base = { provider: row.provider, model: row.model, keyEnding: row.key_ending, updatedAt: row.updated_at };
		return row.base_url ? { ...base, baseUrl: row.base_url } : base;
	}

	/** A person's settings with the key opened, to call the model; null when they've saved none. */
	async settings(userId: string): Promise<ModelSettings | null> {
		const row = await this.row(userId);
		if (!row) return null;
		const apiKey = await open(this.secret, row.sealed_key);
		const base = { provider: row.provider, model: row.model, apiKey };
		return row.base_url ? { ...base, baseUrl: row.base_url } : base;
	}

	async remove(userId: string) {
		await this.db.prepare("DELETE FROM model_settings WHERE user_id = ?").bind(userId).run();
	}
}
