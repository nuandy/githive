import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MyOrg, OrgDetail, RepoAccess } from "../api";
import { repoSnapshot, stubApi, visibleText } from "../test/fixtures";
import { newRepoInput, NewRepoView } from "./NewRepoPage";
import { promotionQuestion, roleMeans } from "./OrgMembers";
import { type OrgActions, OrgView } from "./OrgPage";
import { OrgsView } from "./OrgsPage";
import {
	adminQuestion,
	DangerZone,
	GeneralSection,
	RepoAccessBox,
	type RepoManageApi,
	VisibilityToggle,
} from "./RepoAdmin";
import { RepoPage } from "./RepoPage";

const noop = async () => ({}) as never;
const orgActions: OrgActions = {
	updateOrg: noop,
	addMember: noop,
	setRole: noop,
	removeMember: noop,
	cancelInvite: noop,
	createTeam: noop,
	deleteTeam: noop,
	addTeamMember: noop,
	removeTeamMember: noop,
};
const manageApi: RepoManageApi = {
	setVisibility: noop,
	deleteRepo: noop,
	collaborators: async () => [],
	setCollaborator: noop,
	removeCollaborator: noop,
};

/** Ada's own namespace, as her org list shows it. */
const ADA: MyOrg = {
	id: "p",
	slug: "ada",
	name: null,
	personal: true,
	defaultPermission: "admin",
	membersCanCreateRepos: false,
	role: "owner",
};
/** Acme in someone's org list, where they have `role`. */
const acmeMembership = (role: MyOrg["role"]): MyOrg => ({
	id: "o1",
	slug: "acme",
	name: "Acme",
	personal: false,
	defaultPermission: "write",
	membersCanCreateRepos: true,
	role,
});
const acme = (role: OrgDetail["role"], extra: Partial<OrgDetail> = {}): OrgDetail => ({
	id: "o1",
	slug: "acme",
	name: "Acme",
	personal: false,
	defaultPermission: "write",
	membersCanCreateRepos: true,
	role,
	canCreateRepos: role !== null,
	repos: [{ id: "acme--web", org: "acme", name: "web", fullName: "acme/web", visibility: "private", createdAt: "" }],
	members: role
		? [
				{ userId: "u1", handle: "ada", name: "Ada", avatarUrl: null, role: "owner" },
				{ userId: "u2", handle: "bob", name: null, avatarUrl: null, role: "member" },
			]
		: [],
	teams: role ? [{ id: "t1", slug: "security", name: null, members: ["bob"] }] : [],
	invites: role === "owner" || role === "admin" ? [{ email: "dan@example.com", role: "member", createdAt: "" }] : [],
	...extra,
});

describe("a new repository", () => {
	const orgs: MyOrg[] = [
		ADA,
		acmeMembership("member"),
		{
			id: "o2",
			slug: "strict",
			name: null,
			personal: false,
			defaultPermission: "write",
			membersCanCreateRepos: false,
			role: "member",
		},
	];

	it("offers your own namespace and the orgs you may create in, starting with the one asked for", () => {
		const html = renderToStaticMarkup(
			<NewRepoView orgs={orgs} repos={[]} owner="acme" create={noop} onCreated={() => {}} />,
		);
		expect(html).toContain('<option value="ada">ada (you)</option>');
		expect(html).toContain('<option value="acme" selected="">acme</option>');
		expect(html).not.toContain('value="strict"');
		expect(visibleText(html)).toContain("Make repository");
	});

	it("sends only what its source needs", () => {
		const base = {
			owner: "acme",
			name: " web ",
			url: " https://g.test/x ",
			branch: "",
			copyFrom: "acme/old",
			visibility: "private" as const,
		};
		expect(newRepoInput({ ...base, source: "import" })).toEqual({
			owner: "acme",
			name: "web",
			visibility: "private",
			import_url: "https://g.test/x",
		});
		expect(newRepoInput({ ...base, source: "import", branch: "dev" })).toMatchObject({ branch: "dev" });
		// A private repo's token goes with an import, trimmed, and never with a copy.
		expect(newRepoInput({ ...base, source: "import", token: " github_pat_x " })).toMatchObject({
			import_token: "github_pat_x",
		});
		expect(newRepoInput({ ...base, source: "copy", token: "github_pat_x" })).not.toHaveProperty("import_token");
		expect(newRepoInput({ ...base, source: "copy" })).toEqual({
			owner: "acme",
			name: "web",
			visibility: "private",
			copy_from: "acme/old",
		});
		// A fresh repo gets a README by default, plus whatever else was chosen. It is empty only if nothing was.
		expect(newRepoInput({ ...base, source: "empty" })).toEqual({
			owner: "acme",
			name: "web",
			visibility: "private",
			init: { readme: true },
		});
		expect(
			newRepoInput({
				...base,
				source: "empty",
				first: { readme: true, description: " Docs ", gitignore: "python", license: "mit" },
			}),
		).toMatchObject({ init: { readme: true, description: "Docs", gitignore: "python", license: "mit" } });
		expect(
			newRepoInput({
				...base,
				source: "empty",
				first: { readme: false, description: "ignored", gitignore: "rust", license: "" },
			}),
		).toMatchObject({ init: { gitignore: "rust" } });
		expect(
			newRepoInput({ ...base, source: "empty", first: { readme: false, description: "", gitignore: "", license: "" } }),
		).toEqual({ owner: "acme", name: "web", visibility: "private" });
	});
});

