import { describe, expect, it } from "vitest";
import type { HiveEvent, RepoLanding, RepoSnapshot } from "../api";
import { ago } from "../test/fixtures";
import { distinctTitles, freeWork, goalStatus, hiveGoals, rejections, stageCounts } from "./goals";

type Claim = RepoSnapshot["claims"][number];

const BRIEF =
	"Wire up the game src/main.js: put the game together as README.md describes: today's puzzle, progress loaded and saved after every word, the board, typing and controls.";

const claim = (change: string, extra: Partial<Claim> = {}): Claim => ({
	change,
	agent: "agent-12",
	paths: ["lib/request.js"],
	intent: "Fix: an IPv6 Host header loses its port",
	since: ago(18),
	active: ago(1),
	head: null,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...extra,
});

describe("titles side by side", () => {
	it("fold a long start several share, so what tells them apart comes first", () => {
		const titles = [
			"Add edge-case tests for res.links() in test/res.links.edges.js",
			"Add edge-case tests for req.is() in test/req.is.edges.js",
			"Fix the cookie parser",
		];
		expect(distinctTitles(titles)).toEqual([
			"…tests for res.links() in test/res.links.edges.js",
			"…tests for req.is() in test/req.is.edges.js",
			"Fix the cookie parser",
		]);
	});

	it("leave a short shared start, and titles alike in full, as they are", () => {
		const short = ["Add tests for res.links()", "Add tests for req.is()"];
		expect(distinctTitles(short)).toEqual(short);
		const same = ["Bump the router to 2.0", "Bump the router to 2.0"];
		expect(distinctTitles(same)).toEqual(same);
	});
});

