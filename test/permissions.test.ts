import { describe, expect, it, vi } from "vitest";
import { TOOL_LEVEL } from "../src/auth/access-control";
import { type Level, OrgStore, atLeast } from "../src/auth/orgs";
import { IdentityStore } from "../src/auth/store";
import { fakeD1 } from "./fakes/d1";

// Who gets past each repo route and MCP tool, for each kind of person, in the
// Worker with SQLite for D1. A call that gets past the check may still fail
// for want of Git here, but never with "no repo" (can't see it) or "you can …"
// (can see it, but not do this): those mean it was turned away.

vi.mock("../src/access", () => ({ verifyAccessRequest: vi.fn(async () => null) }));
const worker = (await import("../src/index")).default;
const ORIGIN = "https://githive.test";

/** acme (ada owns it, bob is a member, cyd reviews web as a collaborator), and eve from outside. */
async function world() {
	const DB = fakeD1();
	const ids = new IdentityStore(DB);
	const orgs = new OrgStore(DB);
	const people: Record<string, { id: string; handle: string; email: string; session: string; token: string }> = {};
	for (const handle of ["ada", "bob", "cyd", "eve"]) {
		await ids.invite(`${handle}@example.com`, "admin");
		const { user } = (await ids.signIn({ provider: "github", providerId: handle, email: `${handle}@example.com`, login: handle })) as { user: { id: string; handle: string; email: string } };
		await orgs.personalOrg(user);
		const agent = await ids.createAgent(user.id, "builder");
		people[handle] = { ...user, session: `__Host-githive_session=${encodeURIComponent(await ids.createSession(user.id))}`, token: (await ids.createToken(user.id, agent.id)).token };
	}
	const acme = await orgs.createOrg(people.ada, "acme");
	await orgs.addMember(acme, "bob@example.com", "member", "ada");
	await orgs.addRepo(acme, "web", people.ada.id);
	await orgs.addRepo(acme, "docs", people.ada.id, { visibility: "public" });
	await orgs.setCollaborator("acme--web", "cyd", "review");
	const env = { DB, ASSETS: { fetch: async () => new Response("page") } };
	return { env, people, orgs };
}

/** What each person may do in acme/web. */
const EXPECTED: Record<string, Level | null> = { ada: "admin", bob: "write", cyd: "review", eve: null };

/** Turned away: can't see the repo, or can't do this in it. */
const refused = (error: string | undefined) => !!error && /^(no repo |you can )/.test(error);

const ROUTES: [method: string, path: string, needs: Level][] = [
	["GET", "/repos/acme/web", "read"],
	["GET", "/repos/acme/web/access", "read"],
	["GET", "/repos/acme/web/changes/c-1", "read"],
	["GET", "/repos/acme/web/line", "read"],
	["GET", "/repos/acme/web/audit", "read"],
	["GET", "/repos/acme/web/tree", "read"],
	["GET", "/repos/acme/web/file?path=README.md", "read"],
	["GET", "/repos/acme/web/builders/c-1", "read"],
	["GET", "/repos/acme/web/reviewers/c-1/abc/tests", "read"],
	["GET", "/repos/acme/web/live", "read"],
	["POST", "/repos/acme/web/changes/c-1/votes", "review"],
	["PATCH", "/repos/acme/web", "admin"],
	["POST", "/repos/acme/web/start", "admin"],
	["POST", "/repos/acme/web/settings", "admin"],
	["GET", "/repos/acme/web/collaborators", "admin"],
	["PUT", "/repos/acme/web/collaborators/bob", "admin"],
	["DELETE", "/repos/acme/web/collaborators/bob", "admin"],
	["DELETE", "/repos/acme/web", "admin"],
];

async function route(env: object, method: string, path: string, session: string) {
	const headers: Record<string, string> = { Cookie: session, Origin: ORIGIN };
	const body = method === "GET" || method === "DELETE" ? undefined : JSON.stringify({ role: "review", verdict: "approve", evidence: "ok", permission: "read", visibility: "private" });
	if (body) headers["Content-Type"] = "application/json";
	const response = await worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body }), env as never, { waitUntil: () => {} } as never);
	const text = await response.text();
	let error: string | undefined;
	try {
		error = JSON.parse(text).error;
	} catch {
		error = undefined;
	}
	return { status: response.status, error };
}

