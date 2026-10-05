import { describe, expect, it } from "vitest";
import { ago, approve, freeSnapshot, makeChange, makeTask, reject } from "../test/fixtures";
import { authorStats, freeAuthorStats, freeReviewerStats, registeredAgents, reviewerName, reviewerStats } from "./people";

describe("who works on a repo", () => {
	const task = makeTask({
		agents: { "agent-b": { keyHash: "x", at: ago(50) }, "agent-a": { keyHash: "y", at: ago(100), by: "person:abc123" } },
		slices: [
			makeChange({ id: "a", openedBy: "agent:agent-a", status: "integrated", reviews: [approve("review", "h"), { ...approve("security", "h"), by: "agent:sec-bot" }] }),
			makeChange({ id: "b", openedBy: "agent:agent-a", status: "abandoned", reviews: [reject("review", "h"), { ...reject("security", "h"), by: "person:9f8e7d6c5b4a" }] }),
			makeChange({ id: "c", agent: "Agent Bee", openedBy: "service:abc/agent-b" }),
			makeChange({ id: "d", external: false, openedBy: "blueprint-builder" }),
		],
	});

	it("lists registered outside agents, oldest first, without their key", () => {
		expect(registeredAgents(task)).toEqual([
			{ name: "agent-a", since: ago(100), by: "person:abc123" },
			{ name: "agent-b", since: ago(50) },
		]);
		expect(registeredAgents(makeTask())).toEqual([]);
	});

	it("counts each author's changes by how they ended", () => {
		expect(authorStats(task).map(({ name, opened, open, merged, abandoned }) => [name, opened, open, merged, abandoned])).toEqual([
			["agent-a", 2, 0, 1, 1],
			["Agent Bee", 1, 1, 0, 0],
			["Blueprint builder", 1, 1, 0, 0],
		]);
	});

	it("names reviewers, with Blueprint's own by role, and counts their verdicts", () => {
		expect(reviewerName({ reviewer: "tests" })).toBe("Blueprint's tests reviewer");
		expect(reviewerName({ reviewer: "security", by: "agent:sec-bot" })).toBe("sec-bot");
		expect(reviewerStats(task).map(({ name, roles, approvals, rejections, hosted }) => [name, roles, approvals, rejections, hosted])).toEqual([
			["Blueprint's review reviewer", ["review"], 1, 1, true],
			["person 9f8e7d6c", ["security"], 0, 1, false],
			["sec-bot", ["security"], 1, 0, false],
		]);
	});

	it("takes a coordinator-free repo's agents from its claims and votes", () => {
		expect(freeAuthorStats(freeSnapshot)).toEqual([{ name: "agent-c", opened: 1, open: 1, merged: 0, abandoned: 0, lastActive: ago(5) }]);
		expect(freeReviewerStats(freeSnapshot)).toEqual([{ name: "rev-1", roles: ["tests"], approvals: 1, rejections: 0, hosted: false, lastActive: ago(20) }]);
	});
});
