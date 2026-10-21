import { fail } from "../errors";
import type { ModelSettings } from "./model";
import { ModelSettingsStore } from "./settings";

// Whose model a hosted agent runs on. A person's agents, and the builders and reviewers they start, run on that
// person's own settings. A GitHive's own runs, such as its operators' at the admin door, are the house's: only a
// Worker that names a house model has one.

/** The payer of a GitHive's own runs. */
export const HOUSE = "githive";

export type HouseModel = (env: Env) => ModelSettings;

let houseModel: HouseModel | undefined;

/** Names the model a GitHive's own runs use. The Worker's entry calls it as it loads, in every isolate. */
export function useHouseModel(model: HouseModel) {
	houseModel = model;
}

/** What the dashboard and the tools say when someone hasn't set a model. */
export const NO_MODEL =
	"GitHive's hosted agents run on your own model: set a provider, a model and your key at /settings/model first";

const NO_HOUSE_MODEL = "this GitHive has no model of its own: hosted agents start for a person signed in, on theirs";

/** The settings `payer`'s agents run on, or a failure saying how to set them. */
export async function modelSettingsFor(env: Env, payer: string | undefined): Promise<ModelSettings> {
	if (payer === HOUSE) return houseModel?.(env) ?? fail(403, NO_HOUSE_MODEL);
	if (!payer) fail(403, NO_MODEL);
	const settings = await new ModelSettingsStore(env.DB, env.MODEL_KEYS_SECRET).settings(payer);
	return settings ?? fail(403, NO_MODEL);
}

/** Whether `payer` has a model to run hosted agents on. */
export async function hasModel(env: Env, payer: string | undefined) {
	if (payer === HOUSE) return !!houseModel;
	if (!payer || !env.DB) return false;
	return !!(await new ModelSettingsStore(env.DB, env.MODEL_KEYS_SECRET).view(payer));
}