async function tool(env: object, name: string, token: string) {
	const args = { repo: "acme/web", change: "c-1", agent: "x", paths: ["src/"], intent: "x", commit: "abc", reviewer: "x", role: "review", verdict: "approve", evidence: "ok", reason: "x", roles: ["review"], title: "x", id: "w-1" };
	const response = await worker.fetch(
		new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }),
		env as never,
		{ waitUntil: () => {} } as never,
	);
	const reply = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
	return reply.result.isError ? reply.result.content[0].text : undefined;
}

describe("every repo route, for each person", () => {
	for (const [person, level] of Object.entries(EXPECTED)) {
		it(`lets ${person} (${level ?? "nothing"} in acme/web) through exactly the routes that need no more`, async () => {
			for (const [method, path, needs] of ROUTES) {
				// A fresh world each time: some routes change it (collaborators, deleting).
				const { env, people } = await world();
				const { error } = await route(env, method, path, people[person].session);
				expect(refused(error), `${person} ${method} ${path} (needs ${needs}): ${error}`).toBe(!atLeast(level, needs));
				// Someone who can't see the repo is told it doesn't exist, never that they can't.
				if (!level) expect(error).toBe("no repo acme/web");
			}
		});
	}
});

describe("every MCP tool, for each person's agent", () => {
	for (const [person, level] of Object.entries(EXPECTED)) {
		it(`lets ${person}'s agent (with ${person}'s ${level ?? "nothing"}) use exactly the tools that need no more`, async () => {
			const { env, people } = await world();
			for (const [name, needs] of Object.entries(TOOL_LEVEL)) {
				// credentials with a change writes to a fork.
				const required = name === "credentials" ? "write" : needs;
				const error = await tool(env, name, people[person].token);
				expect(refused(error), `${person} ${name} (needs ${required}): ${error}`).toBe(!atLeast(level, required));
			}
		});
	}
});

describe("what each person can see", () => {
	it("lists only the repos a person can see, by their full names", async () => {
		const { env, people, orgs } = await world();
		await orgs.addRepo((await orgs.org("eve"))!, "notes", people.eve.id);
		const list = async (who: string) => (await (await worker.fetch(new Request(`${ORIGIN}/repos`, { headers: { Cookie: people[who].session } }), env as never, {} as never)).json()) as { name: string }[];
		expect((await list("bob")).map((r) => r.name)).toEqual(["acme/docs", "acme/web"]);
		expect((await list("cyd")).map((r) => r.name)).toEqual(["acme/docs", "acme/web"]);
		expect((await list("eve")).map((r) => r.name)).toEqual(["acme/docs", "eve/notes"]);
	});

	it("lets anyone signed in read a public repo, and nothing more", async () => {
		const { env, people } = await world();
		expect(refused((await route(env, "GET", "/repos/acme/docs/access", people.eve.session)).error)).toBe(false);
		expect((await route(env, "POST", "/repos/acme/docs/changes/c-1/votes", people.eve.session)).error).toBe("you can read in acme/docs; this needs review");
		expect(await tool(env, "claims", people.eve.token)).toBe("no repo acme/web");
	});

	it("shows an org's people and teams only to its members", async () => {
		const { env, people } = await world();
		const org = async (who: string) => (await (await worker.fetch(new Request(`${ORIGIN}/orgs/acme`, { headers: { Cookie: people[who].session } }), env as never, {} as never)).json()) as { role: string | null; members: unknown[]; repos: { fullName: string }[] };
		const bob = await org("bob");
		expect(bob.role).toBe("member");
		expect(bob.members).toHaveLength(2);
		const eve = await org("eve");
		expect(eve).toMatchObject({ role: null, members: [] });
		expect(eve.repos.map((r) => r.fullName)).toEqual(["acme/docs"]);
	});

	it("lets an org's owners and admins manage it, and nobody else", async () => {
		const { env, people } = await world();
		const asJson = (who: string, method: string, path: string, body: object) =>
			worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { Cookie: people[who].session, Origin: ORIGIN, "Content-Type": "application/json" }, body: JSON.stringify(body) }), env as never, {} as never);
		expect((await asJson("bob", "POST", "/orgs/acme/members", { email: "new@example.com" })).status).toBe(403);
		expect((await asJson("eve", "POST", "/orgs/acme/teams", { slug: "security" })).status).toBe(403);
		expect((await asJson("ada", "POST", "/orgs/acme/teams", { slug: "security" })).status).toBe(201);
		expect((await asJson("ada", "PATCH", "/orgs/acme/members/bob", { role: "admin" })).status).toBe(200);
		// An admin can't make an owner.
		expect((await asJson("bob", "PATCH", "/orgs/acme/members/bob", { role: "owner" })).status).toBe(403);
	});
});
