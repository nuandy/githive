import { describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { approval, grantWarnings, holdsRole, peopleOnly, type VoteRecord } from "../src/toolkit/votes";
import { startGitServer } from "./helpers/git-server";

// A role that can block a merge (a veto role, like security) counts only from
// whoever the repo's owner granted it: by default people and GitHive's own
// reviewers; an agent only when named, and only voting with its own key.
// Anyone else's verdict under that role counts as an ordinary one.

const head = "h1";
const cast = (
	reviewer: string,
	by: string | undefined,
	role = "review",
	verdict: "approve" | "reject" = "approve",
): VoteRecord => ({ commit: head, reviewer, role, verdict, evidence: "ok", at: "", ...(by ? { by } : {}) });

describe("who holds a role", () => {
	const granted = {
		required: 1,
		vetoes: ["security"],
		grants: { security: ["security-1", "person:*", "service:sec-token"] },
	};
	const ungranted = { required: 1, vetoes: ["security"] };

	it("by default: people and GitHive's own reviewer for the role, no agent", () => {
		expect(holdsRole(ungranted, "security", cast("person:ana", "person:ana"))).toBe(true);
		expect(holdsRole(ungranted, "security", cast("githive-security", "service:githive-reviewer:security"))).toBe(true);
		expect(holdsRole(ungranted, "security", cast("githive-tests", "service:githive-reviewer:tests"))).toBe(false);
		expect(holdsRole(ungranted, "security", cast("security-1", "service:x/security-1"))).toBe(false);
	});

	it("by default also GitHive's hosted agents, each reviewing under its own name", () => {
		expect(holdsRole(ungranted, "security", cast("githive-scout", "service:githive-scout"))).toBe(true);
		expect(holdsRole(ungranted, "security", cast("githive-scout", undefined))).toBe(true);
		// A name that isn't one of theirs, or an agent of a person's calling itself one.
		expect(holdsRole(ungranted, "security", cast("githive-wasp", "service:githive-wasp"))).toBe(false);
		expect(holdsRole(ungranted, "security", cast("githive-scout", "service:x/githive-scout"))).toBe(false);
	});

	it("an agent named in the grant, voting with its own key: its name can't be borrowed", () => {
		expect(holdsRole(granted, "security", cast("security-1", "service:x/security-1"))).toBe(true);
		// Another agent's key, calling itself security-1.
		expect(holdsRole(granted, "security", cast("security-1", "service:x/agent-b"))).toBe(false);
		// The shared Access identity with no agent key.
		expect(holdsRole(granted, "security", cast("security-1", "service:x"))).toBe(false);
		// A verified identity named exactly, and unsigned records by name.
		expect(holdsRole(granted, "security", cast("sec", "service:sec-token"))).toBe(true);
		expect(holdsRole(granted, "security", cast("security-1", undefined))).toBe(true);
	});

	it("counts a verdict under a role from someone not granted it as an ordinary one, and says so", () => {
		const policy = { required: 1, vetoes: ["security"], grants: { security: ["security-1"] } };
		const votes = {
			votes: [cast("rev-1", "service:x/rev-1", "security"), cast("rev-2", "service:x/rev-2", "security", "reject")],
		};
		expect(approval(votes, head, policy)).toEqual({
			approved: false,
			approvals: 1,
			vetoedBy: [],
			awaiting: ["security"],
			ungranted: ["rev-1 (security)", "rev-2 (security)"],
		});
		const held = { votes: [...votes.votes, cast("security-1", "service:x/security-1", "security")] };
		expect(approval(held, head, policy)).toMatchObject({ approved: true, approvals: 2, awaiting: [] });
	});
});

describe("pools of agents holding a role", () => {
	const policy = { required: 1, vetoes: ["security"], grants: { security: ["service:sec-team/*"] } };

	it("counts any agent registered under the pool's identity, voting with its key, however many there are", () => {
		for (const n of [1, 2, 9])
			expect(
				holdsRole(policy, "security", cast(`sec-${n}`, `service:sec-team/sec-${n}`), {
					by: "service:dev-team/builder",
				}),
			).toBe(true);
		// Not the identity itself without an agent key, nor another identity, nor a name that looks the part.
		expect(holdsRole(policy, "security", cast("sec", "service:sec-team"))).toBe(false);
		expect(holdsRole(policy, "security", cast("sec-1", "service:other/sec-1"))).toBe(false);
		expect(holdsRole(policy, "security", cast("sec-team", undefined))).toBe(false);
	});

	it("never counts a pool member as the role on its own team's change", () => {
		expect(
			holdsRole(policy, "security", cast("sec-1", "service:sec-team/sec-1"), { by: "service:sec-team/sec-2" }),
		).toBe(false);
		const votes = { votes: [cast("sec-1", "service:sec-team/sec-1", "security")] };
		expect(approval(votes, head, policy, { agent: "sec-2", by: "service:sec-team/sec-2" })).toMatchObject({
			approved: false,
			awaiting: ["security"],
			ungranted: ["sec-1 (security)"],
		});
		expect(approval(votes, head, policy, { agent: "builder", by: "service:dev-team/builder" })).toMatchObject({
			approved: true,
			awaiting: [],
		});
	});
});

describe("warnings about who holds a role", () => {
	it("warns when one agent or identity holds a role, and when no person does", () => {
		expect(grantWarnings({ required: 1, vetoes: ["security"] })).toEqual([]);
		expect(grantWarnings({ required: 1, vetoes: ["security"], grants: { security: ["sec-1"] } })).toEqual([
			expect.stringMatching(/^security is held by sec-1 alone: its reviews wait whenever it's busy/),
			expect.stringMatching(/^no person holds security/),
		]);
		expect(
			grantWarnings({
				required: 1,
				vetoes: [],
				escalate: [{ paths: ["package.json"], vetoes: ["security"] }],
				grants: { security: ["service:sec-team/*"] },
			}),
		).toEqual([expect.stringMatching(/^no person holds security/)]);
		expect(
			grantWarnings({ required: 1, vetoes: ["security"], grants: { security: ["sec-1", "sec-2", "person:*"] } }),
		).toEqual([]);
	});

	it("knows a role only people may vote as: its waiting reviews need a person", () => {
		const policy = (holders?: string[]) => ({
			required: 1,
			vetoes: ["security"],
			...(holders ? { grants: { security: holders } } : {}),
		});
		expect(peopleOnly(policy(["person:*"]), "security")).toBe(true);
		expect(peopleOnly(policy(["person:ada", "@acme/security"]), "security")).toBe(true);
		// GitHive's reviewers hold it by default, and a pool is agents.
		expect(peopleOnly(policy(), "security")).toBe(false);
		expect(peopleOnly(policy(["person:*", "service:sec-team/*"]), "security")).toBe(false);
		expect(peopleOnly(policy([]), "security")).toBe(false);
	});
});

describe("granting roles through the toolkit", { timeout: 60_000 }, () => {
	it("records grants at the start, refuses bad ones, and counts the granted agent's vote only", async () => {
		const server = await startGitServer();
		try {
			const ctx: ToolContext = {
				remote: async () => ({ url: server.url, token: "unused" }),
				head: async () => server.git("rev-parse", "main").trim(),
			};
			const call = async (name: string, args: Record<string, unknown>, agentKey?: string) => {
				try {
					return (await callTool(
						name,
						{ repo: "p", ...args },
						{ ...ctx, ...(agentKey ? { agentKey } : {}) },
					)) as Record<string, unknown>;
				} catch (err) {
					return { error: statusOf(err).message };
				}
			};
			expect(await call("settings", { required: 1, vetoes: ["security"], grants: { security: "security-1" } })).toEqual(
				{ error: expect.stringMatching(/grants.security is a list/) },
			);
			expect(
				await call("settings", { required: 1, vetoes: ["security"], grants: { security: ["security-1"] } }),
			).toMatchObject({
				policy: { grants: { security: ["security-1"] } },
				warnings: [
					expect.stringMatching(/held by security-1 alone/),
					expect.stringMatching(/no person holds security/),
				],
			});
			// Nothing signs these records here, so roles go by name; a registered name needs its key.
			const { key } = (await call("register", { agent: "security-1" })) as { key: string };
			expect(
				await call("vote", {
					commit: head,
					reviewer: "security-1",
					role: "security",
					verdict: "approve",
					evidence: "ok",
				}),
			).toEqual({ error: expect.stringMatching(/registered/) });
			expect(
				await call(
					"vote",
					{ commit: head, reviewer: "security-1", role: "security", verdict: "approve", evidence: "ok" },
					key,
				),
			).toMatchObject({ ok: true });
		} finally {
			await server.close();
		}
	});
});

describe("roles granted to a team", () => {
	const policy = { required: 1, vetoes: ["security"], grants: { security: ["@acme/security"] } };
	const onTeam = (reviewer: string, teams: string[]): VoteRecord => ({
		...cast(reviewer, `person:${reviewer}`, "security"),
		...(teams.length ? { teams } : {}),
	});

	it("counts the vote of whoever was on the team when they voted, and nobody else's", () => {
		expect(holdsRole(policy, "security", onTeam("ana", ["@acme/security"]))).toBe(true);
		expect(holdsRole(policy, "security", onTeam("bob", []))).toBe(false);
		// Another org's team of the same name is another team.
		expect(holdsRole(policy, "security", onTeam("cy", ["@other/security"]))).toBe(false);
		expect(approval({ votes: [onTeam("ana", ["@acme/security"])] }, head, policy)).toMatchObject({
			approved: true,
			awaiting: [],
		});
	});

	it("needs no warning: a team is people, however many", () => {
		expect(grantWarnings(policy)).toEqual([]);
	});
});

describe("team grants through the toolkit", { timeout: 60_000 }, () => {
	it("records the voter's teams in their vote, so a new member's vote counts without changing the grant", async () => {
		const { GitCasLog } = await import("../src/record-log");
		const server = await startGitServer();
		try {
			const teams = new Map<string, string[]>([["ada/sec", ["@acme/security"]]]);
			const as = (agent: string): ToolContext => ({
				remote: async () => ({ url: server.url, token: "unused" }),
				head: async () => server.git("rev-parse", "main").trim(),
				agent,
				teamsOf: async () => teams.get(agent) ?? [],
			});
			const call = (agent: string, name: string, args: Record<string, unknown>) =>
				callTool(name, { repo: "p", ...args }, as(agent));
			expect(
				await call("ada/sec", "settings", {
					required: 1,
					vetoes: ["security"],
					grants: { security: ["@acme/security"] },
				}),
			).toMatchObject({ policy: { grants: { security: ["@acme/security"] } } });
			await call("ada/sec", "vote", { commit: head, role: "security", verdict: "approve", evidence: "ok" });
			await call("bob/sec", "vote", { commit: head, role: "security", verdict: "approve", evidence: "ok" });
			// bob joins the team; the grant stays as it was.
			teams.set("bob/sec", ["@acme/security"]);
			await call("bob/sec", "vote", { commit: "h2", role: "security", verdict: "approve", evidence: "ok" });
			const votes = (await new GitCasLog<{ votes: VoteRecord[] }>(
				async () => ({ url: server.url, token: "unused" }),
				"p",
				"refs/notes/githive-votes/p",
			).read())!.commit.state.votes;
			expect(votes.map((v) => [v.reviewer, v.commit, v.teams ?? []])).toEqual([
				["ada/sec", head, ["@acme/security"]],
				["bob/sec", head, []],
				["bob/sec", "h2", ["@acme/security"]],
			]);
			const policy = { required: 1, vetoes: ["security"], grants: { security: ["@acme/security"] } };
			expect(votes.map((v) => holdsRole(policy, "security", v))).toEqual([true, false, true]);
		} finally {
			await server.close();
		}
	});
});
