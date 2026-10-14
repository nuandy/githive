import type { FormEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepoAccess, RepoSnapshot, SavedMergeSettings, SettingsInput } from "../api";
import { draftFrom, type MergeDraft } from "../lib/mergeSettings";
import type { SettingsSection } from "../lib/routes";
import { createDraftStore, dirtySections, draftKey } from "../lib/settingsDrafts";
import { holderOptions } from "../lib/tokens";
import { visibleText } from "../test/fixtures";
import { ChecksSection, PathRulesSection, ReviewSection, type SettingsContext, useMergeSection } from "./MergeSettings";
import type { RepoManageApi } from "./RepoAdmin";
import { RepoSettings } from "./RepoSettings";
import { problemsFor } from "./SettingsParts";

// A repo's Settings, for its admins: a page per section, each with its own save bar. Edits are held for the session,
// so a section's draft is what the store holds while it has edits.

const snapshot = (over: Partial<RepoSnapshot> = {}) =>
	({
		repo: "acme/web",
		branch: "main",
		policy: { required: 1, vetoes: ["security"], escalate: [{ paths: ["src/payments/"], vetoes: ["payments"] }] },
		verify: ["npm test"],
		claims: [],
		votes: [],
		verified: true,
		...over,
	}) as RepoSnapshot;

const context = (over: Partial<SettingsContext> = {}): SettingsContext => ({
	repo: "acme/web",
	branch: "main",
	snapshot: snapshot(),
	save: async () => ({}) as never,
	drafts: createDraftStore(),
	options: { roles: [], holders: holderOptions({ teams: [], org: "acme", agents: [] }) },
	...over,
});

const noop = async () => ({}) as never;
const manage: RepoManageApi = {
	setVisibility: noop,
	deleteRepo: noop,
	collaborators: async () => [],
	setCollaborator: noop,
	removeCollaborator: noop,
	changeSettings: noop,
};
const admin: RepoAccess = { id: "acme--web", fullName: "acme/web", level: "admin", visibility: "private" };
const settingsPage = (
	section: SettingsSection,
	over: { snapshot?: RepoSnapshot | null; drafts?: SettingsContext["drafts"] } = {},
) =>
	renderToStaticMarkup(
		<RepoSettings
			repo="acme/web"
			branch="main"
			section={section}
			snapshot={over.snapshot === undefined ? snapshot() : over.snapshot}
			access={admin}
			manage={manage}
			onAccessChanged={() => undefined}
			onDeleted={() => undefined}
			drafts={over.drafts ?? createDraftStore()}
		/>,
	);
const navOf = (html: string) => html.match(/<nav aria-label="Settings".*?<\/nav>/)![0];

describe("the checks", () => {
	it("say what the checks run in: any shell command, the tools there, the limits, and no secrets", () => {
		const html = renderToStaticMarkup(<ChecksSection {...context()} />);
		expect(html).toContain("<summary>What the checks run in</summary>");
		expect(html).toMatch(/shell command, run with bash at the top of the repo, on main/);
		expect(html).toMatch(/Node 24, npm and git/);
		expect(html).toMatch(/Up to 10 minutes per command/);
		expect(html).toMatch(/No secrets or environment variables/);
	});

	it("say why checks matter while a repo has none, and stop once it has one", () => {
		const without = renderToStaticMarkup(<ChecksSection {...context({ snapshot: snapshot({ verify: [] }) })} />);
		expect(without).toMatch(/Without checks, nothing catches two changes that merge cleanly but break together/);
		expect(renderToStaticMarkup(<ChecksSection {...context()} />)).not.toMatch(/Without checks/);
	});
});

