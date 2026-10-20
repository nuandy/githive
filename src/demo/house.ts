import { fail } from "../errors";
import type { ModelSettings } from "../models/model";

// The model GitHive's own runs use: demo runs, and its operators at the admin door. githive.app runs them on OpenAI's
// gpt-6-luna under the house key; everyone else's agents run on their own settings (see models/payer.ts).

const HOUSE_MODEL = "gpt-6-luna";

export function houseModel(env: Env): ModelSettings {
	if (!env.OPENAI_API_KEY) fail(501, "this GitHive has no house model: OPENAI_API_KEY isn't set");
	return { provider: "openai", model: HOUSE_MODEL, apiKey: env.OPENAI_API_KEY };
}
