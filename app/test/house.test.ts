import { describe, expect, it } from "vitest";
import { HOUSE, hasModel, modelSettingsFor } from "../../src/models/payer";
import { houseModel } from "../house";

// githive.app's own runs (demo runs, and its operators at the admin door) are on gpt-6-luna under the house key.

describe("the house model", () => {
	it("is gpt-6-luna on the house key, once the Worker has loaded", async () => {
		await import("../worker");
		const env = { OPENAI_API_KEY: "sk-house" } as never;
		expect(await hasModel(env, HOUSE)).toBe(true);
		expect(await modelSettingsFor(env, HOUSE)).toEqual({ provider: "openai", model: "gpt-6-luna", apiKey: "sk-house" });
	});

	it("says so when the house key isn't set", () => {
		expect(() => houseModel({} as never)).toThrow(/OPENAI_API_KEY isn't set/);
	});
});
