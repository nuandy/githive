import { describe, expect, it } from "vitest";
import { blockingRolesOf, draftFrom, settingsFrom } from "./mergeSettings";

describe("the merge settings form", () => {
	const policy = { required: 1, vetoes: ["security"], escalate: [{ paths: ["package.json", ".github/"], required: 2, vetoes: ["ops"] }], grants: { security: ["@acme/security", "githive"] } };

	it("gives back what it was given, untouched", () => {
		expect(settingsFrom(draftFrom(policy, ["npm ci", "npm test"], ["*.md", "docs/"]))).toEqual({
			settings: { required: 1, vetoes: ["security"], escalate: [{ paths: ["package.json", ".github/"], required: 2, vetoes: ["ops"] }], grants: { security: ["@acme/security", "githive"] }, verify: ["npm ci", "npm test"], skip_checks: ["*.md", "docs/"] },
			errors: [],
		});
	});

	it("reads lists from commas or lines, and drops blanks and repeats", () => {
		const draft = { ...draftFrom(policy, []), vetoes: "security, ops,,security", verify: ["  npm test ", "", "npm run lint"] };
		draft.escalate[0].paths = "package.json\n\n.github/, Dockerfile";
		const { settings } = settingsFrom(draft);
		expect(settings).toMatchObject({ vetoes: ["security", "ops"], verify: ["npm test", "npm run lint"], escalate: [{ paths: ["package.json", ".github/", "Dockerfile"] }] });
	});

	it("keeps grants only for roles that can still block, a blank one meaning the default", () => {
		const draft = { ...draftFrom(policy, []), vetoes: "", grants: { security: "@acme/security", ops: "" } };
		expect(blockingRolesOf(draft)).toEqual(["ops"]);
		expect(settingsFrom(draft).settings?.grants).toEqual({});
	});

	it("says what's wrong instead of saving", () => {
		const draft = { ...draftFrom(policy, []), required: "two", vetoes: "Security Team" };
		draft.escalate.push({ paths: "", required: "x", vetoes: "" });
		expect(settingsFrom(draft).errors).toEqual([
			"Required approvals is a whole number, 0 for none.",
			'"Security Team" isn\'t a role name: use lowercase words joined by hyphens, like "security" or "api-design".',
			"Rule 2 names no paths.",
			"Rule 2's approvals is a whole number, or blank for the repo's own.",
		]);
	});

	it("leaves a rule's approvals out when blank: the repo's own", () => {
		const draft = draftFrom(policy, []);
		draft.escalate[0].required = "";
		expect(settingsFrom(draft).settings?.escalate).toEqual([{ paths: ["package.json", ".github/"], vetoes: ["ops"] }]);
	});

	it("keeps the server's skip list when it didn't send one, so saving never turns skipping off unasked", async () => {
		const { DEFAULT_SKIP_CHECKS } = await import("../../../src/toolkit/check-scope");
		expect(settingsFrom(draftFrom(policy, ["npm test"])).settings?.skip_checks).toEqual(DEFAULT_SKIP_CHECKS);
		expect(settingsFrom({ ...draftFrom(policy, ["npm test"]), skipChecks: "" }).settings?.skip_checks).toEqual([]);
	});
});
