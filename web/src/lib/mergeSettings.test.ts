import { describe, expect, it } from "vitest";
import {
	blockingRolesOf,
	draftFrom,
	partDirty,
	partInput,
	previewPolicy,
	problemsOf,
	rebase,
	settingsFrom,
} from "./mergeSettings";

describe("the merge settings form", () => {
	const policy = {
		required: 1,
		vetoes: ["security"],
		escalate: [{ paths: ["package.json", ".github/"], required: 2, vetoes: ["ops"] }],
		grants: { security: ["@acme/security", "githive"] },
	};

	it("gives back what it was given, untouched", () => {
		expect(settingsFrom(draftFrom(policy, ["npm ci", "npm test"], ["*.md", "docs/"]))).toEqual({
			settings: {
				required: 1,
				independent: false,
				vetoes: ["security"],
				escalate: [{ paths: ["package.json", ".github/"], required: 2, vetoes: ["ops"] }],
				grants: { security: ["@acme/security", "githive"] },
				verify: ["npm ci", "npm test"],
				skip_checks: ["*.md", "docs/"],
			},
			errors: [],
		});
	});

	it("reads lists from commas or lines, and drops blanks and repeats", () => {
		const draft = {
			...draftFrom(policy, []),
			vetoes: "security, ops,,security",
			verify: ["  npm test ", "", "npm run lint"],
		};
		draft.escalate[0]!.paths = "package.json\n\n.github/, Dockerfile";
		const { settings } = settingsFrom(draft);
		expect(settings).toMatchObject({
			vetoes: ["security", "ops"],
			verify: ["npm test", "npm run lint"],
			escalate: [{ paths: ["package.json", ".github/", "Dockerfile"] }],
		});
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
		draft.escalate[0]!.required = "";
		expect(settingsFrom(draft).settings?.escalate).toEqual([{ paths: ["package.json", ".github/"], vetoes: ["ops"] }]);
	});

	it("keeps the server's skip list when it didn't send one, so saving never turns skipping off unasked", async () => {
		const { DEFAULT_SKIP_CHECKS } = await import("../../../src/toolkit/check-scope");
		expect(settingsFrom(draftFrom(policy, ["npm test"])).settings?.skip_checks).toEqual(DEFAULT_SKIP_CHECKS);
		expect(settingsFrom({ ...draftFrom(policy, ["npm test"]), skipChecks: "" }).settings?.skip_checks).toEqual([]);
	});

	it("keeps independent review on, and sends it off once unticked", () => {
		const draft = draftFrom({ ...policy, independent: true }, []);
		expect(draft.independent).toBe(true);
		expect(settingsFrom(draft).settings).toMatchObject({ independent: true });
		expect(settingsFrom({ ...draft, independent: false }).settings).toMatchObject({ independent: false });
	});
});

describe("the merge settings, a section at a time", () => {
	const policy = {
		required: 1,
		vetoes: ["security"],
		escalate: [{ paths: ["package.json"], vetoes: ["ops"] }],
		grants: { security: ["@acme/security"], ops: ["githive"] },
	};
	const base = draftFrom(policy, ["npm test"], ["*.md"]);

	it("puts each problem under its field", () => {
		const draft = { ...base, required: "two", vetoes: "Security Team", skipChecks: "a b" };
		draft.escalate = [{ paths: "", required: "x", vetoes: "Ops!" }];
		expect(problemsOf(draft)).toEqual([
			{ part: "review", field: "settings-required", text: "Required approvals is a whole number, 0 for none." },
			{
				part: "review",
				field: "settings-vetoes",
				text: '"Security Team" isn\'t a role name: use lowercase words joined by hyphens, like "security" or "api-design".',
			},
			{ part: "path-rules", field: "rule-0-paths", text: "Rule 1 names no paths." },
			{
				part: "path-rules",
				field: "rule-0-required",
				text: "Rule 1's approvals is a whole number, or blank for the repo's own.",
			},
			{
				part: "path-rules",
				field: "rule-0-vetoes",
				text: '"Ops!" isn\'t a role name: use lowercase words joined by hyphens, like "security" or "api-design".',
			},
			{
				part: "checks",
				field: "skip-checks",
				text: '"a b" isn\'t a pattern: a path or name, with * for any run of characters (*.md, docs/).',
			},
		]);
	});

	it("is dirty only where it was edited", () => {
		const draft = { ...base, required: "2" };
		expect(partDirty("review", draft, base)).toBe(true);
		expect(partDirty("path-rules", draft, base)).toBe(false);
		expect(partDirty("checks", draft, base)).toBe(false);
		expect(partDirty("checks", { ...base, verify: ["npm test", "npm run lint"] }, base)).toBe(true);
	});

	it("saves only its own fields, keeping who may vote as a role the saved rules still use", () => {
		const draft = { ...base, required: "2", vetoes: "security, privacy", escalate: [] };
		draft.grants = { ...draft.grants, privacy: "person:*" };
		expect(partInput("review", draft, base)).toEqual({
			input: {
				required: 2,
				independent: false,
				vetoes: ["security", "privacy"],
				// ops still blocks in the rules as saved, though this draft's rules drop it.
				grants: { security: ["@acme/security"], privacy: ["person:*"], ops: ["githive"] },
			},
			problems: [],
		});
		expect(partInput("path-rules", draft, base)).toEqual({ input: { escalate: [] }, problems: [] });
		expect(partInput("checks", draft, base)).toEqual({
			input: { verify: ["npm test"], skip_checks: ["*.md"] },
			problems: [],
		});
		expect(partInput("review", { ...draft, required: "x" }, base).problems).toHaveLength(1);
		// Another section's problem doesn't stop this one saving.
		expect(partInput("checks", { ...draft, required: "x" }, base).problems).toEqual([]);
	});

	it("drops who may vote as a role Review no longer has block, unless the saved rules still use it", () => {
		const draft = { ...base, vetoes: "" };
		// security blocked repo-wide as saved, and no rule uses it: its grant goes with it, as it did before sections.
		expect(partInput("review", draft, base).input).toEqual({
			required: 1,
			independent: false,
			vetoes: [],
			grants: { ops: ["githive"] },
		});
		const ruled = { ...base, escalate: [{ paths: "src/", required: "", vetoes: "security" }] };
		expect(partInput("review", { ...ruled, vetoes: "" }, ruled).input?.grants).toEqual({
			security: ["@acme/security"],
		});
	});

	it("after a save, takes the server's settings where they weren't being edited, keeping edits elsewhere", () => {
		const editing = { ...base, required: "3", verify: ["npm test", "npm run lint"] };
		const saved = draftFrom({ ...policy, required: 3, escalate: [] }, ["npm test"], ["*.md"]);
		const next = rebase(editing, base, saved, "review");
		expect(next.required).toBe("3");
		// Path rules weren't being edited: they follow the server.
		expect(next.escalate).toEqual([]);
		// Checks were: the edits stay, still unsaved.
		expect(next.verify).toEqual(["npm test", "npm run lint"]);
		expect(partDirty("checks", next, saved)).toBe(true);
	});

	it("words the draft as a policy, as far as it reads, for what it means", () => {
		const draft = { ...base, required: "2", vetoes: "security, Bad Role" };
		expect(previewPolicy(draft)).toEqual({
			required: 2,
			vetoes: ["security"],
			escalate: [{ paths: ["package.json"], vetoes: ["ops"] }],
			grants: { security: ["@acme/security"], ops: ["githive"] },
		});
		expect(previewPolicy({ ...draft, required: "" }).required).toBe(0);
	});
});
