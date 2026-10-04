import type { CasLog } from "../election";
import { appendRecord } from "./records";
import { type Stamper, stampPayload, verifyStamp } from "./stamp";

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
	/** Who cast it, as Access verified them, and Blueprint's stamp (written through the toolkit). */
	by?: string;
	stamp?: string;
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
export function vote(log: CasLog<Votes>, input: Omit<VoteRecord, "at" | "by" | "stamp">, stamper?: Stamper) {
	return appendRecord<Votes, never>(log, input.reviewer, () => ({ votes: [] }), async (state) => {
		const record: VoteRecord = { ...input, at: new Date().toISOString() };
		const cast = stamper ? { ...record, by: stamper.by } : record;
		return {
			state: { votes: [...state.votes, stamper ? { ...cast, stamp: await stamper.stamp(stampPayload("vote", cast)) } : cast] },
			text: `${input.reviewer} (${input.role}) ${input.verdict === "approve" ? "approves" : "rejects"} ${input.commit}: ${input.evidence}`,
		};
	});
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

/** The votes that count: with the registry's stamp key, only those Blueprint stamped. */
export async function countedVotes(cast: VoteRecord[], stampKey: string | undefined) {
	if (!stampKey) return cast;
	const checked = await Promise.all(cast.map(async (v) => ((await verifyStamp(stampKey, stampPayload("vote", v), v.stamp)) ? v : null)));
	return checked.filter((v) => v !== null);
}
