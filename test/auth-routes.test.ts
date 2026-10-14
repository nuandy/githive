import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityStore } from "../src/auth/store";
import { fakeD1 } from "./fakes/d1";

// GitHive's sign-in through the Worker, with GitHub's API faked. Covers the
// redirect and its state, invitations, the session cookie, a person's agents and
// tokens, refusing cross-site writes, and an agent token reaching MCP.

vi.mock("../src/access", () => ({
	// An Access assertion only when a test sends one.
	verifyAccessRequest: vi.fn(async (request: Request) =>
		request.headers.get("Cf-Access-Jwt-Assertion") === "admin" ? { kind: "person", value: "admin@example.com" } : null,
	),
}));

const worker = (await import("../src/index")).default;
const ORIGIN = "https://githive.test";

let env: Record<string, unknown>;
let ids: IdentityStore;
beforeEach(() => {
	const DB = fakeD1();
	ids = new IdentityStore(DB);
	env = {
		DB,
		GITHUB_CLIENT_ID: "gh-client",
		GITHUB_CLIENT_SECRET: "gh-secret",
		ASSETS: { fetch: async () => new Response("page") },
	};
});
afterEach(() => vi.unstubAllGlobals());

const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
	const headers = new Headers(init.headers);
	if (init.cookie) headers.set("Cookie", init.cookie);
	return worker.fetch(
		new Request(`${ORIGIN}${path}`, { ...init, headers }),
		env as never,
		{ waitUntil: () => {} } as never,
	);
};
/** A response's JSON, as the test reads it. */
const json = async (response: Response | Promise<Response>): Promise<any> => (await response).json();
const setCookies = (response: Response) => response.headers.getSetCookie();
const cookieValue = (response: Response, name: string) =>
	setCookies(response)
		.find((c) => c.startsWith(`${name}=`))
		?.split(";")[0];

/** GitHub, as the token exchange and the user API answer for a person. */
function fakeGitHub(person: { id: number; login: string; email: string; verified?: boolean }) {
	const seen: { url: string; body?: string }[] = [];
	vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
		const url = String(input instanceof Request ? input.url : input);
		seen.push({ url, body: typeof init?.body === "string" ? init.body : undefined });
		if (url === "https://github.com/login/oauth/access_token") return Response.json({ access_token: "gho_test" });
		if (url === "https://api.github.com/user")
			return Response.json({
				id: person.id,
				login: person.login,
				name: "Ada Lovelace",
				avatar_url: "https://avatars.test/ada",
			});
		if (url === "https://api.github.com/user/emails")
			return Response.json([{ email: person.email, primary: true, verified: person.verified ?? true }]);
		return new Response("unexpected", { status: 500 });
	});
	return seen;
}

/** Sign in through GitHub: returns the session cookie, and where the callback sent the browser. */
async function signIn(returnTo = "/#/repos") {
	const start = await call(`/auth/github?return=${encodeURIComponent(returnTo)}`);
	expect(start.status).toBe(302);
	const to = new URL(start.headers.get("Location")!);
	const pending = cookieValue(start, "__Host-githive_signin")!;
	const back = await call(`/auth/github/callback?code=abc&state=${to.searchParams.get("state")}`, { cookie: pending });
	return { back, location: back.headers.get("Location"), session: cookieValue(back, "__Host-githive_session") };
}

