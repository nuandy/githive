import { describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import { callFreeTool, type FreeContext } from "../src/free/mcp";
import { approval, grantWarnings, holdsRole, type VoteRecord } from "../src/free/votes";
import { startGitServer } from "./helpers/git-server";

// A role that can block a merge (a veto role, like security) counts only from
// whoever the repo's owner granted it: by default people and Blueprint's own
// reviewers; an agent only when named, and only voting with its own key.
// Anyone else's verdict under that role counts as an ordinary one.

const head = "h1";
const cast = (reviewer: string, by: string | undefined, role = "review", verdict: "approve" | "reject" = "approve"): VoteRecord => ({ commit: head, reviewer, role, verdict, evidence: "ok", at: "", ...(by ? { by } : {}) });

describe("who holds a role", () => {
	const granted = { required: 1, vetoes: ["security"], grants: { security: ["security-1", "person:*", "service:sec-token"] } };
	const ungranted = { required: 1, vetoes: ["security"] };

	it("by default: people and Blueprint's own reviewer for the role, no agent", () => {
		expect(holdsRole(ungranted, "security", cast("person:ana", "person:ana"))).toBe(true);
		expect(holdsRole(ungranted, "security", cast("blueprint-security", "service:blueprint-reviewer:security"))).toBe(true);
		expect(holdsRole(ungranted, "security", cast("blueprint-tests", "service:blueprint-reviewer:tests"))).toBe(false);
		expect(holdsRole(ungranted, "security", cast("security-1", "service:x/security-1"))).toBe(false);
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
		const votes = { votes: [cast("rev-1", "service:x/rev-1", "security"), cast("rev-2", "service:x/rev-2", "security", "reject")] };
		expect(approval(votes, head, policy)).toEqual({ approved: false, approvals: 1, vetoedBy: [], awaiting: ["security"], ungranted: ["rev-1 (security)", "rev-2 (security)"] });
		const held = { votes: [...votes.votes, cast("security-1", "service:x/security-1", "security")] };
		expect(approval(held, head, policy)).toMatchObject({ approved: true, approvals: 2, awaiting: [] });
	});
});

describe("pools of agents holding a role", () => {
	const policy = { required: 1, vetoes: ["security"], grants: { security: ["service:sec-team/*"] } };

	it("counts any agent registered under the pool's identity, voting with its key, however many there are", () => {
		for (const n of [1, 2, 9]) expect(holdsRole(policy, "security", cast(`sec-${n}`, `service:sec-team/sec-${n}`), { by: "service:dev-team/builder" })).toBe(true);
		// Not the identity itself without an agent key, nor another identity, nor a name that looks the part.
		expect(holdsRole(policy, "security", cast("sec", "service:sec-team"))).toBe(false);
		expect(holdsRole(policy, "security", cast("sec-1", "service:other/sec-1"))).toBe(false);
		expect(holdsRole(policy, "security", cast("sec-team", undefined))).toBe(false);
	});

	it("never counts a pool member as the role on its own team's change", () => {
		expect(holdsRole(policy, "security", cast("sec-1", "service:sec-team/sec-1"), { by: "service:sec-team/sec-2" })).toBe(false);
		const votes = { votes: [cast("sec-1", "service:sec-team/sec-1", "security")] };
		expect(approval(votes, head, policy, { agent: "sec-2", by: "service:sec-team/sec-2" })).toMatchObject({ approved: false, awaiting: ["security"], ungranted: ["sec-1 (security)"] });
		expect(approval(votes, head, policy, { agent: "builder", by: "service:dev-team/builder" })).toMatchObject({ approved: true, awaiting: [] });
	});
});

describe("warnings about who holds a role", () => {
	it("warns when one agent or identity holds a role, and when no person does", () => {
		expect(grantWarnings({ required: 1, vetoes: ["security"] })).toEqual([]);
		expect(grantWarnings({ required: 1, vetoes: ["security"], grants: { security: ["sec-1"] } })).toEqual([
			expect.stringMatching(/^security is held by sec-1 alone: its reviews wait whenever it's busy/),
			expect.stringMatching(/^no person holds security/),
		]);
		expect(grantWarnings({ required: 1, vetoes: [], escalate: [{ paths: ["package.json"], vetoes: ["security"] }], grants: { security: ["service:sec-team/*"] } })).toEqual([expect.stringMatching(/^no person holds security/)]);
		expect(grantWarnings({ required: 1, vetoes: ["security"], grants: { security: ["sec-1", "sec-2", "person:*"] } })).toEqual([]);
	});
});

describe("granting roles through the toolkit", { timeout: 60_000 }, () => {
	it("records grants at the start, refuses bad ones, and counts the granted agent's vote only", async () => {
		const server = await startGitServer();
		try {
			const ctx: FreeContext = { remote: async () => ({ url: server.url, token: "unused" }), head: async () => server.git("rev-parse", "main").trim() };
			const call = async (name: string, args: Record<string, unknown>, agentKey?: string) => {
				try {
					return (await callFreeTool(name, { repo: "p", ...args }, { ...ctx, ...(agentKey ? { agentKey } : {}) })) as Record<string, unknown>;
				} catch (err) {
					return { error: statusOf(err).message };
				}
			};
			expect(await call("free_start", { required: 1, vetoes: ["security"], grants: { security: "security-1" } })).toEqual({ error: expect.stringMatching(/grants.security is a list/) });
			expect(await call("free_start", { required: 1, vetoes: ["security"], grants: { security: ["security-1"] } })).toMatchObject({ policy: { grants: { security: ["security-1"] } }, warnings: [expect.stringMatching(/held by security-1 alone/), expect.stringMatching(/no person holds security/)] });
			// Nothing signs these records here, so roles go by name; a registered name needs its key.
			const { key } = (await call("free_register", { agent: "security-1" })) as { key: string };
			expect(await call("free_vote", { commit: head, reviewer: "security-1", role: "security", verdict: "approve", evidence: "ok" })).toEqual({ error: expect.stringMatching(/registered/) });
			expect(await call("free_vote", { commit: head, reviewer: "security-1", role: "security", verdict: "approve", evidence: "ok" }, key)).toMatchObject({ ok: true });
		} finally {
			await server.close();
		}
	});
});
