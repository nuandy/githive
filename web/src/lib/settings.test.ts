import { describe, expect, it } from "vitest";
import { describePolicy, draftFromSettings, draftRoles, removeRole, settingsFromDraft, splitList } from "./settings";

const settings = {
	review: {
		reviewers: ["review", "security"],
		required: 1,
		vetoes: ["security"],
		external: ["review"],
		escalate: [{ paths: ["package.json", ".github/"], reviewers: ["supply-chain"], required: 2, vetoes: ["supply-chain"] }],
		externalWaitMinutes: 90,
	},
	verify: ["npm test"],
	leaseMinutes: 45,
};

describe("the settings form", () => {
	it("round-trips the saved settings through the form unchanged", () => {
		const draft = draftFromSettings(settings);
		expect(draft).toMatchObject({ required: "1", leaseMinutes: "45", externalWaitMinutes: "90", escalate: [{ paths: "package.json\n.github/", reviewers: "supply-chain", required: "2", vetoes: "supply-chain" }] });
		expect(settingsFromDraft(draft)).toEqual({ settings, errors: [] });
	});

	it("fills defaults for a repo that never set them", () => {
		const draft = draftFromSettings({ review: { reviewers: ["review"], required: 1, vetoes: [] }, verify: [] });
		expect(draft.leaseMinutes).toBe("30");
		expect(settingsFromDraft(draft).settings).toEqual({ review: { reviewers: ["review"], required: 1, vetoes: [] }, verify: [], leaseMinutes: 30 });
	});

	it("drops a removed role's marks, and keeps outside review only for roles that exist", () => {
		const draft = removeRole(draftFromSettings(settings), "security");
		expect(draft).toMatchObject({ reviewers: ["review"], vetoes: [], external: ["review"] });
		expect(draftRoles(draft)).toEqual(["review", "supply-chain"]);
		const result = settingsFromDraft({ ...draft, external: ["review", "ghost", "supply-chain"] });
		expect(result.settings?.review.external).toEqual(["review", "supply-chain"]);
	});

	it("drops empty check lines and trims commands", () => {
		const result = settingsFromDraft({ ...draftFromSettings(settings), verify: ["  npm test ", "", "npm run lint"] });
		expect(result.settings?.verify).toEqual(["npm test", "npm run lint"]);
	});

	it("explains what's wrong before anything is sent", () => {
		const draft = draftFromSettings(settings);
		expect(settingsFromDraft({ ...draft, required: "3" }).errors).toEqual(["Required approvals must be a whole number from 0 to 2."]);
		expect(settingsFromDraft({ ...draft, required: "1.5" }).errors).toHaveLength(1);
		expect(settingsFromDraft({ ...draft, leaseMinutes: "2" }).errors).toEqual(["Claim expiry must be a whole number of minutes from 5 to 1440."]);
		expect(settingsFromDraft({ ...draft, externalWaitMinutes: "3000" }).errors[0]).toMatch(/from 5 to 1440/);
		expect(settingsFromDraft({ ...draft, reviewers: ["Security Team", "review"] }).errors[0]).toMatch(/Security Team/);
		expect(settingsFromDraft({ ...draft, escalate: [{ paths: " ", reviewers: "", required: "x", vetoes: "" }] }).errors).toEqual([
			"Path rule 1 needs at least one path.",
			"Path rule 1: required approvals must be a whole number.",
		]);
	});

	it("splits lists on commas and lines, and describes a policy", () => {
		expect(splitList("a, b\n c,,")).toEqual(["a", "b", "c"]);
		expect(describePolicy(settings.review)).toBe("1 approval from review, security; security must approve and can block");
		expect(describePolicy({ reviewers: [], required: 0, vetoes: [] })).toBe("No approvals needed; the checks decide");
	});
});