describe("signing in with GitHub", () => {
	it("sends the browser to GitHub with a state and a PKCE challenge, and checks both on the way back", async () => {
		const seen = fakeGitHub({ id: 1, login: "ada", email: "ada@example.com" });
		await ids.invite("ada@example.com", "admin@example.com");
		const start = await call("/auth/github");
		const to = new URL(start.headers.get("Location")!);
		expect(to.origin + to.pathname).toBe("https://github.com/login/oauth/authorize");
		expect(Object.fromEntries(to.searchParams)).toMatchObject({
			client_id: "gh-client",
			redirect_uri: `${ORIGIN}/auth/github/callback`,
			code_challenge_method: "S256",
		});
		expect(setCookies(start)[0]).toMatch(
			/^__Host-githive_signin=.*; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/,
		);
		// A state that isn't the one sent is refused, before GitHub is asked anything.
		const forged = await call("/auth/github/callback?code=abc&state=forged", {
			cookie: cookieValue(start, "__Host-githive_signin"),
		});
		expect(forged.headers.get("Location")).toBe("/?signin_error=expired");
		expect(seen).toEqual([]);
		const { location, session } = await signIn();
		expect(location).toBe("/#/repos");
		expect(session).toMatch(/^__Host-githive_session=/);
		// The verifier went to GitHub with the code.
		expect(JSON.parse(seen[0]!.body!)).toMatchObject({ code: "abc", code_verifier: expect.any(String) });
	});

	it("names the providers set up here, and the demo repo when there is one", async () => {
		expect(await json(call("/auth/providers"))).toEqual({ providers: ["github"], inviteCode: false });
		env.DEMO_REPO = "nuandy/honeycomb";
		expect(await json(call("/auth/providers"))).toMatchObject({ demoRepo: "nuandy/honeycomb" });
		env.DEMO_REPO = "not a repo";
		expect(await json(call("/auth/providers"))).not.toHaveProperty("demoRepo");
	});

	it("turns away a person who isn't invited, and one whose email GitHub hasn't verified", async () => {
		fakeGitHub({ id: 2, login: "eve", email: "eve@example.com" });
		// The email their request is noted under comes back in the fragment, which the browser never sends on.
		expect((await signIn()).location).toBe("/?signin_error=not-invited#signin-as=eve%40example.com");
		await ids.invite("eve@example.com", "admin@example.com");
		fakeGitHub({ id: 2, login: "eve", email: "eve@example.com", verified: false });
		expect((await signIn()).location).toBe("/?signin_error=unverified-email");
	});

	it("never sends the browser to another site after sign-in", async () => {
		fakeGitHub({ id: 1, login: "ada", email: "ada@example.com" });
		await ids.invite("ada@example.com", "admin@example.com");
		expect((await signIn("//evil.test/steal")).location).toBe("/");
		expect((await signIn("https://evil.test")).location).toBe("/");
	});
});

