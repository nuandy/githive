import { describe, expect, it } from "vitest";
import { approve, makeChange, reject } from "../test/fixtures";
import { checksSummary, currentGate, deriveChangeStatus, reviewSummary } from "./changeStatus";

const policy = { reviewers: ["tests", "security", "api"], required: 2, vetoes: ["security"] };
const gate = (status: "queued" | "running" | "passed" | "failed" | "waiting", head = "h1", results: { command: string; exitCode: number; output: string }[] = []) => ({
	status,
	head,
	baseHead: "base",
	at: "2026-10-06T11:00:00.000Z",
	excluded: [],
	...(results.length ? { result: { passed: status === "passed", head, baseHead: "base", results, at: "2026-10-06T11:00:00.000Z" } } : {}),
});

describe("deriveChangeStatus", () => {
	const kind = (overrides: Parameters<typeof makeChange>[0]) => deriveChangeStatus(makeChange(overrides), policy).kind;

	it("ends with Merged or Abandoned whatever else the record holds", () => {
		expect(kind({ status: "integrated", attention: "x", gate: gate("failed") })).toBe("merged");
		expect(kind({ status: "abandoned", reviewHead: "h1" })).toBe("abandoned");
		expect(deriveChangeStatus(makeChange({ status: "integrated" }), policy)).toMatchObject({ label: "Merged", tone: "good" });
	});

	it("puts a change that needs a person above everything in progress", () => {
		expect(kind({ attention: "Reviewers disagree", reviewHead: "h1", gate: gate("failed") })).toBe("needs-you");
		expect(kind({ attention: "" })).toBe("needs-you");
		expect(deriveChangeStatus(makeChange({ attention: "Stuck" }), policy)).toMatchObject({ label: "Needs you", tone: "needs", description: "Stuck" });
	});

	it("reads the checks run for the commit under review", () => {
		expect(kind({ reviewHead: "h1", gate: gate("failed") })).toBe("checks-failed");
		expect(kind({ reviewHead: "h1", gate: gate("queued") })).toBe("running-checks");
		expect(kind({ reviewHead: "h1", gate: gate("running") })).toBe("running-checks");
		expect(kind({ reviewHead: "h1", gate: gate("waiting") })).toBe("waiting");
		expect(kind({ reviewHead: "h1", gate: gate("passed") })).toBe("ready");
	});

	it("ignores a stale checks run for an older commit", () => {
		expect(kind({ reviewHead: "h2", gate: gate("failed", "h1") })).toBe("in-review");
		expect(currentGate(makeChange({ reviewHead: "h2", gate: gate("failed", "h1") }))).toBeUndefined();
	});

	it("derives review states from the latest verdict per reviewer on the commit under review", () => {
		expect(kind({})).toBe("draft");
		expect(kind({ status: "opening" })).toBe("opening");
		expect(kind({ reviewHead: "h1" })).toBe("in-review");
		expect(kind({ reviewHead: "h1", reviews: [approve("tests", "h1"), approve("security", "h1")] })).toBe("approved");
		expect(kind({ reviewHead: "h1", reviews: [reject("tests", "h1")] })).toBe("changes-requested");
		// A reviewer who changed their mind: the last verdict wins.
		expect(kind({ reviewHead: "h1", reviews: [reject("tests", "h1"), approve("tests", "h1"), approve("security", "h1")] })).toBe("approved");
		// Verdicts on an older commit don't count.
		expect(kind({ reviewHead: "h2", reviews: [approve("tests", "h1"), approve("api", "h1")] })).toBe("in-review");
		expect(kind({ reviewHead: "h1", sentBackFor: "h1" })).toBe("changes-requested");
		expect(kind({ reviewHead: "h1", waivers: [{ head: "h1", by: "person:abc", reason: "ok", at: "now" }] })).toBe("approved");
	});
});

describe("reviewSummary", () => {
	it("summarizes approvals like a pull request", () => {
		const summary = reviewSummary(makeChange({ reviewHead: "h1", reviews: [approve("tests", "h1"), approve("security", "h1")] }), policy);
		expect(summary).toMatchObject({ state: "approved", approvals: 2, required: 2, label: "2/2 approvals", tone: "good", awaiting: [] });
		expect(summary.reviewers.map((r) => [r.role, r.verdict, r.veto])).toEqual([
			["tests", "approve", false],
			["security", "approve", true],
			["api", undefined, false],
		]);
	});

	it("waits for every role that can block, however many others approved (the server's rule)", () => {
		const change = makeChange({ reviewHead: "h1", reviews: [approve("tests", "h1"), approve("api", "h1")] });
		expect(reviewSummary(change, policy)).toMatchObject({ state: "pending", approvals: 2, awaiting: ["security"], label: "Waiting for security", tone: "warn" });
		expect(deriveChangeStatus(change, policy).kind).toBe("in-review");
	});

	it("counts pending approvals and names a blocking reviewer", () => {
		expect(reviewSummary(makeChange({ reviewHead: "h1", reviews: [approve("tests", "h1")] }), policy)).toMatchObject({ state: "pending", label: "1/2 approvals" });
		expect(reviewSummary(makeChange({ reviewHead: "h1", reviews: [approve("tests", "h1"), approve("api", "h1"), reject("security", "h1")] }), policy)).toMatchObject({
			state: "vetoed",
			label: "Blocked by security",
		});
		expect(reviewSummary(makeChange(), policy)).toMatchObject({ state: "none", label: "No review yet" });
	});

	it("falls back to whoever reviewed when the policy names no reviewers", () => {
		const summary = reviewSummary(makeChange({ reviewHead: "h1", reviews: [approve("tests", "h1")] }), { reviewers: [], required: 0, vetoes: [] });
		expect(summary).toMatchObject({ state: "approved", approvals: 1, required: 1 });
	});
});

describe("checksSummary", () => {
	it("reports passed and failed counts, and conflicts with main", () => {
		const results = [
			{ command: "npm test", exitCode: 0, output: "" },
			{ command: "npm run lint", exitCode: 1, output: "bad" },
		];
		expect(checksSummary(makeChange({ reviewHead: "h1", gate: gate("failed", "h1", results) }), ["npm test", "npm run lint"])).toMatchObject({
			state: "failed",
			passed: 1,
			failed: 1,
			label: "1 of 2 checks failed",
		});
		expect(checksSummary(makeChange({ reviewHead: "h1", gate: gate("passed", "h1", [results[0]]) }), ["npm test"]).label).toBe("1/1 checks passed");
		const conflicted = makeChange({ reviewHead: "h1", gate: { ...gate("failed", "h1"), result: { passed: false, head: "h1", baseHead: "b", mergeConflict: ["a.ts"], results: [], at: "now" } } });
		expect(checksSummary(conflicted, ["npm test"])).toMatchObject({ label: "Conflicts with main", conflicts: ["a.ts"] });
	});

	it("tells a repo without checks from checks that haven't run", () => {
		expect(checksSummary(makeChange(), []).state).toBe("none");
		expect(checksSummary(makeChange(), ["npm test"]).state).toBe("not-run");
	});
});
