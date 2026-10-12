import { describe, expect, it } from "vitest";
import { ago, historyFixture } from "../test/fixtures";
import { buildTimeline, changeEnding, historyStatus, voteAsReview } from "./changeTimeline";

describe("a change's conversation", () => {
	it("tells claimed, each commit, and each vote in order", () => {
		const items = buildTimeline(historyFixture, "acme/docs-site");
		expect(items.map((i) => [i.kind, i.text])).toEqual([
			["opened", "agent-c claimed src/c/"],
			["pushed", "agent-c pushed a commit"],
			["pushed", "agent-c pushed a commit"],
			["review", "rev-1 approved"],
		]);
		expect(items[0]!.body).toBe("Rewrite the C section");
		expect(items[1]).toMatchObject({
			commit: "a0a0a0a0a0a0",
			body: "First draft of section C",
			commitHref: "#/repos/acme/docs-site/code?ref=a0a0a0a0a0a0",
		});
		expect(items[3]!.review).toMatchObject({
			reviewer: "tests",
			by: "agent:rev-1",
			verdict: "approve",
			summary: "suite passes",
		});
		expect(changeEnding(historyFixture)).toBeNull();
		expect(historyStatus(historyFixture)).toBeNull();
	});

	it("ends with the merge, linking the merge commit", () => {
		const merged = {
			...historyFixture,
			claim: null,
			released: [{ reason: "merged", at: ago(1), mergedAs: "ffee0011", agent: "agent-c" }],
		};
		const items = buildTimeline(merged, "acme/docs-site");
		expect(items.at(-1)).toMatchObject({
			kind: "merged",
			text: "merged into main as",
			commit: "ffee0011",
			commitHref: "#/repos/acme/docs-site/code?ref=ffee0011",
		});
		expect(items[0]!.text).toBe("agent-c claimed its paths");
		expect(historyStatus(merged)).toMatchObject({ kind: "merged", label: "Merged" });
	});

	it("or with the release and its reason", () => {
		const released = {
			...historyFixture,
			claim: null,
			released: [{ reason: "out of time", at: ago(1), agent: "agent-c", stale: true }],
		};
		expect(buildTimeline(released, "acme/docs-site").at(-1)).toMatchObject({
			kind: "abandoned",
			text: "agent-c released the claim (it had gone stale)",
			body: "out of time",
		});
		expect(historyStatus(released)).toMatchObject({
			label: "Released",
			description: "Its claim was released: out of time",
		});
	});

	it("tells its earlier attempts to land after what happened, and before how it ended", () => {
		const attempts = ["conflict on src/c/x.ts with c-7 by alice (6584265)", "checks failed: npm test exited 1", "odd"];
		const open = buildTimeline({ ...historyFixture, attempts }, "acme/docs-site");
		expect(open.slice(-3).map((item) => [item.kind, item.tone, item.text, item.body])).toEqual([
			["attempt", "warn", "an attempt to land conflicted with its branch", attempts[0]],
			["attempt", "warn", "an attempt to land failed its checks", attempts[1]],
			["attempt", "warn", "an attempt to land was refused", "odd"],
		]);
		expect(open.slice(-3).every((item) => item.at === undefined)).toBe(true);
		const released = buildTimeline(
			{
				...historyFixture,
				claim: null,
				released: [{ reason: "gave up", at: ago(1), agent: "agent-c" }],
				attempts: attempts.slice(0, 1),
			},
			"acme/docs-site",
		);
		expect(released.slice(-2).map((item) => item.kind)).toEqual(["attempt", "abandoned"]);
	});

	it("shows long evidence folded under its first line", () => {
		const vote = {
			commit: "c",
			reviewer: "r",
			role: "security",
			verdict: "reject" as const,
			evidence: "Token leaks\ncurl -v shows the header",
			at: ago(1),
		};
		expect(voteAsReview(vote)).toMatchObject({
			summary: "Token leaks",
			evidence: "Token leaks\ncurl -v shows the header",
			verdict: "reject",
		});
		expect(voteAsReview({ ...vote, evidence: "ok" })).not.toHaveProperty("evidence");
	});
});
