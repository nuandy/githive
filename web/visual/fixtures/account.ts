import type {
	ApprovedEmail,
	Connection,
	HostedUser,
	InviteRequest,
	Me,
	MyAgent,
	MyOrg,
	Org,
	OrgDetail,
	RepoRecord,
} from "../../src/api.ts";
import { ago, daysAgo } from "./clock.ts";
import { sha } from "./ids.ts";
import { PEOPLE, ROBIN, type Person } from "./people.ts";
import type { RepoFixture } from "./repo.ts";

// Who is signed in, their agents and connected apps, their orgs, and what GitHive's operators see.

/** The signed-in admin: a person, owner of acme. */
export const ME: Me = {
	kind: "user",
	handle: ROBIN.handle,
	name: ROBIN.name,
	email: ROBIN.email,
	avatarUrl: null,
	by: ROBIN.person,
	hostedAgents: true,
};

/** One of GitHive's operators, through Cloudflare Access: the only caller the Admin page is for. */
export const OPERATOR: Me = {
	kind: "access",
	label: "ops@githive.example",
	by: `person:${sha("ops@githive.example").slice(0, 12)}`,
	hostedAgents: true,
};

const agentId = (name: string) => `ag-${sha(`agent:${name}`).slice(0, 10)}`;
const tokenId = (name: string) => `tk-${sha(`token:${name}`).slice(0, 10)}`;

export const AGENTS: MyAgent[] = [
	{
		id: agentId("builder"),
		ownerId: ROBIN.userId,
		name: "builder",
		createdAt: daysAgo(58),
		revokedAt: null,
		tokens: [
			{
				id: tokenId("builder-1"),
				agentId: agentId("builder"),
				prefix: "b7Kq2x",
				createdAt: daysAgo(50),
				expiresAt: daysAgo(-40),
				lastUsedAt: ago(9),
				revokedAt: null,
			},
			{
				id: tokenId("builder-0"),
				agentId: agentId("builder"),
				prefix: "Zr41mP",
				createdAt: daysAgo(95),
				expiresAt: daysAgo(5),
				lastUsedAt: daysAgo(6, 300),
				revokedAt: null,
			},
		],
	},
	{
		id: agentId("reviewer"),
		ownerId: ROBIN.userId,
		name: "reviewer",
		createdAt: daysAgo(40),
		revokedAt: null,
		tokens: [],
	},
	{
		id: agentId("old-laptop"),
		ownerId: ROBIN.userId,
		name: "old-laptop",
		createdAt: daysAgo(120),
		revokedAt: daysAgo(20),
		tokens: [
			{
				id: tokenId("old-laptop-0"),
				agentId: agentId("old-laptop"),
				prefix: "Qm9vT3",
				createdAt: daysAgo(120),
				expiresAt: null,
				lastUsedAt: daysAgo(21, 90),
				revokedAt: daysAgo(20),
			},
		],
	},
];

export const CONNECTIONS: Connection[] = [
	{
		id: `gr-${sha("grant:claude-code").slice(0, 10)}`,
		client: "Claude Code",
		agentId: agentId("reviewer"),
		agent: `${ROBIN.handle}/reviewer`,
		createdAt: daysAgo(12, 200),
	},
	{
		id: `gr-${sha("grant:codex").slice(0, 10)}`,
		client: "Codex",
		agentId: agentId("builder"),
		agent: `${ROBIN.handle}/builder`,
		createdAt: daysAgo(3, 45),
	},
];

/** A token just made for robin/builder: the secret, shown once (invented, like everything here). */
export const NEW_TOKEN = {
	id: tokenId("builder-2"),
	agentId: agentId("builder"),
	prefix: "Hq7Lw2",
	createdAt: ago(0),
	expiresAt: daysAgo(-90),
	lastUsedAt: null,
	revokedAt: null,
	token: "ghv_Hq7Lw2fixtureNotARealToken0000000000",
};

/** Claude Code, connected a moment ago as a new agent, robin/scout: what the Agents page finds after Copy. */
export const NEW_CONNECTION: Connection = {
	id: `gr-${sha("grant:claude-code-scout").slice(0, 10)}`,
	client: "Claude Code",
	agentId: agentId("scout"),
	agent: `${ROBIN.handle}/scout`,
	createdAt: ago(0),
};

const orgId = (slug: string) => `o-${sha(`org:${slug}`).slice(0, 10)}`;

/** The orgs the admin belongs to, and their own namespace. */
export const MY_ORGS: MyOrg[] = [
	{
		id: orgId(ROBIN.handle),
		slug: ROBIN.handle,
		name: ROBIN.name,
		personal: true,
		defaultPermission: "read",
		membersCanCreateRepos: false,
		role: "owner",
	},
	{
		id: orgId("acme"),
		slug: "acme",
		name: "Acme Storefront Co.",
		personal: false,
		defaultPermission: "write",
		membersCanCreateRepos: true,
		role: "owner",
	},
	{
		id: orgId("fieldnotes"),
		slug: "fieldnotes",
		name: "Fieldnotes Collective",
		personal: false,
		defaultPermission: "read",
		membersCanCreateRepos: false,
		role: "member",
	},
];

