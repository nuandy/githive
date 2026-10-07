import { describe, expect, it } from "vitest";
import { ago, freeSnapshot } from "../test/fixtures";
import { freeAuthorStats, freeReviewerStats } from "./people";

describe("who works on a repo", () => {
	it("takes a coordinator-free repo's agents from its claims and votes", () => {
		expect(freeAuthorStats(freeSnapshot)).toEqual([{ name: "agent-c", opened: 1, open: 1, merged: 0, abandoned: 0, lastActive: ago(5) }]);
		expect(freeReviewerStats(freeSnapshot)).toEqual([{ name: "rev-1", roles: ["tests"], approvals: 1, rejections: 0, hosted: false, lastActive: ago(20) }]);
	});
});