describe("the hive's goals", () => {
	it("puts a change's pushes, votes and landing together, oldest first, and says where it stands", () => {
		const events: HiveEvent[] = [
			{ kind: "pushed", change: "ipv6", commit: "e4f5a6b7", at: ago(8) },
			{ kind: "voted", agent: "agent-5", commit: "a1b2c3d4", verdict: "reject", detail: "code", at: ago(11) },
			{ kind: "pushed", change: "ipv6", commit: "a1b2c3d4", at: ago(13) },
			{
				kind: "claimed",
				agent: "agent-12",
				change: "ipv6",
				detail: "Fix: an IPv6 Host header loses its port",
				at: ago(18),
			},
		];
		const votes = [
			{
				commit: "a1b2c3d4",
				reviewer: "agent-5",
				role: "code",
				verdict: "reject" as const,
				evidence: "[::1] returns '['",
				at: ago(11),
			},
			{
				commit: "e4f5a6b7",
				reviewer: "agent-19",
				role: "code",
				verdict: "approve" as const,
				evidence: "npm test passes",
				at: ago(5),
			},
		];
		const landing: RepoLanding = {
			branch: "main",
			checking: { base: "c0ffee", since: ago(2), changes: [{ change: "ipv6", head: "e4f5a6b7", agent: "agent-12" }] },
			recent: [],
		};
		const head = claim("ipv6", {
			head: "e4f5a6b7",
			approval: { approved: true, approvals: 1, required: 1, vetoedBy: [] },
		});
		const [goal] = hiveGoals({ claims: [head], votes, events, landing });
		expect(goal?.state).toBe("landing");
		expect(goal?.steps.map((step) => step.kind)).toEqual([
			"claimed",
			"pushed",
			"changes-asked",
			"pushed",
			"approved",
			"checking",
		]);
		// The snapshot's vote, with its evidence, stands in for the log's word of it.
		expect(goal?.steps[2]?.text).toBe("[::1] returns '['");
		expect(rejections(goal!)).toBe(1);
		expect(goalStatus(goal!).words).toBe("landing · after 1 rejection");
		expect(goal?.earlierSteps).toBe(false);
	});

	it("names a landed change's agent and the change a vote was on, though its claim is gone", () => {
		const events: HiveEvent[] = [
			{ kind: "landed", agent: "githive-forager", change: "app", commit: "f00d", at: ago(6) },
			{ kind: "merging", agent: "githive-forager", change: "app", at: ago(6) },
			{ kind: "voted", agent: "githive-nurse", commit: "bfa0f510", verdict: "approve", detail: "code", at: ago(7) },
			{ kind: "pushed", change: "app", commit: "bfa0f510", at: ago(7) },
			{ kind: "claimed", agent: "githive-forager", change: "app", detail: BRIEF, at: ago(9) },
			{ kind: "claimed", agent: "githive-forager", change: "app", detail: BRIEF, at: ago(10) },
		];
		const [goal] = hiveGoals({ claims: [], votes: [], events });
		expect(goal).toMatchObject({
			change: "app",
			agent: "githive-forager",
			state: "landed",
			title: "Wire up the game src/main.js",
		});
		expect(goal?.finished).toBe(ago(6));
		expect(goal?.steps.find((step) => step.kind === "pushed")?.by).toBe("githive-forager");
		expect(goal?.steps.find((step) => step.kind === "approved")?.by).toBe("githive-nurse");
		// Claimed twice: the second widens the first.
		expect(goal?.steps.filter((step) => step.kind === "claimed")).toHaveLength(1);
		expect(goal?.steps.some((step) => step.kind === "widened")).toBe(true);
	});

	it("remembers a landed change's paths from when its claim was in force", () => {
		const events: HiveEvent[] = [{ kind: "landed", agent: "agent-19", change: "links", at: ago(3) }];
		const [goal] = hiveGoals({
			claims: [],
			votes: [],
			events,
			remembered: new Map([["links", ["test/res.links.js"]]]),
		});
		expect(goal?.paths).toEqual(["test/res.links.js"]);
	});

	it("leaves out changes on other branches and ones whose end it never saw", () => {
		const events: HiveEvent[] = [
			{ kind: "landed", agent: "agent-3", change: "other-branch", at: ago(2) },
			{ kind: "pushed", change: "lost", commit: "abc", at: ago(4) },
		];
		const goals = hiveGoals({ claims: [], votes: [], events, elsewhere: new Set(["other-branch"]) });
		expect(goals).toEqual([]);
	});

	it("says a goal's first steps may be missing when it began before the oldest event kept", () => {
		const events: HiveEvent[] = [{ kind: "pushed", change: "ipv6", commit: "a1", at: ago(2) }];
		const [goal] = hiveGoals({ claims: [claim("ipv6", { head: "a1" })], votes: [], events });
		expect(goal?.earlierSteps).toBe(true);
		expect(goal?.state).toBe("in-review");
	});

	it("tells a change waiting for a veto role apart from one waiting for any review", () => {
		const approval = { approved: false, approvals: 1, required: 1, vetoedBy: [], awaiting: ["security"] };
		const [goal] = hiveGoals({ claims: [claim("deps", { head: "d1", approval })], votes: [] });
		// An agent may hold the role: it's in review.
		expect(goalStatus(goal!)).toEqual({ words: "in review · waiting for a security vote", tone: "accent" });
		// Only people may: it needs a person.
		const settings = { policy: { required: 1, vetoes: ["security"], grants: { security: ["person:*"] } } };
		const [waiting] = hiveGoals({ claims: [claim("deps", { head: "d1", approval })], votes: [], settings });
		expect(waiting?.state).toBe("needs-person");
		expect(goalStatus(waiting!)).toEqual({ words: "needs a person for a security vote", tone: "bad" });
		// Only the role people alone may vote as: an agent may give the other.
		const both = { ...approval, awaiting: ["qa", "security"] };
		const policy = { required: 1, vetoes: ["security", "qa"], grants: { security: ["person:*"], qa: ["qa-bot"] } };
		const [one] = hiveGoals({
			claims: [claim("deps", { head: "d1", approval: both })],
			votes: [],
			settings: { policy },
		});
		expect(goalStatus(one!)).toEqual({ words: "needs a person for a security vote", tone: "bad" });
	});

	it("tells two agents' stories apart when one released a change and the other took it up", () => {
		const events: HiveEvent[] = [
			{
				kind: "claimed",
				agent: "bob-codex",
				change: "static-maxage",
				detail: "Honor maxAge 0 in serve-static",
				at: ago(9),
			},
			{ kind: "released", agent: "erin-claude", change: "static-maxage", detail: "out of time", at: ago(12) },
			{ kind: "claimed", agent: "erin-claude", change: "static-maxage", detail: "Honor maxAge 0", at: ago(20) },
		];
		const held = claim("static-maxage", {
			agent: "bob-codex",
			since: ago(9),
			intent: "Honor maxAge 0 in serve-static",
		});
		const goals = hiveGoals({ claims: [held], votes: [], events });
		expect(goals.map((goal) => [goal.key, goal.agent, goal.state])).toEqual([
			["static-maxage", "bob-codex", "building"],
			["static-maxage#1", "erin-claude", "released"],
		]);
	});

	it("says a change whose batch failed is being fixed, though its claim still reads approved", () => {
		const approval = { approved: true, approvals: 1, required: 1, vetoedBy: [] };
		const checks = {
			commit: "h1",
			reviewer: "githive-checks",
			role: "checks",
			verdict: "reject" as const,
			evidence: "npm test failed on h1, checked alone on the branch, twice:\n2 failing",
			at: ago(1),
		};
		const [goal] = hiveGoals({ claims: [claim("c", { head: "h1", approval })], votes: [checks] });
		expect(goal?.state).toBe("checks-failed");
		expect(goalStatus(goal!).words).toBe("checks failed, fixing");
	});

	it("tells both sides of a heads-up", () => {
		const event: HiveEvent = {
			kind: "heads_up",
			agent: "agent-12",
			change: "alters",
			other: "dave-cursor",
			otherChange: "uses",
			detail: "parseRange()",
			at: ago(2),
		};
		const claims = [claim("alters"), claim("uses", { agent: "dave-cursor" })];
		const goals = hiveGoals({ claims, votes: [], events: [event] });
		const sides = goals.map((goal) => [goal.key, goal.steps.find((step) => step.kind === "heads-up")?.side]);
		expect(sides).toEqual(
			expect.arrayContaining([
				["alters", "alters"],
				["uses", "uses"],
			]),
		);
	});

	it("asks a person when the claim says so", () => {
		const attention = { reason: "should sendFile follow symlinks?", agent: "agent-12", at: ago(1) };
		const [goal] = hiveGoals({ claims: [claim("ask", { attention })], votes: [] });
		expect(goal?.state).toBe("needs-person");
		expect(goalStatus(goal!)).toEqual({ words: "needs a person: should sendFile follow symlinks?", tone: "bad" });
		expect(goal?.steps.at(-1)).toMatchObject({ kind: "asked", text: "should sendFile follow symlinks?" });
	});
});

describe("free work and the stage counts", () => {
	const item = (id: string, after?: string[]) => ({
		id,
		title: id,
		intent: id,
		by: "planner",
		at: ago(60),
		...(after ? { after } : {}),
	});

	it("lists backlog items nobody holds whose prerequisites have merged", () => {
		const goals = hiveGoals({ claims: [claim("taken")], votes: [] });
		const free = freeWork([item("taken"), item("free"), item("blocked", ["free"]), item("unblocked", ["gone"])], goals);
		expect(free.map((each) => each.id)).toEqual(["free", "unblocked"]);
	});

	it("counts goals by stage, and landed ones only since the time given", () => {
		const events: HiveEvent[] = [
			{ kind: "landed", agent: "a", change: "old", at: ago(90) },
			{ kind: "landed", agent: "b", change: "new", at: ago(5) },
		];
		const goals = hiveGoals({ claims: [claim("c1"), claim("c2", { head: "h" })], votes: [], events });
		expect(stageCounts(goals, 3, Date.parse(ago(30)))).toEqual({
			next: 3,
			building: 1,
			review: 1,
			approved: 0,
			landing: 0,
			landed: 1,
		});
	});
});
