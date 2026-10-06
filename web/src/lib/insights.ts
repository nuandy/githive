import type { HistoryEntry, Task } from "../api";
import { changesOf, changeState, timeOf, type Change } from "./model";

// The Insights tab of an elected repo: how its changes have gone, computed from
// the change records (and the decision log, when the server keeps one).

export interface RoleVerdicts {
	role: string;
	approvals: number;
	rejections: number;
}

export interface RoleCost {
	role: string;
	reviews: number;
	tokens: number;
}

export interface Insights {
	counts: { open: number; merged: number; abandoned: number };
	/** Median time from opening to merging, over merged changes that record both. */
	medianMergeMs?: number;
	timedMerges: number;
	revisions: { average: number; max: number; buckets: { label: string; count: number }[] };
	/** Changes whose first reviewed commit drew no rejection, out of those reviewed. */
	firstReview: { reviewed: number; approved: number };
	byRole: RoleVerdicts[];
	checks: { passed: number; failed: number; source: "log" | "records" };
	cost: { reviews: number; input: number; output: number; cacheRead: number; total: number; changes: number; byRole: RoleCost[] };
}

export function median(values: number[]): number | undefined {
	if (!values.length) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The commit a change first went to review with: the head of its earliest review. */
function firstReviewedHead(change: Change): string | undefined {
	const reviews = (change.reviews ?? []).filter(Boolean);
	if (!reviews.length) return undefined;
	let first = reviews[0];
	for (const review of reviews) if ((timeOf(review.at) ?? Infinity) < (timeOf(first.at) ?? Infinity)) first = review;
	return first.head;
}

export function computeInsights(task: Pick<Task, "slices">, history?: HistoryEntry[] | null): Insights {
	const changes = changesOf(task);
	const counts = { open: 0, merged: 0, abandoned: 0 };
	for (const change of changes) counts[changeState(change)]++;

	const mergeTimes = changes
		.filter((c) => c.status === "integrated")
		.map((c) => (timeOf(c.endedAt) ?? NaN) - (timeOf(c.openedAt) ?? NaN))
		.filter((ms) => Number.isFinite(ms) && ms >= 0);

	const revisions = changes.map((c) => c.revisions ?? 0);
	const buckets = [
		{ label: "None", count: revisions.filter((n) => n === 0).length },
		{ label: "1", count: revisions.filter((n) => n === 1).length },
		{ label: "2", count: revisions.filter((n) => n === 2).length },
		{ label: "3 or more", count: revisions.filter((n) => n >= 3).length },
	];

	let reviewed = 0;
	let firstApproved = 0;
	const roles = new Map<string, RoleVerdicts>();
	const costs = new Map<string, RoleCost>();
	const cost = { reviews: 0, input: 0, output: 0, cacheRead: 0, total: 0, changes: 0, byRole: [] as RoleCost[] };
	for (const change of changes) {
		const head = firstReviewedHead(change);
		if (head) {
			reviewed++;
			const first = change.reviews.filter((r) => r?.head === head);
			if (first.some((r) => r.verdict === "approve") && !first.some((r) => r.verdict === "reject")) firstApproved++;
		}
		let costed = false;
		for (const review of change.reviews ?? []) {
			if (!review) continue;
			const role = roles.get(review.reviewer) ?? { role: review.reviewer, approvals: 0, rejections: 0 };
			if (review.verdict === "approve") role.approvals++;
			else role.rejections++;
			roles.set(review.reviewer, role);
			const usage = review.usage;
			if (usage) {
				const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
				cost.reviews++;
				cost.input += usage.inputTokens ?? 0;
				cost.output += usage.outputTokens ?? 0;
				cost.cacheRead += usage.cacheReadTokens ?? 0;
				cost.total += tokens;
				costed = true;
				const byRole = costs.get(review.reviewer) ?? { role: review.reviewer, reviews: 0, tokens: 0 };
				byRole.reviews++;
				byRole.tokens += tokens;
				costs.set(review.reviewer, byRole);
			}
		}
		if (costed) cost.changes++;
	}
	cost.byRole = [...costs.values()].sort((a, b) => b.tokens - a.tokens);

	// Checks: every run the log recorded, or else each change's latest run.
	const logged = (history ?? []).filter((e) => /\bgate (passed|failed)\b/.test(e.text));
	const checks = logged.length
		? { passed: logged.filter((e) => /\bgate passed\b/.test(e.text)).length, failed: logged.filter((e) => /\bgate failed\b/.test(e.text)).length, source: "log" as const }
		: {
				passed: changes.filter((c) => c.gate?.status === "passed" || (c.status === "integrated" && c.gate?.result?.passed)).length,
				failed: changes.filter((c) => c.gate?.status === "failed").length,
				source: "records" as const,
			};

	return {
		counts,
		medianMergeMs: median(mergeTimes),
		timedMerges: mergeTimes.length,
		revisions: { average: revisions.length ? revisions.reduce((a, b) => a + b, 0) / revisions.length : 0, max: Math.max(0, ...revisions), buckets },
		firstReview: { reviewed, approved: firstApproved },
		byRole: [...roles.values()].sort((a, b) => b.approvals + b.rejections - (a.approvals + a.rejections) || a.role.localeCompare(b.role)),
		checks,
		cost,
	};
}

/** "45 minutes", "3.2 hours", "2.1 days". */
export function formatDuration(ms: number): string {
	const minutes = ms / 60_000;
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return `${Math.round(minutes)} ${Math.round(minutes) === 1 ? "minute" : "minutes"}`;
	const amount = (n: number, unit: string) => {
		const text = n.toFixed(1).replace(/\.0$/, "");
		return `${text} ${unit}${text === "1" ? "" : "s"}`;
	};
	const hours = minutes / 60;
	if (hours < 24) return amount(hours, "hour");
	return amount(hours / 24, "day");
}

/** 950, "12.3k", "1.2M". */
export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(Math.round(tokens));
	if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
	return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export function percent(part: number, whole: number): string {
	return whole ? `${Math.round((part / whole) * 100)}%` : "–";
}
