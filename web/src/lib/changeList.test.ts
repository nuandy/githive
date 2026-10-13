import { describe, expect, it } from "vitest";
import type { RepoSnapshot } from "../api";
import {
	activeWords,
	arrivalWords,
	changeList,
	type ChangeFilter,
	matchesQuery,
	openOn,
	parseFilter,
} from "./changeList";

type Claim = RepoSnapshot["claims"][number];

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const claim = (change: string, over: Partial<Claim> = {}): Claim => ({
	change,
	agent: `agent-${change}`,
	paths: [`src/${change}/`],
	intent: `Do ${change}`,
	since: minutesAgo(60),
	active: minutesAgo(5),
	head: `${change}-head`,
	approval: { approved: false, approvals: 0, required: 1, vetoedBy: [] },
	...over,
});
const policy = { required: 1, vetoes: ["security"], grants: { security: ["person:*"] } };
const approved = { approved: true, approvals: 1, required: 1, vetoedBy: [] };

// One change in each state the list sorts, each last active a different while ago.
const asks = claim("asks", { attention: { reason: "which cache?", agent: "agent-asks", at: minutesAgo(1) } });
const vote = claim("vote", {
	active: minutesAgo(30),
	approval: { approved: false, approvals: 1, required: 1, vetoedBy: [], awaiting: ["security"] },
});
const failed = claim("failed", { active: minutesAgo(2) });
const blocked = claim("blocked", { approval: { approved: false, approvals: 0, required: 1, vetoedBy: ["security"] } });
const ready = claim("ready", { approval: approved, active: minutesAgo(9) });
const checking = claim("checking", { approval: approved, active: minutesAgo(1) });
const review = claim("review", { active: minutesAgo(3) });
const review2 = claim("review-2", { active: minutesAgo(1) });
const building = claim("building", { head: null, active: minutesAgo(1) });
const claims = [building, review, ready, failed, asks, review2, checking, blocked, vote];
const votes: RepoSnapshot["votes"] = [
	{ commit: "failed-head", reviewer: "githive-checks", role: "checks", verdict: "reject", evidence: "", at: "" },
];
const landing = {
	checking: { base: "b", since: "", changes: [{ change: "checking", head: "checking-head", agent: "" }] },
};
const context = { votes, settings: { policy }, landing, now: NOW };

const ids = (filter: ChangeFilter, query = "") =>
	changeList(claims, context, { filter, query }).shown.map((listed) => listed.claim.change);

describe("the Changes list", () => {
	it("puts what needs action first: a person, then failed or sent back, approved, landing, in review, building", () => {
		expect(ids("all")).toEqual([
			"asks",
			"vote",
			"failed",
			"blocked",
			"ready",
			"checking",
			"review-2",
			"review",
			"building",
		]);
	});

	it("within a kind, puts the change active last first", () => {
		const order = ids("in-review");
		expect(order).toEqual(["review-2", "review"]);
	});

	it("filters by what needs you (as needsYou counts it) and by state, and counts each", () => {
		expect(ids("needs-you")).toEqual(["asks", "vote"]);
		expect(ids("approved")).toEqual(["ready"]);
		expect(ids("landing")).toEqual(["checking"]);
		expect(ids("building")).toEqual(["building"]);
		const { counts } = changeList(claims, context, { filter: "all", query: "" });
		expect(counts).toEqual({
			"needs-you": 2,
			"in-review": 2,
			approved: 1,
			building: 1,
			landing: 1,
			all: 9,
		});
	});

	it("searches title, change id, agent and path, every word somewhere", () => {
		const coupon = claim("cart-coupons", {
			agent: "mara/claude",
			intent: "Let shoppers apply a coupon code.\n\nValidates codes against the API.",
			paths: ["src/lib/cart.ts", "src/components/CartDrawer.tsx"],
		});
		expect(matchesQuery(coupon, "")).toBe(true);
		expect(matchesQuery(coupon, "COUPON")).toBe(true);
		expect(matchesQuery(coupon, "cart-coupons")).toBe(true);
		expect(matchesQuery(coupon, "mara")).toBe(true);
		expect(matchesQuery(coupon, "CartDrawer")).toBe(true);
		expect(matchesQuery(coupon, "mara drawer")).toBe(true);
		expect(matchesQuery(coupon, "mara checkout")).toBe(false);
		// Only the title: the rest of the intent isn't shown, so it isn't searched.
		expect(matchesQuery(coupon, "validates")).toBe(false);
		// Counts follow the search, so each chip says what it would show.
		const found = changeList([...claims, coupon], context, { filter: "all", query: "src/review" });
		expect(found.shown.map((listed) => listed.claim.change)).toEqual(["review-2", "review"]);
		expect(found.counts).toMatchObject({ all: 2, "in-review": 2, "needs-you": 0 });
	});

	it("reads a filter from the address, and takes anything else as all", () => {
		expect(parseFilter("needs-you")).toBe("needs-you");
		expect(parseFilter("landing")).toBe("landing");
		expect(parseFilter("nope")).toBe("all");
		expect(parseFilter(undefined)).toBe("all");
	});

	it("counts a branch's open changes: those landing on it", () => {
		const into = claim("backport", { into: "release/2.4" });
		const snapshot = { branch: "main", claims: [review, into] };
		expect(openOn(snapshot, "main").map((each) => each.change)).toEqual(["review"]);
		expect(openOn(snapshot, "release/2.4").map((each) => each.change)).toEqual(["backport"]);
		expect(openOn({ claims: [review] }, "main")).toHaveLength(1);
	});

	it("says when a change was last active", () => {
		expect(activeWords(minutesAgo(4), NOW)).toBe("active 4m ago");
		expect(activeWords(minutesAgo(0), NOW)).toBe("active now");
		expect(activeWords(minutesAgo(60 * 50), NOW)).toBe("active 2d ago");
	});

	it("words new changes for a screen reader", () => {
		expect(arrivalWords([review], "main")).toBe("New change on main: Do review, by agent-review.");
		expect(arrivalWords([review, ready, asks], "main")).toBe("3 new changes on main: Do review, Do ready and Do asks.");
		expect(arrivalWords([], "main")).toBe("");
	});
});
