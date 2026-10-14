import { describe, expect, it } from "vitest";
import { draftFrom, settingsFrom } from "./mergeSettings";
import {
	addTyped,
	ANY_PERSON,
	enterChoice,
	GITHIVE_REVIEWERS,
	holderLabel,
	holderOptions,
	resolveHolder,
	roleOptions,
	roleProblem,
	suggest,
	textOf,
	tokensOf,
} from "./tokens";

// The review policy's lists (roles that can block, who may vote as them) are chosen as tokens rather than typed as
// comma-separated text. What's saved is what the server always took: the same strings, in the same lists.

describe("tokens", () => {
	it("read a list from the form's text, and write it back in the same words", () => {
		expect(tokensOf("security, api-design\nops,,security ")).toEqual(["security", "api-design", "ops"]);
		expect(tokensOf("")).toEqual([]);
		expect(textOf(["person:*", "githive"])).toBe("person:*, githive");
		expect(textOf(tokensOf("person:*, githive"))).toBe("person:*, githive");
	});

	it("add what's typed, split at commas, without repeats, as the value a label stands for", () => {
		expect(addTyped(["security"], " ops, security ,")).toEqual(["security", "ops"]);
		expect(addTyped([], "   ")).toEqual([]);
		expect(addTyped([], "Any person", resolveHolder)).toEqual(["person:*"]);
		expect(addTyped(["person:*"], "githive's reviewers", resolveHolder)).toEqual(["person:*", "githive"]);
	});

	it("save the very strings the settings tool takes", () => {
		const policy = { required: 1, vetoes: ["security"], grants: { security: ["@acme/security"] } };
		const draft = draftFrom(policy, []);
		const grants = addTyped(tokensOf(draft.grants.security!), "Any person", resolveHolder);
		const vetoes = addTyped(tokensOf(draft.vetoes), "payments");
		const edited = { ...draft, vetoes: textOf(vetoes), grants: { security: textOf(grants) } };
		expect(settingsFrom(edited).settings).toMatchObject({
			vetoes: ["security", "payments"],
			grants: { security: ["@acme/security", "person:*"] },
		});
	});
});

describe("who may vote as a role", () => {
	it("is offered from presets, the org's teams and your agents", () => {
		const options = holderOptions({
			teams: [{ slug: "payments", name: "Payments" }],
			org: "acme",
			agents: [{ name: "builder" }, { name: "old", revoked: true }],
		});
		expect(options.map((option) => [option.value, option.label])).toEqual([
			[ANY_PERSON, "Any person"],
			[GITHIVE_REVIEWERS, "GitHive's reviewers"],
			["@acme/payments", "@acme/payments"],
			["builder", "builder"],
		]);
		expect(options[2]!.detail).toBe("Team: Payments");
		expect(options[3]!.detail).toBe("Your agent");
	});

	it("names the presets in words, and anything else as it's written", () => {
		expect(holderLabel("person:*")).toBe("Any person");
		expect(holderLabel("githive")).toBe("GitHive's reviewers");
		expect(holderLabel("@acme/payments")).toBe("@acme/payments");
		expect(holderLabel("service:ci/*")).toBe("Any agent under service:ci");
		expect(resolveHolder("any PERSON")).toBe("person:*");
		expect(resolveHolder("reviewer-2")).toBe("reviewer-2");
	});

	it("suggests what matches what's typed, by its words or its value, leaving out what's chosen", () => {
		const options = holderOptions({ teams: [{ slug: "payments", name: null }], org: "acme", agents: [] });
		expect(suggest(options, "", ["githive"]).map((option) => option.value)).toEqual(["person:*", "@acme/payments"]);
		expect(suggest(options, "pay", []).map((option) => option.value)).toEqual(["@acme/payments"]);
		expect(suggest(options, "person", []).map((option) => option.value)).toEqual(["person:*"]);
		// What starts with what's typed comes first.
		expect(suggest(options, "g", []).map((option) => option.value)).toEqual(["githive"]);
	});

	it("adds what's typed on Enter: an option only once the arrows light it, or when it's typed in full", () => {
		const options = roleOptions(["payments", "security"], []);
		// "pay" stays "pay", though payments is offered first.
		expect(enterChoice("pay", options, undefined)).toBe("pay");
		expect(enterChoice("pay", options, options[0])).toBe("payments");
		expect(enterChoice(" Security ", options, undefined)).toBe("security");
		const holders = holderOptions({ teams: [], org: "acme", agents: [] });
		expect(enterChoice("any person", holders, undefined)).toBe(ANY_PERSON);
		// Nothing typed or lit: Enter submits the form.
		expect(enterChoice("  ", options, undefined)).toBeNull();
	});
});

describe("roles that can block", () => {
	it("are offered from the roles the repo uses and the org's teams", () => {
		const options = roleOptions(["security", "payments"], [{ slug: "frontend", name: "Frontend" }], "acme");
		expect(options.map((option) => option.value)).toEqual(["security", "payments", "frontend"]);
		expect(options[2]!.detail).toBe("Named after the team @acme/frontend");
		expect(roleOptions(["security"], [{ slug: "security", name: null }]).map((option) => option.value)).toEqual([
			"security",
		]);
	});

	it("say how to fix a name that isn't a role's", () => {
		expect(roleProblem("api-design")).toBeNull();
		expect(roleProblem("Security Team")).toBe(
			'"Security Team" isn\'t a role name: use lowercase words joined by hyphens, like "security" or "api-design".',
		);
	});
});