/** An org as it is, without the caller's role in it. */
const orgFields = ({ id, slug, name, personal, defaultPermission, membersCanCreateRepos }: MyOrg): Org => ({
	id,
	slug,
	name,
	personal,
	defaultPermission,
	membersCanCreateRepos,
});

const record = (repo: RepoFixture): RepoRecord => {
	const [org = "", name = ""] = repo.fullName.split("/");
	return { id: repo.id, org, name, fullName: repo.fullName, visibility: repo.visibility, createdAt: repo.createdAt };
};

const member = (who: Person, role: OrgDetail["members"][number]["role"]) => ({
	userId: who.userId,
	handle: who.handle,
	name: who.name,
	avatarUrl: null,
	role,
});

/** Each org's page, by slug, as the admin sees it. */
export function orgDetails(repos: RepoFixture[]): Record<string, OrgDetail> {
	const reposOf = (slug: string) => repos.filter((repo) => repo.fullName.startsWith(`${slug}/`)).map(record);
	const [personalOrg, acmeOrg, fieldOrg] = MY_ORGS.map(orgFields) as [Org, Org, Org];
	return {
		[ROBIN.handle]: {
			...personalOrg,
			role: "owner",
			canCreateRepos: true,
			repos: reposOf(ROBIN.handle),
			members: [member(ROBIN, "owner")],
			teams: [],
			invites: [],
		},
		acme: {
			...acmeOrg,
			role: "owner",
			canCreateRepos: true,
			repos: reposOf("acme"),
			members: [
				member(ROBIN, "owner"),
				member(PEOPLE.mara, "admin"),
				member(PEOPLE.devon, "member"),
				member(PEOPLE.ines, "member"),
				member(PEOPLE.theo, "member"),
				member(PEOPLE.ari, "member"),
				member(PEOPLE.kim, "member"),
			],
			teams: [
				{
					id: `t-${sha("team:acme/payments").slice(0, 10)}`,
					slug: "payments",
					name: "Payments",
					members: [PEOPLE.mara.handle, PEOPLE.devon.handle],
				},
				{
					id: `t-${sha("team:acme/frontend").slice(0, 10)}`,
					slug: "frontend",
					name: "Frontend",
					members: [ROBIN.handle, PEOPLE.ines.handle, PEOPLE.theo.handle],
				},
			],
			invites: [
				{ email: "quinn@acme.example", role: "member", createdAt: daysAgo(2, 130) },
				// The request the Admin page shows, waiting on GitHive's approval.
				{ email: "jun@acme.example", role: "member", createdAt: ago(190), awaitingApproval: true },
			],
		},
		fieldnotes: {
			...fieldOrg,
			role: "member",
			canCreateRepos: false,
			repos: [],
			members: [member(PEOPLE.wren, "owner"), member(PEOPLE.pat, "admin"), member(ROBIN, "member")],
			teams: [
				{
					id: `t-${sha("team:fieldnotes/editors").slice(0, 10)}`,
					slug: "editors",
					name: "Editors",
					members: [PEOPLE.pat.handle, ROBIN.handle],
				},
			],
			invites: [],
		},
		[PEOPLE.jo.handle]: {
			id: orgId(PEOPLE.jo.handle),
			slug: PEOPLE.jo.handle,
			name: PEOPLE.jo.name,
			personal: true,
			defaultPermission: "read",
			membersCanCreateRepos: false,
			role: null,
			canCreateRepos: false,
			repos: reposOf(PEOPLE.jo.handle),
			members: [],
			teams: [],
			invites: [],
		},
	};
}

/** Emails GitHive's operators approved to sign in. */
export const APPROVED: ApprovedEmail[] = [
	{ email: "quinn@acme.example", invitedBy: "ops@githive.example", createdAt: daysAgo(2, 100) },
	{ email: "pat@fieldnotes.example", invitedBy: "ops@githive.example", createdAt: daysAgo(17) },
];

/** People orgs asked to add, or who tried to sign in uninvited. */
export const REQUESTS: InviteRequest[] = [
	{
		email: "jun@acme.example",
		orgs: [{ org: "acme", role: "member", invitedBy: ROBIN.handle }],
		createdAt: ago(190),
	},
	{
		email: "taylor@mail.example",
		orgs: [],
		createdAt: daysAgo(1, 300),
		signIn: { provider: "github", name: "Taylor Reyes", login: "treyes", tries: 3, lastAt: ago(45) },
	},
];

/** People allowed to start GitHive's hosted agents. */
export const HOSTED_USERS: HostedUser[] = [
	{ handle: ROBIN.handle, grantedBy: "ops@githive.example", createdAt: daysAgo(30) },
	{ handle: PEOPLE.mara.handle, grantedBy: "ops@githive.example", createdAt: daysAgo(11, 60) },
];