describe("a signed-in person", () => {
	const signedIn = async () => {
		fakeGitHub({ id: 1, login: "ada", email: "ada@example.com" });
		await ids.invite("ada@example.com", "admin@example.com");
		return (await signIn()).session!;
	};
	const post = (body: unknown) => ({
		method: "POST",
		headers: { "Content-Type": "application/json", Origin: ORIGIN },
		body: JSON.stringify(body),
	});

	it("sees who they are, and is signed out by signing out", async () => {
		const session = await signedIn();
		const me = await json(call("/me", { cookie: session }));
		expect(me).toMatchObject({
			kind: "user",
			handle: "ada",
			email: "ada@example.com",
			by: expect.stringMatching(/^person:[0-9a-f]{12}$/),
		});
		await call("/auth/signout", { method: "POST", headers: { Origin: ORIGIN }, cookie: session });
		expect((await call("/me", { cookie: session })).status).toBe(401);
	});

	it("has the same person:<hash> in the records as through Access, for the same email", async () => {
		const session = await signedIn();
		const viaSignIn = (await json(call("/me", { cookie: session }))).by;
		await ids.invite("admin@example.com", "admin@example.com");
		const viaAccess = (await json(call("/me", { headers: { "Cf-Access-Jwt-Assertion": "admin" } }))).by;
		expect(viaSignIn).not.toBe(viaAccess);
		const { identityLabel } = await import("../src/toolkit/stamp");
		expect(viaSignIn).toBe(identityLabel({ kind: "person", value: "ada@example.com" }));
	});

	it("makes an agent and a token, which then reaches MCP as <handle>/<agent> with no key", async () => {
		const session = await signedIn();
		const agent = await json(call("/me/agents", { ...post({ name: "builder" }), cookie: session }));
		const issued = await json(call(`/me/agents/${agent.id}/tokens`, { ...post({}), cookie: session }));
		expect(issued.token).toMatch(/^ghv_/);
		const listed = await json(call("/me/agents", { cookie: session }));
		expect(listed[0].tokens[0]).not.toHaveProperty("token");
		const init = await call("/mcp", {
			method: "POST",
			headers: { Authorization: `Bearer ${issued.token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		expect((await json(init)).result.instructions).toMatch(/signed in to GitHive as the agent ada\/builder/);
		expect(await json(call("/me", { headers: { Authorization: `Bearer ${issued.token}` } }))).toMatchObject({
			kind: "agent",
			agent: "ada/builder",
		});
		// Revoked, the token stops at the next call.
		await call(`/me/tokens/${issued.id}`, { method: "DELETE", headers: { Origin: ORIGIN }, cookie: session });
		expect(
			(await call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${issued.token}` }, body: "{}" })).status,
		).toBe(401);
	});

	it("lists each agent's limits on work for other people, which only its owner sets", async () => {
		const session = await signedIn();
		const agent = await json(call("/me/agents", { ...post({ name: "builder" }), cookie: session }));
		const listed = await json(call("/me/agents", { cookie: session }));
		// A new agent does nothing for other people until its owner says so.
		expect(listed[0]).toMatchObject({ limits: { build: 0, review: 0 }, today: { build: 0, review: 0 } });
		const patch = (body: unknown) => ({ ...post(body), method: "PATCH", cookie: session });
		expect(await json(call(`/me/agents/${agent.id}/limits`, patch({ build: 3, review: null })))).toEqual({
			agent: agent.id,
			limits: { build: 3, review: null },
		});
		expect((await call(`/me/agents/${agent.id}/limits`, patch({ review: -1 }))).status).toBe(400);
		expect((await call("/me/agents/someone-elses/limits", patch({ build: 1 }))).status).toBe(404);
	});

	it("refuses a write that comes from another site, even with the session cookie", async () => {
		const session = await signedIn();
		const forged = await call("/me/agents", {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: "https://evil.test" },
			body: JSON.stringify({ name: "x" }),
			cookie: session,
		});
		expect(forged.status).toBe(403);
		expect(await ids.agents((await ids.sessionUser(decodeURIComponent(session.split("=")[1]!)))!.id)).toEqual([]);
	});

	it("keeps an agent's token away from a person's routes", async () => {
		const session = await signedIn();
		const agent = await json(call("/me/agents", { ...post({ name: "builder" }), cookie: session }));
		const { token } = await json(call(`/me/agents/${agent.id}/tokens`, { ...post({}), cookie: session }));
		const asAgent = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
		expect(
			(await call("/me/agents", { method: "POST", headers: asAgent, body: JSON.stringify({ name: "more" }) })).status,
		).toBe(401);
		expect(
			(
				await call("/repos/acme/web/changes/c-1/votes", {
					method: "POST",
					headers: asAgent,
					body: JSON.stringify({ role: "review", verdict: "approve", evidence: "ok" }),
				})
			).status,
		).toBe(403);
	});
});

describe("invitations", () => {
	it("are managed by an admin through Access, and by nobody else", async () => {
		const admin = { "Cf-Access-Jwt-Assertion": "admin", "Content-Type": "application/json" };
		expect(
			(
				await call("/admin/invites", {
					method: "POST",
					headers: admin,
					body: JSON.stringify({ email: "New@Example.com" }),
				})
			).status,
		).toBe(201);
		expect(await json(call("/admin/invites", { headers: admin }))).toEqual([
			{ email: "new@example.com", invitedBy: "admin@example.com", createdAt: expect.any(String) },
		]);
		fakeGitHub({ id: 1, login: "ada", email: "ada@example.com" });
		await ids.invite("ada@example.com", "admin@example.com");
		const { session } = await signIn();
		expect((await call("/admin/invites", { cookie: session! })).status).toBe(403);
	});
});

describe("the admin door", () => {
	it("is shut on the public address: an Access assertion there is never accepted", async () => {
		env.PUBLIC_ORIGIN = ORIGIN;
		const asAdmin = { "Cf-Access-Jwt-Assertion": "admin" };
		expect((await call("/admin/invites", { headers: asAdmin })).status).toBe(401);
		expect((await call("/me", { headers: asAdmin })).status).toBe(401);
		// The same assertion on an Access hostname is an admin.
		const access = await worker.fetch(
			new Request("https://blueprint.test/admin/invites", { headers: asAdmin }),
			env as never,
			{ waitUntil: () => {} } as never,
		);
		expect(access.status).toBe(200);
	});
});
