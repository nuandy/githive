import type { Change, Review, ReviewPolicy } from "./model";

// How a change stands, in the words a person reading a pull request expects.
// Everything here is derived from the change record and the repo's policy.

export type Tone = "good" | "bad" | "warn" | "neutral" | "needs" | "accent";

export type StatusKind =
	| "merged"
	| "abandoned"
	| "needs-you"
	| "checks-failed"
	| "running-checks"
	| "waiting"
	| "ready"
	| "approved"
	| "changes-requested"
	| "in-review"
	| "draft"
	| "opening";

export interface ChangeStatus {
	kind: StatusKind;
	label: string;
	tone: Tone;
	/** One sentence on what is happening and who acts next. */
	description: string;
}

export interface ReviewerVerdict {
	role: string;
	/** The reviewer's latest verdict on the commit under review, if any. */
	verdict?: "approve" | "reject";
	review?: Review;
	/** This role's rejection blocks the change whatever the count. */
	veto: boolean;
	/** Outside agents review this role, not Blueprint's own reviewer. */
	external: boolean;
}

export interface ReviewSummary {
	state: "none" | "pending" | "approved" | "waived" | "changes-requested" | "vetoed";
	approvals: number;
	required: number;
	reviewers: ReviewerVerdict[];
	/** Roles that can block the change and haven't approved yet: it isn't approved until each has. */
	awaiting: string[];
	/** Short text for lists, e.g. "2/2 approvals". */
	label: string;
	tone: Tone;
}

export interface ChecksSummary {
	state: "none" | "not-run" | "queued" | "running" | "passed" | "failed" | "waiting";
	total: number;
	passed: number;
	failed: number;
	/** Files that did not merge cleanly onto the project's branch in the last check run. */
	conflicts: string[];
	label: string;
	tone: Tone;
}

/** The review policy for a change: the one its commit went to review under (stricter for sensitive paths), or the repo's. */
export const changePolicy = (change: Change, task: { review: ReviewPolicy }): ReviewPolicy => change.review ?? task.review;

/** The gate run that applies to the commit under review; an older run is stale. */
export function currentGate(change: Change) {
	const gate = change.gate;
	if (!gate) return undefined;
	if (change.status === "integrated" || !change.reviewHead || gate.head === change.reviewHead) return gate;
	return undefined;
}

/** Latest verdict per reviewer on the commit under review: the reviewer's last word wins. */
function latestReviews(change: Change): Map<string, Review> {
	const latest = new Map<string, Review>();
	if (!change.reviewHead) return latest;
	for (const review of Array.isArray(change.reviews) ? change.reviews : []) {
		if (review && review.head === change.reviewHead && typeof review.reviewer === "string") latest.set(review.reviewer, review);
	}
	return latest;
}

export function reviewSummary(change: Change, policy: ReviewPolicy): ReviewSummary {
	const latest = latestReviews(change);
	const roles = policy.reviewers.length ? policy.reviewers : [...latest.keys()];
	const reviewers: ReviewerVerdict[] = roles.map((role) => {
		const review = latest.get(role);
		return { role, verdict: review?.verdict, review, veto: policy.vetoes.includes(role), external: (policy.external ?? []).includes(role) };
	});
	const approvals = reviewers.filter((r) => r.verdict === "approve").length;
	const required = policy.required > 0 ? policy.required : roles.length;
	const rejected = reviewers.filter((r) => r.verdict === "reject");
	const waived = !!change.reviewHead && (change.waivers ?? []).some((w) => w?.head === change.reviewHead);
	const count = `${approvals}/${required} approvals`;
	// As the server decides: every role that can block must approve too, however many others have.
	const awaiting = policy.vetoes.filter((role) => latest.get(role)?.verdict !== "approve");
	const base = { approvals, required, reviewers, awaiting };

	if (!change.reviewHead) return { ...base, state: "none", label: "No review yet", tone: "neutral" };
	if (rejected.some((r) => r.veto)) {
		const by = rejected.filter((r) => r.veto).map((r) => r.role).join(", ");
		return { ...base, state: "vetoed", label: `Blocked by ${by}`, tone: "bad" };
	}
	if (approvals >= required && required > 0 && !awaiting.length) return { ...base, state: "approved", label: count, tone: "good" };
	if (waived) return { ...base, state: "waived", label: "Review waived", tone: "good" };
	if (rejected.length || change.sentBackFor === change.reviewHead) return { ...base, state: "changes-requested", label: "Changes requested", tone: "bad" };
	if (approvals >= required && awaiting.length) return { ...base, state: "pending", label: `Waiting for ${awaiting.join(", ")}`, tone: "warn" };
	return { ...base, state: "pending", label: count, tone: "warn" };
}