describe("the review policy", () => {
	it("chooses roles and who may vote as them as tokens, presets in words", () => {
		const policy = { required: 1, vetoes: ["security"], grants: { security: ["person:*"] } };
		const html = renderToStaticMarkup(<ReviewSection {...context({ snapshot: snapshot({ policy }) })} />);
		expect(html).toMatch(/<input[^>]*id="settings-vetoes"[^>]*role="combobox"/);
		expect(html).toContain('aria-label="Remove security"');
		expect(html).toMatch(/<input[^>]*id="grant-security"[^>]*role="combobox"/);
		expect(html).toContain('aria-label="Remove Any person"');
		expect(visibleText(html)).not.toMatch(/comma-separated/i);
	});

	it("says what the draft means as it's edited, as readers will read it once saved", () => {
		const drafts = createDraftStore();
		const base = draftFrom(snapshot().policy, ["npm test"]);
		drafts.set(draftKey("acme/web", "merge"), {
			draft: { ...base, required: "3", vetoes: "security, privacy" },
			base,
			dirty: true,
		});
		const html = renderToStaticMarkup(<ReviewSection {...context({ drafts })} />);
		const text = visibleText(html);
		expect(text).toContain("What this means");
		expect(text).toContain("Merging needs 3 approvals; security, privacy can block");
		expect(text).toContain("privacy: people, GitHive s reviewers");
		// The edits are held, so Save is offered.
		const save = html.match(/<button[^>]*type="submit"[^>]*>/)![0];
		expect(save).not.toContain(' disabled=""');
	});

	it("names the paths each rule makes stricter, and where who may vote is set", () => {
		const text = visibleText(renderToStaticMarkup(<PathRulesSection {...context()} />));
		expect(text).toContain("Rule 1");
		expect(text).toContain("src/payments/ need 1 approval; payments can block");
		expect(text).toContain("Who may vote as a role a rule adds is set under Review");
	});

	it("shows what a save saved until the repo is read again, and keeps edits made while it saved", async () => {
		const drafts = createDraftStore();
		const key = draftKey("acme/web", "merge");
		const sent: SettingsInput[] = [];
		let answer!: (saved: SavedMergeSettings) => void;
		const saving = context({
			drafts,
			save: (input) => {
				sent.push(input);
				return new Promise((resolve) => (answer = resolve));
			},
		});
		const base = draftFrom(snapshot().policy, ["npm test"]);
		drafts.set(key, { draft: { ...base, required: "3" }, base, dirty: true });
		let form!: ReturnType<typeof useMergeSection>;
		function Review() {
			form = useMergeSection("review", saving);
			return null;
		}
		renderToStaticMarkup(<Review />);
		const done = form.submit({ preventDefault: () => undefined } as FormEvent);
		// While it saves, Checks is edited in its own section.
		const held = drafts.get<MergeDraft>(key)!;
		drafts.set(key, { ...held, draft: { ...held.draft, verify: ["npm test", "npm run lint"] } });
		answer({ policy: { ...snapshot().policy, required: 3 }, verify: ["npm test"] });
		await done;
		expect(sent).toEqual([{ required: 3, independent: false, vetoes: ["security"], grants: {} }]);
		expect(drafts.get<MergeDraft>(key)!.draft.verify).toEqual(["npm test", "npm run lint"]);
		// The repo's settings aren't read again yet: Review shows the 3 it saved, not the 2 from before.
		const required = (html: string) => html.match(/id="settings-required"[^>]*value="(\d+)"/)![1];
		expect(required(renderToStaticMarkup(<ReviewSection {...saving} />))).toBe("3");
		expect(dirtySections(drafts, "acme/web")).toEqual(new Set(["checks"]));
		// Read again, Review follows them, whatever they say.
		const now = snapshot({ policy: { ...snapshot().policy, required: 4 } });
		expect(required(renderToStaticMarkup(<ReviewSection {...saving} snapshot={now} />))).toBe("4");
	});

	it("puts a field's problem under it, tied to it and marking it", () => {
		const problems = [{ field: "rule-0-paths", text: "Rule 1 names no paths." }];
		const { attrs, line } = problemsFor(problems, "rule-0-paths", "rule-0-hint");
		expect(attrs).toEqual({ "aria-invalid": true, "aria-describedby": "rule-0-hint rule-0-paths-problem" });
		expect(renderToStaticMarkup(<>{line}</>)).toMatch(
			/<p id="rule-0-paths-problem"[^>]*text-bad[^>]*>.*Rule 1 names no paths\./,
		);
		expect(problemsFor(problems, "settings-required").attrs).toEqual({
			"aria-invalid": undefined,
			"aria-describedby": undefined,
		});
	});
});

describe("an admin's Settings", () => {
	it("has a page per section, from a nav that marks the one shown", () => {
		const html = settingsPage("branch-rules");
		const nav = navOf(html);
		expect(visibleText(nav).trim()).toBe("General access Review Path rules Branch rules Checks GitHub Danger zone");
		expect(nav).toContain('href="#/repos/acme/web/settings"');
		expect(nav).toMatch(/href="#\/repos\/acme\/web\/settings\/branch-rules" aria-current="page"/);
		expect(html).toContain('id="settings-branch-rules-title"');
		expect(html).not.toContain('id="settings-review-title"');
	});

	it("puts a dot by each section with edits not saved", () => {
		const drafts = createDraftStore();
		const base = draftFrom(snapshot().policy, ["npm test"]);
		drafts.set(draftKey("acme/web", "merge"), { draft: { ...base, verify: [] }, base, dirty: true });
		const nav = visibleText(navOf(settingsPage("general", { drafts })));
		expect(nav).toMatch(/Checks , edits not saved/);
		expect(nav).not.toMatch(/Review , edits/);
	});

	it("folds how the records are kept away under General & access, and says what applies at once", () => {
		const html = settingsPage("general");
		expect(html).toMatch(/<details class="disclosure[^"]*"><summary>How the records are kept<\/summary>/);
		expect(visibleText(html)).toContain("A change to its visibility or to a collaborator applies at once.");
	});

	it("shows a repo GitHive hasn't started on only who may do what, and deleting it", () => {
		const html = settingsPage("general", { snapshot: null });
		expect(visibleText(navOf(html)).trim()).toBe("General access Danger zone");
		expect(html).not.toContain("How the records are kept");
		expect(visibleText(settingsPage("review", { snapshot: null }))).toContain(
			"Review shows once GitHive starts on acme/web",
		);
	});

	it("titles every section the same way, started or not", () => {
		for (const html of [settingsPage("general"), settingsPage("general", { snapshot: null }), settingsPage("review")])
			expect(html).toMatch(/<h2 data-slot="box-title" class="text-title-sm leading-6 font-semibold" id="settings-/);
	});
});
