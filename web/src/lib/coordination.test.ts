import { describe, expect, it } from "vitest";
import { ago, approve, makeChange, makeTask } from "../test/fixtures";
import { canReview, leaderChange, leaderChangeId, pushesNewestFirst, reviewRoles } from "./coordination";

describe("who coordinates", () => {
	const task = makeTask({ id: "abcd1234", slices: [makeChange({ id: "add-stats", title: "Add stats page" })] });

	it("finds the leading change from the leader's name", () => {
		expect(leaderChangeId({ leader: "abcd1234--add-stats", term: 3 }, "abcd1234")).toBe("add-stats");
		expect(leaderChangeId({ leader: null, term: 0 }, "abcd1234")).toBeNull();
		expect(leaderChangeId(undefined, "abcd1234")).toBeNull();
		expect(leaderChange({ leader: "abcd1234--add-stats", term: 3 }, task)?.change?.title).toBe("Add stats page");
		expect(leaderChange({ leader: "abcd1234--gone", term: 4 }, task)).toEqual({ id: "gone", change: undefined });
	});
});

describe("reviewing from the dashboard", () => {
	it("is open while a commit is in review and hasn't been sent back", () => {
		expect(canReview(makeChange({ reviewHead: "h1" }))).toBe(true);
		expect(canReview(makeChange())).toBe(false);
		expect(canReview(makeChange({ reviewHead: "h1", sentBackFor: "h1" }))).toBe(false);
		expect(canReview(makeChange({ reviewHead: "h2", sentBackFor: "h1" }))).toBe(true);
		expect(canReview(makeChange({ reviewHead: "h1", status: "integrated" }))).toBe(false);
		expect(canReview(makeChange({ reviewHead: "h1", status: "abandoned" }))).toBe(false);
		expect(canReview(makeChange({ reviewHead: "h1", status: "opening" }))).toBe(false);
		// Fully approved: another vote changes nothing.
		const policy = { reviewers: ["review"], required: 1, vetoes: [] };
		expect(canReview(makeChange({ reviewHead: "h1", reviews: [approve("review", "h1")] }), policy)).toBe(false);
		expect(canReview(makeChange({ reviewHead: "h1", reviews: [] }), policy)).toBe(true);
	});

	it("offers the change's own policy, suggesting the first role without a vote on the commit", () => {
		const task = makeTask({ review: { reviewers: ["tests", "security"], required: 2, vetoes: [] } });
		expect(reviewRoles(makeChange({ reviewHead: "h1" }), task)).toEqual({ roles: ["tests", "security"], suggested: "tests" });
		expect(reviewRoles(makeChange({ reviewHead: "h1", reviews: [approve("tests", "h1")] }), task).suggested).toBe("security");
		expect(reviewRoles(makeChange({ reviewHead: "h2", reviews: [approve("tests", "h1")] }), task).suggested).toBe("tests");
		const escalated = makeChange({ reviewHead: "h1", review: { reviewers: ["review", "security"], required: 2, vetoes: ["security"] } });
		expect(reviewRoles(escalated, task).roles).toEqual(["review", "security"]);
	});

	it("lists pushes newest first", () => {
		const pushes = [
			{ head: "a", at: ago(3), files: 1, outOfLane: 0, conflicts: 0 },
			{ head: "b", at: ago(1), files: 2, outOfLane: 1, conflicts: 1 },
		];
		expect(pushesNewestFirst(makeChange({ pushes })).map((p) => p.head)).toEqual(["b", "a"]);
		expect(pushesNewestFirst(makeChange())).toEqual([]);
	});
});
