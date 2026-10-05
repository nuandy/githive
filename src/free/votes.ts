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

/** A change's author, whose own approval doesn't count: its claim's agent, and who made the claim as Access verified them. */
export interface Author {
	agent: string;
	by?: string;
}

/**
 * Whether `commit` may merge under `policy`. Each identity counts once, by its
 * latest verdict: its verified identity (`by`) when the vote is signed, else
 * its reviewer name, so one agent can't approve twice under two names. The
 * author's own approval doesn't count; a veto counts from anyone. Every veto
 * role must approve too (`awaiting` lists those that haven't), so a veto can
 * always stop a merge, however fast the others vote.
 */
export function approval(state: Votes | null | undefined, commit: string, policy: ReviewPolicy, author?: Author) {
	const latest = new Map<string, VoteRecord>();
	for (const v of state?.votes ?? []) if (v.commit === commit) latest.set(v.by ?? `name:${v.reviewer}`, v);
	const verdicts = [...latest.values()];
	const isAuthor = (v: VoteRecord) => !!author && ((!!v.by && v.by === author.by) || v.reviewer === author.agent);
	const approving = verdicts.filter((v) => v.verdict === "approve" && !isAuthor(v));
	const approvals = approving.length;
	const vetoedBy = verdicts.filter((v) => v.verdict === "reject" && policy.vetoes.includes(v.role)).map((v) => v.reviewer);
	const awaiting = policy.vetoes.filter((role) => !approving.some((v) => v.role === role));
	return { approved: approvals >= policy.required && !vetoedBy.length && !awaiting.length, approvals, vetoedBy, awaiting };
}

/** The votes that count: with the registry's stamp key, only those Blueprint stamped. */
export async function countedVotes(cast: VoteRecord[], stampKey: string | undefined) {
	if (!stampKey) return cast;
	const checked = await Promise.all(cast.map(async (v) => ((await verifyStamp(stampKey, stampPayload("vote", v), v.stamp)) ? v : null)));
	return checked.filter((v) => v !== null);
}
