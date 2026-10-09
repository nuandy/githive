import { describe, expect, it } from "vitest";
import { branchRulesFrom, emptyRule, ruleDraftsFrom } from "./branchRules";

// Branch rules in the Settings tab: a blank field keeps the repo's setting.

describe("branch rule drafts", () => {
	it("round-trip the rules the server keeps", () => {
		const rules = [
			{ pattern: "feature/*", policy: { required: 0 }, verify: [] },
			{ pattern: "release/*", policy: { vetoes: ["release"], grants: { release: ["person:*"] } } },
			{ pattern: "docs/*", verify: ["npm run lint"] },
		];
		const drafts = ruleDraftsFrom(rules);
		expect(drafts.map((d) => [d.pattern, d.required, d.vetoes, d.grants, d.checks])).toEqual([
			["feature/*", "0", "", "", "none"],
			["release/*", "", "release", "person:*", "repo"],
			["docs/*", "", "", "", "these"],
		]);
		expect(branchRulesFrom(drafts)).toEqual({
			rules: [
				{ pattern: "feature/*", required: 0, verify: [] },
				{ pattern: "release/*", vetoes: ["release"], grants: { release: ["person:*"] } },
				{ pattern: "docs/*", verify: ["npm run lint"] },
			],
			errors: [],
		});
	});

	it("say what's wrong: a bad pattern, a rule that changes nothing, voters without roles", () => {
		const { errors } = branchRulesFrom([{ ...emptyRule(), pattern: "feature x", required: "1" }, { ...emptyRule(), pattern: "hotfix/*" }, { ...emptyRule(), pattern: "r/*", grants: "person:*" }]);
		expect(errors).toEqual([
			"feature x: the pattern is a branch name, with * for any run of characters (feature/*).",
			"hotfix/* changes nothing: set approvals, roles or checks, or remove it.",
			"r/*: say which roles can block before who may vote as them.",
			"r/* changes nothing: set approvals, roles or checks, or remove it.",
		]);
	});
});
