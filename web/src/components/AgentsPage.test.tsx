import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Connection, MyAgent } from "../api";
import { calendarDate } from "../lib/myAgents";
import { NOW, ago, inlineText, visibleText } from "../test/fixtures";
import { AgentLimitsPanel, LimitField, nextLimit } from "./AgentLimitsPanel";
import { AgentCard, TokenMade, revokeWords } from "./AgentRow";
import { ConnectSection } from "./AgentsConnect";
import { AgentsView, type AgentActions } from "./AgentsPage";
import { CopyBlock } from "./CopyBlock";
import { TopBar } from "./TopBar";
import { Dialog } from "./ui/dialog";

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

describe("Your agents", () => {
	it("is titled Your agents", () => {
		expect(render()).toMatch(/<h1[^>]*>Your agents<\/h1>/);
	});

	it("explains both ways to connect: Claude Code step by step with this address's command, or a token", () => {
		const text = visibleText(render());
		expect(text).toContain("claude mcp add --scope user --transport http githive https://githive.app/mcp");
		expect(text).toContain("Sign in from Claude Code");
		expect(text).toContain("Codex");
		expect(text).toContain("Or use a token");
		// A new token's commands come with the token filled in, so no placeholder is left.
		expect(text).not.toContain("Bearer token");
	});

	it("ends connecting with what to ask the agent, naming one of your repos, which you may choose", () => {
		const one = visibleText(render({ repos: ["ada/notes"] }));
		expect(one).toContain("Give it work. Ask it, for example:");
		expect(one).toContain("Use GitHive to improve the README in ada/notes.");
		const several = render({ repos: ["ada/notes", "ada/site"] });
		expect(several).toMatch(/<select[^>]*>.*<option value="ada\/notes" selected="">ada\/notes<\/option>.*ada\/site/s);
		const none = render({ repos: [] });
		expect(visibleText(none)).toContain("make a repository first");
		expect(none).toContain('href="#/new"');
	});

	it("says when the agent being connected has come", () => {
		const section = (watch: Parameters<typeof ConnectSection>[0]["watch"]) =>
			visibleText(
				renderToStaticMarkup(
					<ConnectSection
						client="claude-code"
						chooseClient={() => {}}
						origin="https://githive.app"
						yourClient="Claude Code"
						clientLabel="Claude Code"
						{...(watch ? { watch } : {})}
					/>,
				),
			);
		expect(section({ kind: "waiting" })).toContain("Waiting for Claude Code to connect…");
		expect(section({ kind: "found", connection: connections[0]! })).toContain("Claude Code connected as ada/builder ✓");
		expect(section({ kind: "gave-up" })).toContain("No new connection yet.");
		expect(section(undefined)).not.toContain("Waiting");
	});

	it("keeps each flag of a command whole, so it wraps at its spaces and never inside a flag", () => {
		const html = renderToStaticMarkup(<CopyBlock text="claude mcp add --scope user --transport http githive" />);
		expect(html).toContain('<span class="whitespace-nowrap">--transport</span>');
		expect(html).toContain("claude mcp add ");
		// What isn't a flag (a token, a URL) may still break where it must.
		const long = renderToStaticMarkup(<CopyBlock text={`Bearer ghv_${"x".repeat(60)}`} />);
		expect(long).not.toContain('<span class="whitespace-nowrap">');
	});

	it("shows each agent in a card: its state, the app it signs in from with Disconnect, and its tokens folded away", () => {
		const html = render();
		const text = visibleText(html);
		expect(text).toContain("ada/builder");
		expect(text).toContain("Connected 10 minutes ago · a token used 5 minutes ago");
		expect(text).toContain("Signs in from Claude Code");
		expect(text).toContain("Disconnect");
		// The app sits in its agent's card, not in a list of its own that names the agent again.
		expect(text).not.toContain("Other connected apps");
		expect(html).toMatch(/<details class="disclosure"><summary[^>]*>Tokens \(1 of 2 not revoked\)<\/summary>/);
		expect(text).toContain("ghv_Ab3dEf9h…");
		expect(text).toContain(`expires ${calendarDate("2027-01-06T12:00:00.000Z")}`);
		expect(text).toContain("used 5 minutes ago");
		expect(text).toContain("never expires");
		expect(text).toContain("never used");
		expect(text).toContain("New token…");
		// The expiry is chosen in the new token's dialog, not beside the agent as if it were the agent's.
		expect(html).not.toContain("Expires in 90 days");
	});

	it("asks before disconnecting an app, saying it can't act as the agent until it signs in again", () => {
		const html = renderToStaticMarkup(
			<AgentCard
				agent={agents[0]!}
				fullName="ada/builder"
				apps={connections}
				error={null}
				setError={() => undefined}
				client="claude-code"
				origin="https://githive.app"
				actions={actions}
				run={async () => true}
				busy={null}
				confirming="conn:g1"
				setConfirming={() => undefined}
				now={NOW}
			/>,
		);
		expect(inlineText(html)).toContain("Disconnect Claude Code? It can't act as ada/builder until it signs in again.");
		expect(html).toMatch(/<button[^>]*>Keep it connected<\/button>/);
		expect(html).toMatch(/<button[^>]*>Yes, disconnect<\/button>/);
	});

	it("says an agent with no tokens signs in from its connected app, or just that it has none yet", () => {
		const signedIn: MyAgent = { ...agents[0]!, id: "a3", name: "claude-code", tokens: [] };
		const bare: MyAgent = { ...agents[0]!, id: "a4", name: "spare", tokens: [] };
		const text = visibleText(
			render({
				agents: [signedIn, bare],
				connections: [{ id: "g2", client: "Claude Code", agentId: "a3", agent: "ada/claude-code", createdAt: ago(5) }],
			}),
		);
		expect(text).toContain("so it needs no token.");
		expect(text).toContain("No tokens yet.");
		expect(text).toContain("Not connected yet");
	});

	it("revokes an agent from its ⋯ menu, asking first what it does", () => {
		const html = render();
		expect(html).toContain('aria-label="More for ada/builder"');
		expect(visibleText(html)).toContain("Revoke agent…");
		expect(revokeWords([connections[0]!])).toBe(
			"Its tokens stop working at once, and Claude Code is disconnected; its open claims stay until freed.",
		);
		expect(revokeWords([])).toBe("Its tokens stop working at once; its open claims stay until freed.");
	});

	it("folds the revoked agents away under how many, each saying so in a badge at full contrast", () => {
		const html = render();
		expect(html).toMatch(/<details class="disclosure[^"]*"><summary[^>]*>Revoked \(1\)<\/summary>/);
		expect(visibleText(html)).toContain("ada/old-reviewer");
		expect(html).not.toContain("opacity-70");
		// A revoked agent has no menu and no tokens to make.
		expect(html).not.toContain("More for ada/old-reviewer");
	});

	it("keeps an app tied to none of your agents in a list of its own", () => {
		const loose: Connection = { id: "g9", client: "Zed", agentId: null, agent: null, createdAt: ago(60) };
		const text = visibleText(render({ connections: [...connections, loose] }));
		expect(text).toContain("Other connected apps");
		expect(text).toContain("Zed as no agent");
	});

	it("folds revoked agents away under the active ones, saying how to bring one back", () => {
		const html = render();
		// The fold comes last, under the active agents.
		const folded = html.slice(html.lastIndexOf("<summary", html.indexOf("Revoked (")));
		expect(visibleText(folded)).toMatch(/^\s*Revoked \(1\)/);
		expect(visibleText(folded)).toContain("ada/old-reviewer");
		expect(visibleText(folded)).toContain("Name one of these again above to bring it back");
		expect(folded).not.toContain("ada/builder");
		// Only revoked agents: none active, and the fold still there.
		const onlyRevoked = render({ agents: agents.filter((agent) => agent.revokedAt) });
		expect(visibleText(onlyRevoked)).toContain("No active agents.");
		expect(onlyRevoked).toContain('<details class="disclosure');
	});

	it("shows each active agent's limits on work for other people, building none of theirs by default", () => {
		const html = render();
		expect(visibleText(html)).toContain("Work for other people, in repos you share with them");
		// No limits recorded yet: the defaults, never building or reviewing theirs.
		expect(html).toMatch(/id="build-a1"[^>]*>.*?<option value="never" selected="">/s);
		expect(html).toMatch(/id="review-a1"[^>]*>.*?<option value="never" selected="">/s);
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
		const made = (warned: boolean) =>
			visibleText(
				renderToStaticMarkup(
					// Its title and description are the dialog's own.
					<Dialog>
						<TokenMade
							fullName="ada/builder"
							token="ghv_secretSECRETsecret"
							client="claude-code"
							origin="https://githive.app"
							warned={warned}
							onCopy={() => {}}
							onDone={() => {}}
						/>
					</Dialog>,
				),
			);
		const text = made(false);
		expect(text).toContain("New token for ada/builder");
		expect(text).toContain("Copy it now");
		expect(text).toContain("ghv_secretSECRETsecret");
		expect(text).toContain("--header Authorization: Bearer ghv_secretSECRETsecret");
		expect(text).toContain("Done");
		// Closing it before anything is copied asks first.
		expect(made(true)).toContain("copied it.");
		expect(made(true)).toContain("Close without copying");
	});

	it("invites a first agent when there are none", () => {
		const text = visibleText(render({ agents: [], connections: [] }));
		expect(text).toContain("No agents yet");
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