describe("your organizations", () => {
	it("lists your own repositories first, never as an org, then your orgs, and offers making one", () => {
		const orgs: MyOrg[] = [ADA, acmeMembership("admin")];
		const text = visibleText(
			renderToStaticMarkup(<OrgsView me={{ handle: "ada" }} orgs={orgs} createOrg={noop} onCreated={() => {}} />),
		);
		expect(text).toContain("ada your repositories");
		expect(text).toContain("acme Acme admin");
		expect(text).toContain("Create an organization");
	});

	it("marks an org with a building, not a repository's book", () => {
		const html = renderToStaticMarkup(
			<OrgsView me={{ handle: "ada" }} orgs={[ADA, acmeMembership("admin")]} createOrg={noop} onCreated={() => {}} />,
		);
		const acmeRow = html.slice(html.indexOf('href="#/orgs/acme"') - 600, html.indexOf('href="#/orgs/acme"'));
		expect(acmeRow).toContain("M6 22V4");
		expect(acmeRow).not.toContain("M4 19.5v-15");
	});
});

describe("an organization's page", () => {
	it("lets owners manage people, invitations, teams and settings", () => {
		const html = renderToStaticMarkup(
			<OrgView org={acme("owner")} me={{ handle: "ada" }} actions={orgActions} onLeft={() => {}} />,
		);
		const text = visibleText(html);
		expect(text).toContain("People");
		expect(text).toContain("dan@example.com");
		expect(text).toContain("Cancel invitation");
		expect(text).toContain("@acme/security");
		expect(text).toContain("New team");
		expect(text).toContain("Settings");
		expect(html).toContain('id="role-bob"');
		// You don't change your own role here, and the last owner can't leave.
		expect(html).not.toContain('id="role-ada"');
		expect(text).not.toContain("Leave");
	});

	it("labels the fields that add people and teams, at the end of their lists", () => {
		const html = renderToStaticMarkup(
			<OrgView org={acme("owner")} me={{ handle: "ada" }} actions={orgActions} onLeft={() => {}} />,
		);
		for (const [id, label] of [
			["add-member-email", "Email"],
			["add-member-role", "Role"],
			["new-team-slug", "Team name"],
			["new-team-name", "Display name (optional)"],
			["team-add-security", "Add to @acme/security"],
		] as const)
			expect(html).toMatch(new RegExp(`<label[^>]*for="${id}">${label.replace(/[()]/g, "\\$&")}</label>`));
		expect(html).not.toContain('placeholder="person@example.com"');
		expect(html).not.toContain('placeholder="security"');
		// Each add-form comes after the rows it adds to.
		expect(html.indexOf("dan@example.com")).toBeLessThan(html.indexOf('for="add-member-email"'));
		expect(html.indexOf("@acme/security")).toBeLessThan(html.indexOf('for="new-team-slug"'));
		// What the role chosen lets them do.
		expect(visibleText(html)).toContain("Member: Write in its repositories");
	});

	it("keeps a badge on an invitation that waits on GitHive's approval", () => {
		const waiting = acme("owner", {
			invites: [{ email: "dan@example.com", role: "member", createdAt: "", awaitingApproval: true }],
		});
		const text = visibleText(
			renderToStaticMarkup(<OrgView org={waiting} me={{ handle: "ada" }} actions={orgActions} onLeft={() => {}} />),
		);
		expect(text).toContain("dan@example.com Waiting for GitHive approval");
		expect(text).toContain("joins once a GitHive admin approves them");
		expect(
			visibleText(
				renderToStaticMarkup(
					<OrgView org={acme("owner")} me={{ handle: "ada" }} actions={orgActions} onLeft={() => {}} />,
				),
			),
		).not.toContain("Waiting for GitHive approval");
	});

	it("asks before making someone an admin or owner, saying what they'll be able to do", () => {
		expect(promotionQuestion("sol", "acme", "owner")).toBe(
			"Make sol an owner of acme? Owners can delete any of its repositories, and remove anyone, other owners too.",
		);
		expect(promotionQuestion("sol", "acme", "admin")).toMatch(/^Make sol an admin of acme\? Admins can delete/);
		expect(roleMeans("admin", { defaultPermission: "write" })).toMatch(/^Admin: add and remove people/);
		// A repo's collaborator too.
		expect(adminQuestion("sol", "acme/storefront")).toBe(
			"Make sol an admin of acme/storefront? Admins change settings and collaborators, and can delete the repo.",
		);
	});

	it("shows members the people and teams, without managing, and lets them leave", () => {
		const text = visibleText(
			renderToStaticMarkup(
				<OrgView org={acme("member")} me={{ handle: "bob" }} actions={orgActions} onLeft={() => {}} />,
			),
		);
		expect(text).toContain("People");
		expect(text).toContain("@acme/security");
		expect(text).not.toContain("Cancel invitation");
		expect(text).not.toContain("New team");
		expect(text).not.toContain("Settings");
		expect(text).toContain("Leave");
	});

	it("shows outsiders only the repositories they can see", () => {
		const text = visibleText(
			renderToStaticMarkup(
				<OrgView org={acme(null, { repos: [] })} me={{ handle: "eve" }} actions={orgActions} onLeft={() => {}} />,
			),
		);
		expect(text).toContain("None that you can see.");
		expect(text).not.toContain("People");
		expect(text).not.toContain("Teams");
	});

	it("calls your own namespace your repositories, with no members or teams", () => {
		const own = acme("owner", {
			slug: "ada",
			personal: true,
			members: [{ userId: "u1", handle: "ada", name: null, avatarUrl: null, role: "owner" }],
			teams: [],
			invites: [],
		});
		const text = visibleText(
			renderToStaticMarkup(<OrgView org={own} me={{ handle: "ada" }} actions={orgActions} onLeft={() => {}} />),
		);
		expect(text).toContain("Your repositories");
		expect(text).not.toContain("People");
		expect(text).not.toMatch(/organization/i);
	});
});

