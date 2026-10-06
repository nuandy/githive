import { describe, expect, it } from "vitest";
import { ago, approve, makeChange, makeTask, reject } from "../test/fixtures";
import { computeInsights, formatDuration, formatTokens, median, percent } from "./insights";

const usage = (inputTokens: number, outputTokens: number, cacheReadTokens = 0) => ({ usage: { inputTokens, outputTokens, cacheReadTokens } });

const task = makeTask({
	slices: [
		makeChange({
			id: "a",
			status: "integrated",
			openedAt: ago(120),
			endedAt: ago(60),
			reviews: [{ ...approve("review", "h1", ago(100)), ...usage(1000, 200, 500) }, { ...approve("security", "h1", ago(99)), ...usage(3000, 300) }],
			gate: { status: "passed", head: "h1", baseHead: "b", at: ago(80), excluded: [] },
		}),
		makeChange({
			id: "b",
			status: "integrated",
			openedAt: ago(300),
			endedAt: ago(100),
			revisions: 2,
			reviews: [reject("review", "h1", ago(250)), approve("review", "h2", ago(150)), { ...approve("security", "h2", ago(149)), by: "agent:sec-bot" }],
		}),
		makeChange({ id: "c", status: "abandoned", revisions: 4 }),
		makeChange({ id: "d", gate: { status: "failed", head: "h", baseHead: "b", at: ago(1), excluded: [] }, reviewHead: "h" }),
	],
});

describe("insights", () => {
	it("counts changes and the median time to merge", () => {
		const data = computeInsights(task);
		expect(data.counts).toEqual({ open: 1, merged: 2, abandoned: 1 });
		expect(data.timedMerges).toBe(2);
		expect(data.medianMergeMs).toBe(((60 + 200) / 2) * 60_000);
	});

	it("measures revisions and first-review approvals, and verdicts by role", () => {
		const data = computeInsights(task);
		expect(data.revisions).toMatchObject({ average: 1.5, max: 4, buckets: [{ label: "None", count: 2 }, { label: "1", count: 0 }, { label: "2", count: 1 }, { label: "3 or more", count: 1 }] });
		expect(data.firstReview).toEqual({ reviewed: 2, approved: 1 });
		expect(data.byRole).toEqual([
			{ role: "review", approvals: 2, rejections: 1 },
			{ role: "security", approvals: 2, rejections: 0 },
		]);
	});

	it("adds up what Blueprint's own reviews cost, by role", () => {
		const { cost } = computeInsights(task);
		expect(cost).toMatchObject({ reviews: 2, input: 4000, output: 500, cacheRead: 500, total: 4500, changes: 1 });
		expect(cost.byRole).toEqual([
			{ role: "security", reviews: 1, tokens: 3300 },
			{ role: "review", reviews: 1, tokens: 1200 },
		]);
	});

	it("counts check runs from the log when there is one, else each change's latest run", () => {
		expect(computeInsights(task).checks).toEqual({ passed: 1, failed: 1, source: "records" });
		const history = [
			{ at: ago(9), text: "a: gate failed on base 123: npm test", commit: "h" },
			{ at: ago(8), text: "a: gate passed on base 124: npm test", commit: "h" },
			{ at: ago(7), text: "b: gate passed on base 125", commit: "h" },
			{ at: ago(6), text: "Change b opened", commit: "h" },
		];
		expect(computeInsights(task, history).checks).toEqual({ passed: 2, failed: 1, source: "log" });
	});

	it("formats for people", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([])).toBeUndefined();
		expect(formatDuration(30_000)).toBe("under a minute");
		expect(formatDuration(45 * 60_000)).toBe("45 minutes");
		expect(formatDuration(60 * 60_000)).toBe("1 hour");
		expect(formatDuration(3 * 3_600_000)).toBe("3 hours");
		expect(formatDuration(24 * 3_600_000)).toBe("1 day");
		expect(formatDuration(36 * 3_600_000)).toBe("1.5 days");
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(12_340)).toBe("12.3k");
		expect(formatTokens(2_000_000)).toBe("2M");
		expect(percent(1, 3)).toBe("33%");
		expect(percent(0, 0)).toBe("–");
	});
});
