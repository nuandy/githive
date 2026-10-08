import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MyOrg, OrgDetail, RepoAccess } from "../api";
import { repoSnapshot, stubApi, visibleText } from "../test/fixtures";
import { newRepoInput, NewRepoView } from "./NewRepoPage";
import { type OrgActions, OrgView } from "./OrgPage";
import { OrgsView } from "./OrgsPage";
import { RepoAdmin, type RepoManageApi } from "./RepoAdmin";
import { RepoPage } from "./RepoPage";

const noop = async () => ({}) as never;
const orgActions: OrgActions = { updateOrg: noop, addMember: noop, setRole: noop, removeMember: noop, cancelInvite: noop, createTeam: noop, deleteTeam: noop, addTeamMember: noop, removeTeamMember: noop };
const manageApi: RepoManageApi = { setVisibility: noop, deleteRepo: noop, collaborators: async () => [], setCollaborator: noop, removeCollaborator: noop };

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
		{ id: "p", slug: "ada", name: null, personal: true, defaultPermission: "admin", membersCanCreateRepos: false, role: "owner" },
		{ id: "o1", slug: "acme", name: "Acme", personal: false, defaultPermission: "write", membersCanCreateRepos: true, role: "member" },
		{ id: "o2", slug: "strict", name: null, personal: false, defaultPermission: "write", membersCanCreateRepos: false, role: "member" },
	];

	it("offers your own namespace and the orgs you may create in, starting with the one asked for", () => {
		const html = renderToStaticMarkup(<NewRepoView orgs={orgs} repos={[]} owner="acme" create={noop} onCreated={() => {}} />);
		expect(html).toContain('<option value="ada">ada (you)</option>');
		expect(html).toContain('<option value="acme" selected="">acme</option>');
		expect(html).not.toContain('value="strict"');
		expect(visibleText(html)).toContain("Make repository");
	});

	it("sends only what its source needs", () => {
		const base = { owner: "acme", name: " web ", url: " https://g.test/x ", branch: "", copyFrom: "acme/old", visibility: "private" as const };
		expect(newRepoInput({ ...base, source: "import" })).toEqual({ owner: "acme", name: "web", visibility: "private", import_url: "https://g.test/x" });
		expect(newRepoInput({ ...base, source: "import", branch: "dev" })).toMatchObject({ branch: "dev" });
		expect(newRepoInput({ ...base, source: "copy" })).toEqual({ owner: "acme", name: "web", visibility: "private", copy_from: "acme/old" });
		// Fresh: a README by default, and whatever else was chosen; nothing at all only if nothing was.
		expect(newRepoInput({ ...base, source: "empty" })).toEqual({ owner: "acme", name: "web", visibility: "private", init: { readme: true } });
		expect(newRepoInput({ ...base, source: "empty", first: { readme: true, description: " Docs ", gitignore: "python", license: "mit" } })).toMatchObject({ init: { readme: true, description: "Docs", gitignore: "python", license: "mit" } });
		expect(newRepoInput({ ...base, source: "empty", first: { readme: false, description: "ignored", gitignore: "rust", license: "" } })).toMatchObject({ init: { gitignore: "rust" } });
		expect(newRepoInput({ ...base, source: "empty", first: { readme: false, description: "", gitignore: "", license: "" } })).toEqual({ owner: "acme", name: "web", visibility: "private" });
	});
});

describe("your organizations", () => {
	it("lists your own repositories first, never as an org, then your orgs, and offers making one", () => {
		const orgs: MyOrg[] = [
			{ id: "p", slug: "ada", name: null, personal: true, defaultPermission: "admin", membersCanCreateRepos: false, role: "owner" },
			{ id: "o1", slug: "acme", name: "Acme", personal: false, defaultPermission: "write", membersCanCreateRepos: true, role: "admin" },
		];
		const text = visibleText(renderToStaticMarkup(<OrgsView me={{ handle: "ada" }} orgs={orgs} createOrg={noop} onCreated={() => {}} />));
		expect(text).toContain("ada your repositories");
		expect(text).toContain("acme Acme admin");
		expect(text).toContain("Create an organization");
	});
});

