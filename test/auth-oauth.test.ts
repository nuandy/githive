import { beforeEach, describe, expect, it, vi } from "vitest";
import { IdentityStore } from "../src/auth/store";
import { fakeD1 } from "./fakes/d1";
import { fakeKV } from "./fakes/kv";

// An MCP client connecting over OAuth 2.1, end to end through the Worker and
// the real OAuth provider (KV and D1 in memory): it finds the authorization
// server from /mcp's 401, registers, sends a person to /authorize, gets a
// token for the agent they chose, and calls MCP as that agent, until the
// agent is revoked.

vi.mock("../src/access", () => ({ verifyAccessRequest: vi.fn(async () => null) }));

const worker = (await import("../src/index")).default;
const ORIGIN = "https://githive.test";
const CLIENT_REDIRECT = "http://127.0.0.1:33418/callback";

let env: Record<string, unknown>;
let ids: IdentityStore;
let session: string;
let userId: string;

beforeEach(async () => {
	const DB = fakeD1();
	ids = new IdentityStore(DB);
	env = { DB, OAUTH_KV: fakeKV(), PUBLIC_ORIGIN: ORIGIN, GITHUB_CLIENT_ID: "gh", GITHUB_CLIENT_SECRET: "s", ASSETS: { fetch: async () => new Response("page") } };
	await ids.invite("ada@example.com", "admin@example.com");
	const signed = (await ids.signIn({ provider: "github", providerId: "1", email: "ada@example.com", login: "ada" })) as { user: { id: string } };
	userId = signed.user.id;
	session = `__Host-githive_session=${encodeURIComponent(await ids.createSession(userId))}`;
});

const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, init), env as never, { waitUntil: () => {}, passThroughOnException: () => {} } as never);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const cookiesOf = (r: Response) => r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

async function pkce() {
	const verifier = "v".repeat(64);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
	return { verifier, challenge: btoa(String.fromCharCode(...digest)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") };
}

/** The client registers and opens /authorize; returns the URL it opened and its PKCE verifier. */
async function startConnecting() {
	const registered = await json(call("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" }) }));
	const { verifier, challenge } = await pkce();
	const authorizeUrl = `/authorize?${new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: CLIENT_REDIRECT, scope: "mcp", state: "st", code_challenge: challenge, code_challenge_method: "S256", resource: `${ORIGIN}/mcp` })}`;
	return { clientId: registered.client_id as string, authorizeUrl, verifier };
}

