import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Connection, MyAgent } from "../api";
import { NOW, ago, visibleText } from "../test/fixtures";
import { AgentsView, type AgentActions } from "./AgentsPage";
import { TopBar } from "./TopBar";

const me = { kind: "user" as const, handle: "ada", name: "Ada Lovelace", email: "ada@example.com", avatarUrl: null, by: "person:abc123def456" };
const noop = async () => ({});
const actions: AgentActions = { createAgent: noop, revokeAgent: noop, createToken: async () => ({ token: "ghv_x", id: "t", agentId: "a", prefix: "x", createdAt: ago(0), expiresAt: null, lastUsedAt: null, revokedAt: null }), revokeToken: noop, disconnect: noop };

const agents: MyAgent[] = [
	{
		id: "a1",
		ownerId: "u1",
		name: "builder",
		createdAt: ago(60 * 24 * 2),
		revokedAt: null,
		tokens: [
			{ id: "t1", agentId: "a1", prefix: "Ab3dEf9h", createdAt: ago(60), expiresAt: "2027-01-06T12:00:00.000Z", lastUsedAt: ago(5), revokedAt: null },
			{ id: "t2", agentId: "a1", prefix: "Zz00Yy11", createdAt: ago(120), expiresAt: null, lastUsedAt: null, revokedAt: ago(30) },
		],
	},
	{ id: "a2", ownerId: "u1", name: "old-reviewer", createdAt: ago(60 * 24 * 9), revokedAt: ago(60), tokens: [] },
];
const connections: Connection[] = [{ id: "g1", client: "Claude Code", agentId: "a1", agent: "ada/builder", createdAt: ago(10) }];

const render = (props: Partial<Parameters<typeof AgentsView>[0]> = {}) =>
	renderToStaticMarkup(<AgentsView me={me} origin="https://githive.app" agents={agents} connections={connections} actions={actions} now={NOW} {...props} />);

describe("the Agents page", () => {
	it("explains both ways to connect, with this address's commands", () => {
		const text = visibleText(render());
		expect(text).toContain("claude mcp add --transport http githive https://githive.app/mcp");
		expect(text).toContain("--header Authorization: Bearer token");
		expect(text).toContain("Sign in from the app");
		expect(text).toContain("With a token");
	});

	it("lists your agents by full name with their tokens, never a token's secret", () => {
		const html = render();
		const text = visibleText(html);
		expect(text).toContain("ada/builder");
		expect(text).toContain("ghv_Ab3dEf9h…");
		expect(text).toContain("expires 2027-01-06");
		expect(text).toContain("used 5 minutes ago");
		expect(text).toContain("never expires");
		expect(text).toContain("never used");
		expect(text).toContain("ada/old-reviewer");
		expect(text).toMatch(/Revoked/);
		// The active agent can get a token and be revoked; the revoked one can't.
		expect(text).toContain("New token");
		expect(html.match(/Expires in 90 days/g)).toHaveLength(1);
		expect(html).toContain('<option value="90" selected="">');
	});

	it("shows a new token once, with the command that uses it", () => {
		const text = visibleText(render({ initialIssued: { agentId: "a1", token: "ghv_secretSECRETsecret" } }));
		expect(text).toContain("Copy it now");
		expect(text).toContain("ghv_secretSECRETsecret");
		expect(text).toContain("--header Authorization: Bearer ghv_secretSECRETsecret");
	});

	it("lists connected apps with the agent each acts as", () => {
		const text = visibleText(render());
		expect(text).toContain("Claude Code");
		expect(text).toContain("as ada/builder");
		expect(text).toContain("Disconnect");
	});

	it("invites a first agent when there are none", () => {
		const text = visibleText(render({ agents: [], connections: [] }));
		expect(text).toContain("No agents yet");
		expect(text).toContain("No apps connected over OAuth yet");
	});
});

describe("the top bar's account menu", () => {
	it("shows a signed-in person's initial and handle, with Agents and Sign out", () => {
		const html = renderToStaticMarkup(<TopBar crumbs={[]} me={me} onSignOut={() => undefined} />);
		expect(visibleText(html)).toContain("ada");
		expect(html).toContain('href="#/settings/agents"');
		expect(visibleText(html)).toContain("Sign out");
		expect(html).toContain(">A<");
	});

	it("shows an Access caller's label quietly, with no account menu", () => {
		const html = renderToStaticMarkup(<TopBar crumbs={[]} me={{ kind: "access", label: "admin@example.com", by: "person:x" }} />);
		expect(visibleText(html)).toContain("admin@example.com");
		expect(html).not.toContain("Sign out");
		expect(html).not.toContain("#/settings/agents");
	});
});
