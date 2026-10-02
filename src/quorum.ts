import { fail } from "./errors";
import type { QuorumStatus, Review, ReviewPolicy, Slice } from "./types";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validatePolicy(policy: ReviewPolicy) {
	const { reviewers, required, vetoes } = policy;
	if (!reviewers.length || !reviewers.every((r) => SLUG.test(r))) fail(400, "reviewers must be non-empty slugs");
	if (new Set(reviewers).size !== reviewers.length) fail(400, "reviewers must be unique");
	if (!Number.isInteger(required) || required < 1 || required > reviewers.length)
		fail(400, `required must be between 1 and ${reviewers.length}`);
	const unknown = vetoes.filter((v) => !reviewers.includes(v));
	if (unknown.length) fail(400, `veto roles are not reviewers: ${unknown.join(", ")}`);
}

/** Tally the reviews of the slice's current review head. A reviewer's latest verdict wins. */
export function tally(policy: ReviewPolicy, slice: Pick<Slice, "reviewHead" | "reviews">) {
	const latest = new Map<string, Review>();
	for (const review of slice.reviews) {
		if (review.head === slice.reviewHead) latest.set(review.reviewer, review);
	}
	const approvals = policy.reviewers.filter((r) => latest.get(r)?.verdict === "approve");
	const rejections = policy.reviewers.filter((r) => latest.get(r)?.verdict === "reject");
	const waiting = policy.reviewers.filter((r) => !latest.has(r));

	let status: QuorumStatus = "pending";
	if (!slice.reviewHead) status = "pending";
	else if (rejections.some((r) => policy.vetoes.includes(r))) status = "vetoed";
	else if (approvals.length >= policy.required) status = "approved";
	else if (approvals.length + waiting.length < policy.required) status = "rejected";

	return { status, approvals, rejections, waiting };
}

/** What the Coordinator does after a vote on a slice. */
export function nextStep(policy: ReviewPolicy, slice: Slice): "integrate" | "send-back" | "wait" {
	if (slice.status !== "building" || !slice.reviewHead) return "wait";
	const { status } = tally(policy, slice);
	if (status === "approved") return "integrate";
	if ((status === "rejected" || status === "vetoed") && slice.sentBackFor !== slice.reviewHead) return "send-back";
	return "wait";
}

/** The message a builder gets when review sends its slice back. */
export function reviewFeedback(policy: ReviewPolicy, slice: Pick<Slice, "reviewHead" | "reviews">) {
	const { status, approvals } = tally(policy, slice);
	const latest = new Map<string, Review>();
	for (const review of slice.reviews) if (review.head === slice.reviewHead) latest.set(review.reviewer, review);
	const rejections = [...latest.values()].filter((r) => r.verdict === "reject");
	const findings = rejections.map((r) => {
		const veto = policy.vetoes.includes(r.reviewer) ? " (veto)" : "";
		return `- ${r.reviewer}${veto} rejected: ${r.summary}${r.evidence ? `\n  Evidence: ${r.evidence}` : ""}`;
	});
	return [
		`Review sent your slice back (quorum ${status}). Fix the problems below, push, and call finish again. A new commit starts a new review.`,
		"",
		...findings,
		...(approvals.length ? ["", `Approved by: ${approvals.join(", ")}.`] : []),
	].join("\n");
}