describe("an organization's page", () => {
	it("lets owners manage people, invitations, teams and settings", () => {
		const html = renderToStaticMarkup(<OrgView org={acme("owner")} me={{ handle: "ada" }} actions={orgActions} onLeft={() => {}} />);
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

	it("shows members the people and teams, without managing, and lets them leave", () => {
		const text = visibleText(renderToStaticMarkup(<OrgView org={acme("member")} me={{ handle: "bob" }} actions={orgActions} onLeft={() => {}} />));
		expect(text).toContain("People");
		expect(text).toContain("@acme/security");
		expect(text).not.toContain("Cancel invitation");
		expect(text).not.toContain("New team");
		expect(text).not.toContain("Settings");
		expect(text).toContain("Leave");
	});

	it("shows outsiders only the repositories they can see", () => {
		const text = visibleText(renderToStaticMarkup(<OrgView org={acme(null, { repos: [] })} me={{ handle: "eve" }} actions={orgActions} onLeft={() => {}} />));
		expect(text).toContain("None that you can see.");
		expect(text).not.toContain("People");
		expect(text).not.toContain("Teams");
	});

	it("calls your own namespace your repositories, with no members or teams", () => {
		const own = acme("owner", { slug: "ada", personal: true, members: [{ userId: "u1", handle: "ada", name: null, avatarUrl: null, role: "owner" }], teams: [], invites: [] });
		const text = visibleText(renderToStaticMarkup(<OrgView org={own} me={{ handle: "ada" }} actions={orgActions} onLeft={() => {}} />));
		expect(text).toContain("Your repositories");
		expect(text).not.toContain("People");
		expect(text).not.toMatch(/organization/i);
	});
});

describe("a repo's access settings", () => {
	const access = (level: RepoAccess["level"]): RepoAccess => ({ id: "acme--web", fullName: "acme/web", level, visibility: "private" });

	it("gives admins visibility, collaborators and deleting", () => {
		const text = visibleText(renderToStaticMarkup(<RepoAdmin repo="acme/web" access={access("admin")} manage={manageApi} onChanged={() => {}} onDeleted={() => {}} />));
		expect(text).toContain("Admin: write, and change settings");
		expect(text).toContain("Make it Public");
		expect(text).toContain("Collaborators");
		expect(text).toContain("Delete this repository");
	});

	it("shows everyone else what they may do, and nothing to change", () => {
		const text = visibleText(renderToStaticMarkup(<RepoAdmin repo="acme/web" access={access("write")} manage={manageApi} onChanged={() => {}} onDeleted={() => {}} />));
		expect(text).toContain("Write: review, and claim, push and merge changes");
		expect(text).toMatch(/Only the owner.s members and its collaborators/);
		expect(text).not.toContain("Collaborators");
		expect(text).not.toContain("Delete");
	});

	it("offers a vote on a change only to people who may review", () => {
		const claim = repoSnapshot.claims[0];
		const view = { kind: "change" as const, change: claim.change, tab: "conversation" as const };
		const page = (level: RepoAccess["level"]) => renderToStaticMarkup(<RepoPage repo="acme/docs-site" view={view} snapshot={repoSnapshot} api={stubApi()} access={{ ...access(level), fullName: "acme/docs-site" }} manage={manageApi} />);
		expect(page("read")).not.toContain("vote-title");
		expect(page("review")).toContain("vote-title");
	});

	it("lets a repo's admins change how changes merge; shows everyone else what it is", () => {
		const snapshot = { ...repoSnapshot, policy: { required: 2, vetoes: ["security"], escalate: [{ paths: ["package.json"], required: 3 }] }, verify: ["npm test"] };
		const render = (level: RepoAccess["level"]) =>
			renderToStaticMarkup(<RepoPage repo="acme/web" view={{ kind: "repo", tab: "settings" }} snapshot={snapshot} api={stubApi()} access={access(level)} manage={{ ...manageApi, changeSettings: noop }} />);
		const admin = render("admin");
		expect(admin).toContain('id="settings-required" type="number" min="0" inputMode="numeric" value="2"');
		expect(admin).toContain('value="npm test"');
		expect(visibleText(admin)).toContain("Save settings");
		expect(visibleText(admin)).toContain("Stricter rules for paths");
		expect(visibleText(admin)).toContain("How the records are kept");
		const writer = visibleText(render("write"));
		expect(writer).not.toContain("Save settings");
		expect(writer).toContain("Merging needs 2 approvals; security can block");
		expect(writer).toContain("package.json need 3 approvals");
	});

	it("shows a repo GitHive hasn't started on, its code and settings, and offers its admins a start", () => {
		const render = (level: RepoAccess["level"], view: Parameters<typeof RepoPage>[0]["view"]) =>
			visibleText(renderToStaticMarkup(<RepoPage repo="acme/fresh" view={view} snapshot={null} api={stubApi()} access={{ ...access(level), fullName: "acme/fresh", branch: "main" }} manage={{ ...manageApi, startRepo: noop }} />));
		const changes = render("admin", { kind: "repo", tab: "changes" });
		expect(changes).toMatch(/GitHive hasn.t started on acme\/fresh yet\./);
		expect(changes).toContain("Start GitHive");
		expect(changes).toContain("Nothing here yet");
		// Someone who may only write is told who can start it, with no button.
		expect(render("write", { kind: "repo", tab: "changes" })).not.toContain("Start GitHive");
		expect(render("write", { kind: "repo", tab: "changes" })).toContain("once one of its admins starts it");
		// Settings shows who may do what, and the code shows, without a start.
		expect(render("admin", { kind: "repo", tab: "settings" })).toContain("Delete");
		expect(render("admin", { kind: "repo", tab: "settings" })).not.toContain("Nothing here yet");
		expect(render("admin", { kind: "repo", tab: "code" })).not.toContain("Nothing here yet");
	});
});
