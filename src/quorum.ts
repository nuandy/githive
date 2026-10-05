import { fail } from "./errors";
import { entriesOverlap, normalizeClaim } from "./open-mode";
import type { QuorumStatus, Review, ReviewPolicy, Slice } from "./types";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const union = (...lists: string[][]) => [...new Set(lists.flat())];

export function validatePolicy(policy: ReviewPolicy) {
	const { reviewers, required, vetoes } = policy;
	if (!Array.isArray(reviewers) || !reviewers.every((r) => SLUG.test(r))) fail(400, "reviewers must be slugs");
	if (new Set(reviewers).size !== reviewers.length) fail(400, "reviewers must be unique");
	if (!Number.isInteger(required) || required < 0 || required > reviewers.length)
		fail(400, `required must be between 0 and ${reviewers.length}`);
	const unknown = vetoes.filter((v) => !reviewers.includes(v));
	if (unknown.length) fail(400, `veto roles are not reviewers: ${unknown.join(", ")}`);
	for (const e of policy.escalate ?? []) {
		if (!Array.isArray(e.paths) || !e.paths.length) fail(400, "an escalation needs paths");
		normalizeClaim(e.paths);
		for (const r of [...(e.reviewers ?? []), ...(e.vetoes ?? [])]) if (!SLUG.test(r)) fail(400, `escalation roles must be slugs: ${r}`);
		if (e.required !== undefined && (!Number.isInteger(e.required) || e.required < 0)) fail(400, "an escalation's required must be a whole number");
	}
	const roles = union(reviewers, ...(policy.escalate ?? []).map((e) => [...(e.reviewers ?? []), ...(e.vetoes ?? [])]));
	const strangers = (policy.external ?? []).filter((r) => !roles.includes(r));
	if (strangers.length) fail(400, `external roles are not reviewers: ${strangers.join(", ")}`);
	const wait = policy.externalWaitMinutes;
	if (wait !== undefined && (!Number.isInteger(wait) || wait < 5 || wait > 1440)) fail(400, "externalWaitMinutes must be a whole number from 5 to 1440");
}

/**
 * The policy for a change touching `paths`: the task's, made stricter by
 * every escalation whose paths it touches (their roles and vetoes added, the
 * higher number of approvals). `escalatedBy` lists the paths that did it.
 */
export function effectivePolicy(policy: ReviewPolicy, paths: string[]): ReviewPolicy & { escalatedBy: string[] } {
	let { reviewers, required, vetoes } = policy;
	const escalatedBy = new Set<string>();
	for (const e of policy.escalate ?? []) {
		const hits = paths.filter((p) => e.paths.some((q) => entriesOverlap(p, q)));
		if (!hits.length) continue;
		hits.forEach((p) => escalatedBy.add(p));
		reviewers = union(reviewers, e.reviewers ?? [], e.vetoes ?? []);
		vetoes = union(vetoes, e.vetoes ?? []);
		required = Math.max(required, e.required ?? required);
	}
	const external = (policy.external ?? []).filter((r) => reviewers.includes(r));
	return {
		reviewers,
		required: Math.min(required, reviewers.length),
		vetoes,
		...(external.length ? { external } : {}),
		...(policy.externalWaitMinutes ? { externalWaitMinutes: policy.externalWaitMinutes } : {}),
		escalatedBy: [...escalatedBy].sort(),
	};
}

/**
 * Tally the reviews of the slice's current review head. A reviewer's latest
 * verdict wins. Approval needs the required approvals and every veto role's,
 * so a veto can always stop a merge, however fast the others vote.
 */
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
	else if (approvals.length >= policy.required && policy.vetoes.every((r) => approvals.includes(r))) status = "approved";
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
