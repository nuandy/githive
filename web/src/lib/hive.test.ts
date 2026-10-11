import { describe, expect, it } from "vitest";
import type { HiveEvent, RepoLanding, RepoSnapshot } from "../api";
import { ago, NOW } from "../test/fixtures";
import { afterAgent, feedLine, hiveActivity, hiveCounts } from "./hive";

// The hive: what each agent on a repo is doing, worked out from its claims, votes and landing.

type Claim = RepoSnapshot["claims"][number];
const claim = (change: string, agent: string, more: Partial<Claim> = {}): Claim => ({
	change,
	agent,
	paths: [`src/${change}/`],
	intent: change,
	since: ago(30),
	active: ago(10),
	head: `${change}-head`,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...more,
});
const vote = (commit: string, reviewer: string, verdict: "approve" | "reject", minutes: number) => ({
	commit,
	reviewer,
	role: "review",
	verdict,
	evidence: "ok",
	at: ago(minutes),
});
const snapshot = (claims: Claim[], votes: RepoSnapshot["votes"] = []): RepoSnapshot => ({
	repo: "acme/web",
	policy: { required: 1, vetoes: [] },
	verify: [],
	verified: true,
	claims,
	votes,
});
const approved = { approved: true, approvals: 1, required: 1, vetoedBy: [] };

describe("the hive", () => {
	it("says what each claimed change is doing, from its agent's side", () => {
		const landing: RepoLanding = {
			branch: "main",
			checking: { base: "b", since: ago(1), changes: [{ change: "landing", head: "landing-head", agent: "dee" }] },
			recent: [],
		};
		const claims = [
			claim("new", "ada", { head: null }),
			claim("sent-back", "bob"),
			claim("review", "cy", { approval: { approved: false, approvals: 1, required: 2, vetoedBy: [] } }),
			claim("landing", "dee", { approval: approved }),
			claim("waiting", "eve", { approval: approved }),
			claim("stuck", "fay", { attention: { reason: "which library?", agent: "fay", at: ago(2) } }),
		];
		const rows = hiveActivity(snapshot(claims, [vote("sent-back-head", "rev", "reject", 3)]), landing, NOW);
		const states = Object.fromEntries(rows.map((row) => [row.change, [row.state, row.detail]]));
		expect(states).toMatchObject({
			new: ["building", "nothing pushed yet"],
			"sent-back": ["revising", "changes asked for in review"],
			review: ["in-review", "1 of 2 approvals"],
			landing: ["landing", "in the batch being checked"],
			waiting: ["waiting", "approved, landing with the next batch"],
			stuck: ["asking", "asking a person: which library?"],
		});
	});

	it("counts agents who reviewed lately without a claim, and forgets them after a while", () => {
		const votes = [vote("a-head", "rev-1", "approve", 5), vote("a-head", "rev-2", "approve", 40)];
		const rows = hiveActivity(snapshot([claim("a", "ada")], votes), undefined, NOW);
		expect(rows.find((row) => row.agent === "rev-1")).toMatchObject({ state: "reviewed", detail: "approved a" });
		expect(rows.some((row) => row.agent === "rev-2")).toBe(false);
		expect(hiveCounts(rows)).toEqual({ agents: 2, building: 0, inReview: 1, landing: 0 });
	});
});

describe("the hive's live feed", () => {
	it("names who pushed from the claim, and the change a vote was on from its head", () => {
		const claims = [claim("login", "ann")];
		const pushed = feedLine({ kind: "pushed", change: "login", commit: "login-head", at: ago(1) }, snapshot(claims));
		expect(pushed).toMatchObject({ agent: "ann", action: "pushed to", change: "login" });
		const vote = { kind: "voted" as const, agent: "bob", commit: "login-head", verdict: "reject" as const };
		const line = feedLine({ ...vote, detail: "security", at: ago(1) }, snapshot(claims));
		expect(line).toMatchObject({ agent: "bob", action: "asked for changes to", change: "login", note: "as security" });
	});

	it("says who an interface change, a heads-up or a conflict matters to", () => {
		const claims = [claim("c-12", "bob"), claim("c-3", "bob"), claim("c-9", "dan")];
		const said = (event: Omit<HiveEvent, "at">) => {
			const line = feedLine({ ...event, at: ago(1) }, snapshot(claims));
			return `${line.agent}${afterAgent(line)}${line.action}`;
		};
		const landed = { kind: "interface" as const, agent: "alice", change: "c-12", commit: "0123456789abcdef" };
		expect(said(landed)).toBe("alice landed an interface change bob uses");
		expect(said({ kind: "heads_up", agent: "bob", change: "c-3", other: "carol" })).toBe(
			"bob and carol are changing things each other uses",
		);
		expect(said({ kind: "conflicted", agent: "dan", change: "c-9", detail: "invoice.ts" })).toBe(
			"dan's merge conflicted on invoice.ts",
		);
		// The change it's about is linked, and the names it's about noted; a conflict's files are in its words.
		const line = feedLine({ ...landed, detail: "loadSettings", at: ago(1) }, snapshot(claims));
		expect(line).toMatchObject({ kind: "interface", change: "c-12", note: "loadSettings" });
		const conflict = { kind: "conflicted" as const, agent: "dan", change: "c-9", detail: "invoice.ts", at: ago(1) };
		expect(feedLine(conflict, snapshot(claims)).note).toBeUndefined();
		// Without a claim to say who, the other agent is unnamed.
		expect(said({ kind: "interface", agent: "alice", change: "gone" })).toBe("alice landed an interface change another agent uses");
		expect(said({ kind: "heads_up", agent: "bob", change: "c-3" })).toBe(
			"bob and another agent are changing things each other uses",
		);
	});

	it("shows a commit no claim is on by its short hash", () => {
		const reverted = { kind: "reverted" as const, agent: "ann", commit: "0123456789abcdef", at: ago(1) };
		expect(feedLine(reverted, snapshot([]))).toMatchObject({ action: "reverted", commit: "01234567" });
	});
});