/** The person allows the client as `agent` (an agent id, or "new" with a name). Returns the client's code. */
async function allow(authorizeUrl: string, agent: string, newName = "") {
	const pageResponse = await call(authorizeUrl, { headers: { Cookie: session } });
	expect(pageResponse.status).toBe(200);
	const handle = (await pageResponse.text()).match(/name="handle" value="([^"]+)"/)![1];
	const form = new URLSearchParams({ handle, decision: "approve", agent, new_name: newName });
	const approved = await call(authorizeUrl, { method: "POST", headers: { Cookie: `${session}; ${cookiesOf(pageResponse)}`, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
	return approved;
}

describe("connecting an MCP client over OAuth", () => {
	it("points an unauthenticated client at GitHive's authorization server", async () => {
		const challenge = await call("/mcp", { method: "POST", body: "{}" });
		expect(challenge.status).toBe(401);
		expect(challenge.headers.get("WWW-Authenticate")).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
		const resource = await json(call("/.well-known/oauth-protected-resource/mcp"));
		expect(resource).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
		const server = await json(call("/.well-known/oauth-authorization-server"));
		expect(server).toMatchObject({ authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/oauth/token`, registration_endpoint: `${ORIGIN}/oauth/register` });
	});

	it("asks a person who isn't signed in to sign in first, and comes back to the same request", async () => {
		const { authorizeUrl } = await startConnecting();
		const page = await (await call(authorizeUrl)).text();
		expect(page).toContain("Sign in to connect Claude Code");
		expect(page).toContain(`/auth/github?return=${encodeURIComponent(authorizeUrl)}`);
	});

	it("shows the client, where access goes, and a warning for a local app; and escapes what the client chose", async () => {
		const registered = await json(call("/oauth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "<script>x</script>", redirect_uris: [CLIENT_REDIRECT], token_endpoint_auth_method: "none" }) }));
		const { challenge } = await pkce();
		const url = `/authorize?${new URLSearchParams({ response_type: "code", client_id: registered.client_id, redirect_uri: CLIENT_REDIRECT, scope: "mcp", state: "st", code_challenge: challenge, code_challenge_method: "S256" })}`;
		const page = await call(url, { headers: { Cookie: session } });
		const text = await page.text();
		expect(text).not.toContain("<script>x</script>");
		expect(text).toContain("&#60;script&#62;");
		expect(text).toContain("127.0.0.1");
		expect(text).toContain("Access goes to an app on this computer (<strong>127.0.0.1</strong>)");
		expect(text).toContain("this is expected if you just started connecting from one");
		expect(page.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
	});

	it("suggests a new agent named for the app, or picks the agent already named for it", async () => {
		const { authorizeUrl } = await startConnecting();
		const first = await (await call(authorizeUrl, { headers: { Cookie: session } })).text();
		expect(first).toContain("<h1>Connect Claude Code to GitHive</h1>");
		expect(first).toMatch(/value="new" checked/);
		expect(first).toContain('name="new_name" aria-label="New agent\'s name" value="claude-code"');
		const agent = await ids.createAgent(userId, "claude-code");
		const again = await (await call(authorizeUrl, { headers: { Cookie: session } })).text();
		expect(again).toContain(`value="${agent.id}" checked`);
		expect(again).not.toMatch(/value="new" checked/);
	});

	it("issues a token for the agent the person chose, which calls MCP as <handle>/<agent> until the agent is revoked", async () => {
		const { clientId, authorizeUrl, verifier } = await startConnecting();
		const approved = await allow(authorizeUrl, "new", "claude-code");
		expect(approved.status).toBe(302);
		const back = new URL(approved.headers.get("Location")!);
		expect(back.origin + back.pathname).toBe(CLIENT_REDIRECT);
		expect(back.searchParams.get("state")).toBe("st");
		const token = await json(
			call("/oauth/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: CLIENT_REDIRECT, client_id: clientId, code_verifier: verifier, resource: `${ORIGIN}/mcp` }).toString(),
			}),
		);
		expect(token.access_token).toEqual(expect.any(String));
		const mcp = (body: unknown) => call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
		const init = await json(mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
		expect(init.result.instructions).toMatch(/signed in to GitHive as the agent ada\/claude-code/);

		// The person sees the connection, named for the client and the agent.
		const connections = await json(call("/me/connections", { headers: { Cookie: session } }));
		expect(connections).toEqual([expect.objectContaining({ client: "Claude Code", agent: "ada/claude-code" })]);

		// Revoking the agent cuts the client off at its next call.
		const agent = (await ids.agents(userId)).find((a) => a.name === "claude-code")!;
		await call(`/me/agents/${agent.id}`, { method: "DELETE", headers: { Cookie: session, Origin: ORIGIN } });
		expect((await mcp({ jsonrpc: "2.0", id: 2, method: "ping" })).status).toBe(401);
		expect(await json(call("/me/connections", { headers: { Cookie: session } }))).toEqual([]);
	});

	it("shows the form again for a bad new agent name, and the same form still works after", async () => {
		const { authorizeUrl } = await startConnecting();
		const pageResponse = await call(authorizeUrl, { headers: { Cookie: session } });
		const handle = (await pageResponse.text()).match(/name="handle" value="([^"]+)"/)![1];
		const headers = { Cookie: `${session}; ${cookiesOf(pageResponse)}`, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" };
		const bad = await call(authorizeUrl, { method: "POST", headers, body: new URLSearchParams({ handle, decision: "approve", agent: "new", new_name: "Bad Name!" }).toString() });
		expect(bad.status).toBe(400);
		expect(await bad.text()).toContain("lowercase letters, digits or dashes");
		const good = await call(authorizeUrl, { method: "POST", headers, body: new URLSearchParams({ handle, decision: "approve", agent: "new", new_name: "claude-code" }).toString() });
		expect(good.status).toBe(302);
	});

	it("sends the client away with access_denied when the person denies it", async () => {
		const { authorizeUrl } = await startConnecting();
		const pageResponse = await call(authorizeUrl, { headers: { Cookie: session } });
		const handle = (await pageResponse.text()).match(/name="handle" value="([^"]+)"/)![1];
		const denied = await call(authorizeUrl, { method: "POST", headers: { Cookie: `${session}; ${cookiesOf(pageResponse)}`, Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ handle, decision: "deny" }).toString() });
		expect(denied.status).toBe(302);
		expect(new URL(denied.headers.get("Location")!).searchParams.get("error")).toBe("access_denied");
	});

	it("still takes an agent token on /mcp, without OAuth", async () => {
		const agent = await ids.createAgent(userId, "builder");
		const { token } = await ids.createToken(userId, agent.id);
		const init = await json(call("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) }));
		expect(init.result.instructions).toMatch(/as the agent ada\/builder/);
	});
});

describe("the name a new agent is offered", () => {
	it("comes from the app's own name", async () => {
		const { suggestedAgentName } = await import("../src/auth/authorize");
		expect(suggestedAgentName("Claude Code (githive)")).toBe("claude-code");
		expect(suggestedAgentName("Codex")).toBe("codex");
		expect(suggestedAgentName("  My Agent!! v2  ")).toBe("my-agent-v2");
		expect(suggestedAgentName("<script>")).toBe("script");
		expect(suggestedAgentName("a".repeat(40))).toHaveLength(32);
	});
});