export function checksSummary(change: Change, verify: string[], branch = "main"): ChecksSummary {
	const gate = currentGate(change);
	const results = Array.isArray(gate?.result?.results) ? gate.result.results : [];
	const conflicts = Array.isArray(gate?.result?.mergeConflict) ? gate.result.mergeConflict : [];
	const total = Math.max(verify.length, results.length);
	const passed = results.filter((r) => r?.exitCode === 0).length;
	const failed = results.filter((r) => r && r.exitCode !== 0).length;
	const base = { total, passed, failed, conflicts };
	if (!gate) {
		if (!verify.length) return { ...base, state: "none", label: "No checks", tone: "neutral" };
		return { ...base, state: "not-run", label: "Checks not run yet", tone: "neutral" };
	}
	switch (gate.status) {
		case "queued":
			return { ...base, state: "queued", label: "Checks queued", tone: "warn" };
		case "running":
			return { ...base, state: "running", label: "Checks running", tone: "warn" };
		case "waiting":
			return { ...base, state: "waiting", label: "Waiting for other changes", tone: "warn" };
		case "passed":
			return { ...base, state: "passed", label: total ? `${passed}/${total} checks passed` : "Checks passed", tone: "good" };
		default: {
			const label = conflicts.length ? `Conflicts with ${branch}` : total ? `${failed} of ${total} checks failed` : "Checks failed";
			return { ...base, state: "failed", label, tone: "bad" };
		}
	}
}

/** The one status a person sees for a change, most urgent first. */
export function deriveChangeStatus(change: Change, policy: ReviewPolicy, branch = "main"): ChangeStatus {
	if (change.status === "integrated") return { kind: "merged", label: "Merged", tone: "good", description: `Merged into ${branch}.` };
	if (change.status === "abandoned") return { kind: "abandoned", label: "Abandoned", tone: "neutral", description: "Abandoned; its claim is free again." };
	if (change.attention !== undefined && change.attention !== null)
		return { kind: "needs-you", label: "Needs you", tone: "needs", description: change.attention || "The agents can't go on without a person." };
	const gate = currentGate(change);
	if (gate?.status === "failed") return { kind: "checks-failed", label: "Checks failed", tone: "bad", description: "Approved, but the checks failed on the combined code." };
	if (gate?.status === "queued" || gate?.status === "running")
		return { kind: "running-checks", label: "Running checks", tone: "warn", description: "Approved; the checks are running before it merges." };
	if (gate?.status === "waiting")
		return { kind: "waiting", label: "Waiting to merge", tone: "warn", description: "Waiting for other changes to merge before its checks run again." };
	if (gate?.status === "passed") return { kind: "ready", label: "Ready to merge", tone: "good", description: `Approved and checks passed; merging into ${branch}.` };
	if (change.status === "opening") return { kind: "opening", label: "Opening", tone: "neutral", description: "Its claim is held while its branch is created." };
	const review = reviewSummary(change, policy);
	if (review.state === "approved" || review.state === "waived")
		return { kind: "approved", label: "Approved", tone: "good", description: "Approved; the checks run next." };
	if (review.state === "changes-requested" || review.state === "vetoed")
		return { kind: "changes-requested", label: "Changes requested", tone: "bad", description: "Reviewers asked for changes; the agent is revising." };
	if (review.state === "pending") return { kind: "in-review", label: "In review", tone: "warn", description: "Waiting for reviewers." };
	return { kind: "draft", label: "Draft", tone: "neutral", description: "The agent is still working; nothing submitted for review yet." };
}
