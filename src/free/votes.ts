import type { CasLog } from "../election";
import { appendRecord } from "./records";

// Coordinator-free review (see docs/coordinator-free.md). Reviewers append
// verdicts on the exact commit they reviewed. A merging agent counts them
// itself under the task's policy; the audit counts them again.

export interface VoteRecord {
	commit: string;
	reviewer: string;
	role: string;
	verdict: "approve" | "reject";
	evidence: string;
	at: string;
}

export interface Votes {
	votes: VoteRecord[];
}

export interface ReviewPolicy {
	/** Approvals a commit needs. */
	required: number;
	/** Roles whose rejection blocks a merge whatever the approvals. */
	vetoes: string[];
}

/** Record a reviewer's verdict on a commit. */
export function vote(log: CasLog<Votes>, input: Omit<VoteRecord, "at">) {
	return appendRecord<Votes, never>(log, input.reviewer, () => ({ votes: [] }), (state) => ({
		state: { votes: [...state.votes, { ...input, at: new Date().toISOString() }] },
		text: `${input.reviewer} (${input.role}) ${input.verdict === "approve" ? "approves" : "rejects"} ${input.commit}: ${input.evidence}`,
	}));
}

/** Whether `commit` may merge under `policy`: each reviewer's latest verdict counts once. */
export function approval(state: Votes | null | undefined, commit: string, policy: ReviewPolicy) {
	const latest = new Map<string, VoteRecord>();
	for (const v of state?.votes ?? []) if (v.commit === commit) latest.set(v.reviewer, v);
	const verdicts = [...latest.values()];
	const approvals = verdicts.filter((v) => v.verdict === "approve").length;
	const vetoedBy = verdicts.filter((v) => v.verdict === "reject" && policy.vetoes.includes(v.role)).map((v) => v.reviewer);
	return { approved: approvals >= policy.required && !vetoedBy.length, approvals, vetoedBy };
}
