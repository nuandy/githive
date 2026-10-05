import { describe, expect, it } from "vitest";
import { ago, freeHistory } from "../test/fixtures";
import { buildFreeTimeline, freeEnding, freeHistoryStatus, voteAsReview } from "./freeTimeline";

describe("a coordinator-free change's conversation", () => {
	it("tells claimed, each commit, and each vote in order", () => {
		const items = buildFreeTimeline(freeHistory, "docs-site");
		expect(items.map((i) => [i.kind, i.text])).toEqual([
			["opened", "agent-c claimed src/c/"],
			["pushed", "agent-c pushed a commit"],
			["pushed", "agent-c pushed a commit"],
			["review", "rev-1 approved"],
		]);
		expect(items[0].body).toBe("Rewrite the C section");
		expect(items[1]).toMatchObject({ commit: "a0a0a0a0a0a0", body: "First draft of section C", commitHref: "#/free/docs-site/code?ref=a0a0a0a0a0a0" });
		expect(items[3].review).toMatchObject({ reviewer: "tests", by: "agent:rev-1", verdict: "approve", summary: "suite passes" });
		expect(freeEnding(freeHistory)).toBeNull();
		expect(freeHistoryStatus(freeHistory)).toBeNull();
	});

	it("ends with the merge, linking the merge commit", () => {
		const merged = { ...freeHistory, claim: null, released: [{ reason: "merged", at: ago(1), mergedAs: "ffee0011", agent: "agent-c" }] };
		const items = buildFreeTimeline(merged, "docs-site");
		expect(items.at(-1)).toMatchObject({ kind: "merged", text: "merged into main as", commit: "ffee0011", commitHref: "#/free/docs-site/code?ref=ffee0011" });
		expect(items[0].text).toBe("agent-c claimed its paths");
		expect(freeHistoryStatus(merged)).toMatchObject({ kind: "merged", label: "Merged" });
	});

	it("or with the release and its reason", () => {
		const released = { ...freeHistory, claim: null, released: [{ reason: "out of time", at: ago(1), agent: "agent-c", stale: true }] };
		expect(buildFreeTimeline(released, "docs-site").at(-1)).toMatchObject({ kind: "abandoned", text: "agent-c released the claim (it had gone stale)", body: "out of time" });
		expect(freeHistoryStatus(released)).toMatchObject({ label: "Released", description: "Its claim was released: out of time" });
	});

	it("shows long evidence folded under its first line", () => {
		const vote = { commit: "c", reviewer: "r", role: "security", verdict: "reject" as const, evidence: "Token leaks\ncurl -v shows the header", at: ago(1) };
		expect(voteAsReview(vote)).toMatchObject({ summary: "Token leaks", evidence: "Token leaks\ncurl -v shows the header", verdict: "reject" });
		expect(voteAsReview({ ...vote, evidence: "ok" })).not.toHaveProperty("evidence");
	});
});
