import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import { needsYou } from "./needsYou";

type Claim = RepoSnapshot["claims"][number];

const claim = (change: string, over: Partial<Claim> = {}): Claim => ({
	change,
	agent: `agent-${change}`,
	paths: [`src/${change}/`],
	intent: change,
	since: "2026-10-09T00:00:00.000Z",
	active: "2026-10-09T00:00:00.000Z",
	head: `${change}-head`,
	approval: { approved: false, approvals: 1, required: 1, vetoedBy: [], awaiting: ["security"] },
	...over,
});
const snapshot = (claims: Claim[], votes: RepoSnapshot["votes"] = []) => ({
	claims,
	votes,
	policy: { required: 1, vetoes: ["security"], grants: { security: ["person:*"] } },
});

describe("what needs you in a repo", () => {
	it("is agents' questions, votes only people may give, and the audit's open violations", () => {
		const asks = claim("asks", { attention: { reason: "which cache size?", agent: "agent-asks", at: "" } });
		const votes = claim("votes");
		const result = needsYou(snapshot([votes, asks]), { open: 2 });
		expect(result.changes).toEqual([
			{ kind: "question", change: "asks", agent: "agent-asks", reason: "which cache size?", at: "" },
			{ kind: "vote", change: "votes", role: "security" },
		]);
		expect(result).toMatchObject({ violations: 2, count: 4 });
	});

	it("leaves out failed checks and changes sent back: they're their agents' to fix", () => {
		const failed = claim("failed");
		const rejected = claim("rejected");
		const reject = (commit: string, role: string) => ({
			commit,
			reviewer: role === "checks" ? "githive-checks" : "rev-1",
			role,
			verdict: "reject" as const,
			evidence: "",
			at: "",
		});
		const building = claim("building", { head: null });
		const result = needsYou(
			snapshot([failed, rejected, building], [reject("failed-head", "checks"), reject("rejected-head", "review")]),
		);
		expect(result).toEqual({ changes: [], violations: 0, count: 0 });
	});
});
