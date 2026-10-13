import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Connection, MyAgent } from "../api";
import { NOW, ago, visibleText } from "../test/fixtures";
import { AgentLimitsPanel, LimitField, nextLimit } from "./AgentLimitsPanel";
import { AgentsView, type AgentActions } from "./AgentsPage";
import { TopBar } from "./TopBar";

// A menu draws its choices only once it's open, into a portal, and a server render has neither: here every menu
// renders open, in place, so the account menu's choices can be read.
vi.mock("radix-ui", async (importOriginal) => {
	const radix = await importOriginal<typeof import("radix-ui")>();
	const { createElement, Fragment } = await import("react");
	const { Root } = radix.DropdownMenu;
	return {
		...radix,
		DropdownMenu: {
			...radix.DropdownMenu,
			Root: (props: ComponentProps<typeof Root>) => createElement(Root, { ...props, open: true }),
			Portal: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
		},
	};
});

const me = {
	kind: "user" as const,
	handle: "ada",
	name: "Ada Lovelace",
	email: "ada@example.com",
	avatarUrl: null,
	by: "person:abc123def456",
};
const noop = async () => ({});
const actions: AgentActions = {
	createAgent: noop,
	revokeAgent: noop,
	setLimits: noop,
	createToken: async () => ({
		token: "ghv_x",
		id: "t",
		agentId: "a",
		prefix: "x",
		createdAt: ago(0),
		expiresAt: null,
		lastUsedAt: null,
		revokedAt: null,
	}),
	revokeToken: noop,
	disconnect: noop,
};

const agents: MyAgent[] = [
	{
		id: "a1",
		ownerId: "u1",
		name: "builder",
		createdAt: ago(60 * 24 * 2),
		revokedAt: null,
		tokens: [
			{
				id: "t1",
				agentId: "a1",
				prefix: "Ab3dEf9h",
				createdAt: ago(60),
				expiresAt: "2027-01-06T12:00:00.000Z",
				lastUsedAt: ago(5),
				revokedAt: null,
			},
			{
				id: "t2",
				agentId: "a1",
				prefix: "Zz00Yy11",
				createdAt: ago(120),
				expiresAt: null,
				lastUsedAt: null,
				revokedAt: ago(30),
			},
		],
	},
	{ id: "a2", ownerId: "u1", name: "old-reviewer", createdAt: ago(60 * 24 * 9), revokedAt: ago(60), tokens: [] },
];
const connections: Connection[] = [
	{ id: "g1", client: "Claude Code", agentId: "a1", agent: "ada/builder", createdAt: ago(10) },
];

const render = (props: Partial<Parameters<typeof AgentsView>[0]> = {}) =>
	renderToStaticMarkup(
		<AgentsView
			me={me}
			origin="https://githive.app"
			agents={agents}
			connections={connections}
			actions={actions}
			now={NOW}
			{...props}
		/>,
	);

describe("the Agents page", () => {
	it("explains both ways to connect: Claude Code step by step with this address's command, or a token", () => {
		const text = visibleText(render());
		expect(text).toContain("claude mcp add --scope user --transport http githive https://githive.app/mcp");
		expect(text).toContain("Sign in from Claude Code");
		expect(text).toContain("Codex");
		expect(text).toContain("Or use a token");
		// A new token's commands come with the token filled in, so no placeholder is left.
		expect(text).not.toContain("Bearer token");
	});

	it("says an agent with no tokens signs in from its connected app, or just that it has none yet", () => {
		const signedIn: MyAgent = {
			id: "a3",
			ownerId: "u1",
			name: "claude-code",
			createdAt: ago(30),
			revokedAt: null,
			tokens: [],
		};
		const bare: MyAgent = { id: "a4", ownerId: "u1", name: "spare", createdAt: ago(30), revokedAt: null, tokens: [] };
		const text = visibleText(
			render({
				agents: [signedIn, bare],
				connections: [{ id: "g2", client: "Claude Code", agentId: "a3", agent: "ada/claude-code", createdAt: ago(5) }],
			}),
		);
		expect(text).toContain("Signs in from Claude Code, so it needs no token.");
		expect(text).toContain("No tokens yet.");
		expect(text).not.toContain("which needs none");
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

	it("shows each active agent's limits on work for other people, building none of theirs by default", () => {
		const html = render();
		expect(visibleText(html)).toContain("Work for other people, in repos you share with them");
		// No limits recorded yet: the defaults, never building theirs and reviewing without limit.
		expect(html).toMatch(/id="build-a1"[^>]*>.*?<option value="never" selected="">/s);
		expect(html).toMatch(/id="review-a1"[^>]*>.*?<option value="any" selected="">/s);
		const limited = render({
			agents: [{ ...agents[0]!, limits: { build: 3, review: 0 }, today: { build: 2, review: 0 } }],
		});
		expect(limited).toMatch(/id="build-a1"[^>]*>.*?<option value="daily" selected="">/s);
		expect(limited).toContain('value="3"');
		expect(visibleText(limited)).toContain("2 today");
		// A revoked agent does nothing, so it has no limits to set.
		expect(html).not.toContain('id="build-a2"');
	});

	describe("an owner limit", () => {
		const field = (props: Partial<Parameters<typeof LimitField>[0]> = {}) =>
			renderToStaticMarkup(
				<LimitField id="build-a1" label="Build" limit={3} done={0} save={async () => true} {...props} />,
			);

		it("doesn't save a daily limit until a whole number of at least 1 is given", () => {
			expect(nextLimit("daily", 0)).toBeUndefined();
			expect(nextLimit("daily", Number(""))).toBeUndefined();
			expect(nextLimit("daily", Number("-2"))).toBeUndefined();
			expect(nextLimit("daily", Number("1e999"))).toBeUndefined();
			expect(nextLimit("daily", 3)).toBe(3);
			expect(nextLimit("daily", 2.5)).toBe(2);
			expect(nextLimit("never", 3)).toBe(0);
			expect(nextLimit("any", 3)).toBeNull();
		});

		it("says when a limit was saved, and only then", () => {
			expect(field()).toContain('role="status"');
			expect(visibleText(field())).not.toContain("Saved");
			expect(visibleText(field({ saved: true }))).toContain("Saved");
		});

		it("stays in reach while something else saves", () => {
			const panel = renderToStaticMarkup(
				<AgentLimitsPanel agent={agents[0]!} actions={actions} run={async () => true} setError={() => {}} />,
			);
			expect(panel).not.toMatch(/<fieldset[^>]*disabled/);
		});
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
		const html = renderToStaticMarkup(
			<TopBar crumbs={[]} me={{ kind: "access", label: "admin@example.com", by: "person:x" }} />,
		);
		expect(visibleText(html)).toContain("admin@example.com");
		expect(html).not.toContain("Sign out");
		expect(html).not.toContain("#/settings/agents");
	});
});