describe("a repo's access settings", () => {
	const access = (level: RepoAccess["level"]): RepoAccess => ({
		id: "acme--web",
		fullName: "acme/web",
		level,
		visibility: "private",
	});

	it("gives admins visibility and collaborators under General, and deleting in the Danger zone", () => {
		const html = renderToStaticMarkup(
			<GeneralSection repo="acme/web" access={access("admin")} manage={manageApi} onChanged={() => {}} />,
		);
		const text = visibleText(html);
		expect(text).toContain("Admin: write, and change settings");
		expect(text).toContain("Make public");
		expect(text).toContain("Collaborators");
		// The form that adds a collaborator labels its fields, and says what the permission chosen lets them do.
		expect(html).toMatch(/<label[^>]*for="collab-handle">Their handle<\/label>/);
		expect(html).toMatch(/<label[^>]*for="collab-level">Permission<\/label>/);
		expect(html).not.toContain("placeholder=");
		expect(text).toContain("Write: review, and claim, push and merge changes.");
		const danger = renderToStaticMarkup(<DangerZone repo="acme/web" deleteRepo={noop} onDeleted={() => {}} />);
		expect(visibleText(danger)).toContain("Delete this repository");
		// Deleting asks in a dialog, which wants the repo's name typed.
		expect(danger).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>Delete repository…<\/button>/);
	});

	describe("its visibility", () => {
		const rest = {
			manage: manageApi,
			onChanged: () => {},
			setConfirming: () => {},
			run: async () => true,
			busy: null,
			errorFor: () => null,
		};

		it("names the visibility action and asks before making a repo public", () => {
			const text = visibleText(
				renderToStaticMarkup(
					<VisibilityToggle repo="acme/docs" visibility="private" confirming="visibility" {...rest} />,
				),
			);
			expect(text).toContain("Make acme/docs public? Anyone signed in to GitHive can read its code and history.");
			expect(text).toContain("Yes, make public");
			expect(text).toContain("Keep private");
		});

		it("offers making a private repo public by name, before asking", () => {
			const text = visibleText(
				renderToStaticMarkup(<VisibilityToggle repo="acme/docs" visibility="private" confirming={null} {...rest} />),
			);
			expect(text).toContain("Make public");
			expect(text).not.toContain("?");
		});

		it("makes a public repo private without asking", () => {
			const text = visibleText(
				renderToStaticMarkup(<VisibilityToggle repo="acme/docs" visibility="public" confirming={null} {...rest} />),
			);
			expect(text).toContain("Make private");
			expect(text).not.toContain("?");
		});
	});

	it("shows everyone else what they may do, and nothing to change", () => {
		const text = visibleText(renderToStaticMarkup(<RepoAccessBox repo="acme/web" access={access("write")} />));
		expect(text).toContain("Write: review, and claim, push and merge changes");
		expect(text).toMatch(/Only the owner.s members and its collaborators/);
		expect(text).not.toContain("Collaborators");
		expect(text).not.toContain("Delete");
	});

	it("offers a vote on a change only to people who may review", () => {
		const claim = repoSnapshot.claims[0]!;
		const view = { kind: "change" as const, change: claim.change, tab: "conversation" as const };
		const page = (level: RepoAccess["level"]) =>
			renderToStaticMarkup(
				<RepoPage
					repo="acme/docs-site"
					view={view}
					snapshot={repoSnapshot}
					api={stubApi()}
					access={{ ...access(level), fullName: "acme/docs-site" }}
					manage={manageApi}
				/>,
			);
		expect(page("read")).not.toContain("vote-title");
		expect(page("review")).toContain("vote-title");
	});

	it("lets a repo's admins change how changes merge; shows everyone else what it is", () => {
		const snapshot = {
			...repoSnapshot,
			policy: { required: 2, vetoes: ["security"], escalate: [{ paths: ["package.json"], required: 3 }] },
			verify: ["npm test"],
		};
		const render = (level: RepoAccess["level"], section?: "review" | "checks" | "path-rules" | "general") =>
			renderToStaticMarkup(
				<RepoPage
					repo="acme/web"
					view={{ kind: "repo", tab: "settings", ...(section ? { section } : {}) }}
					snapshot={snapshot}
					api={stubApi()}
					access={access(level)}
					manage={{ ...manageApi, changeSettings: noop }}
				/>,
			);
		const review = render("admin", "review");
		expect(review).toMatch(/id="settings-required" type="number" min="0" inputMode="numeric"[^>]* value="2"/);
		expect(render("admin", "checks")).toContain('value="npm test"');
		expect(visibleText(render("admin", "path-rules"))).toContain("Path rules");
		expect(visibleText(render("admin"))).toContain("How the records are kept");
		// Each section saves on its own, in ink: green is for landing and approving.
		for (const section of ["review", "checks", "path-rules"] as const) {
			const saves = render("admin", section).match(/<button[^>]*type="submit"[^>]*>(?:Save|Saving)[^<]*/g) ?? [];
			expect(saves).toHaveLength(1);
			expect(saves[0]).toContain("bg-primary");
			expect(saves[0]).not.toContain("bg-good");
		}
		const writer = visibleText(render("write", "review"));
		expect(writer).not.toContain("Save");
		expect(writer).toContain("Merging needs 2 approvals; security can block");
		expect(writer).toContain("package.json need 3 approvals");
	});

	it("shows a repo GitHive hasn't started on, its code and settings, and offers its admins a start", () => {
		const render = (level: RepoAccess["level"], view: Parameters<typeof RepoPage>[0]["view"]) =>
			visibleText(
				renderToStaticMarkup(
					<RepoPage
						repo="acme/fresh"
						view={view}
						snapshot={null}
						api={stubApi()}
						access={{ ...access(level), fullName: "acme/fresh", branch: "main" }}
						manage={{ ...manageApi, startRepo: noop }}
					/>,
				),
			);
		const changes = render("admin", { kind: "repo", tab: "changes" });
		expect(changes).toMatch(/GitHive hasn.t started on acme\/fresh yet\./);
		expect(changes).toContain("Start GitHive");
		expect(changes).toContain("Nothing here yet");
		// Someone who may only write is told who can start it, with no button.
		expect(render("write", { kind: "repo", tab: "changes" })).not.toContain("Start GitHive");
		expect(render("write", { kind: "repo", tab: "changes" })).toContain("once one of its admins starts it");
		// Settings shows who may do what, and deleting, and the code shows, but there is no way to start.
		expect(render("admin", { kind: "repo", tab: "settings" })).toContain("Collaborators");
		expect(render("admin", { kind: "repo", tab: "settings", section: "danger-zone" })).toContain(
			"Delete this repository",
		);
		expect(render("admin", { kind: "repo", tab: "settings" })).not.toContain("Nothing here yet");
		expect(render("admin", { kind: "repo", tab: "code" })).not.toContain("Nothing here yet");
	});
});
