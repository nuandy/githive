import { describe, expect, it } from "vitest";
import { ago, repoSnapshot } from "../test/fixtures";
import { authorStats, reviewerStats } from "./people";

describe("who works on a repo", () => {
	it("takes a repo's agents from its claims and votes", () => {
		expect(authorStats(repoSnapshot)).toEqual([{ name: "agent-c", opened: 1, open: 1, merged: 0, abandoned: 0, lastActive: ago(5) }]);
		expect(reviewerStats(repoSnapshot)).toEqual([{ name: "rev-1", roles: ["tests"], approvals: 1, rejections: 0, hosted: false, lastActive: ago(20) }]);
	});
});
