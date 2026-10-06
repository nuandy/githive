import { entriesOverlap } from "../open-mode";
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
	/** Changes an agent has asked a person about, oldest first. */
	flags?: FlagRecord[];
}

/** An agent asking a person to decide something about a change (reviewers disagree, say). */
export interface FlagRecord {
	change: string;
	reason: string;
	agent: string;
	at: string;
	/** Who asked, as Access verified them, and Blueprint's stamp (written through the toolkit). */
	by?: string;
	stamp?: string;
}

/** Ask a person about a change: it waits in their inbox until a person votes on its commit. */
export function flagChange(log: CasLog<Votes>, input: Omit<FlagRecord, "at" | "by" | "stamp">, stamper?: Stamper) {
	return appendRecord<Votes, never>(log, input.agent, () => ({ votes: [] }), async (state) => {
		const record: FlagRecord = { ...input, at: new Date().toISOString() };
		const asked = stamper ? { ...record, by: stamper.by } : record;
		return {
			state: { ...state, flags: [...(state.flags ?? []), stamper ? { ...asked, stamp: await stamper.stamp(stampPayload("flag", asked)) } : asked] },
			text: `${input.agent} asks a person about ${input.change}: ${input.reason}`,
		};
	});
}

/** The latest question about `change` that no person has answered yet: a person's vote on `head` after it answers it. */
export function openFlag(state: Votes | null | undefined, change: string, head: string | null) {
	const flag = (state?.flags ?? []).filter((f) => f.change === change).at(-1);
	if (!flag) return null;
	const answered = (state?.votes ?? []).some((v) => v.by?.startsWith("person:") && v.commit === head && v.at >= flag.at);
	return answered ? null : flag;
}

export interface ReviewPolicy {
	/** Approvals a commit needs; 0 merges on the checks alone (unless a veto role must approve). */
	required: number;
	/** Roles whose rejection blocks a merge whatever the approvals; each must approve. */
	vetoes: string[];
	/** Stricter rules for a change touching any of these paths: more approvals, more vetoes. */
	escalate?: { paths: string[]; required?: number; vetoes?: string[] }[];
}

/** The policy for a change touching `paths`: made stricter by every escalation whose paths it touches. */
export function effectiveFreePolicy(policy: ReviewPolicy, paths: string[]): { required: number; vetoes: string[] } {
	let { required, vetoes } = policy;
	for (const e of policy.escalate ?? []) {
		if (!paths.some((p) => e.paths.some((q) => entriesOverlap(p, q)))) continue;
		required = Math.max(required, e.required ?? required);
		vetoes = [...new Set([...vetoes, ...(e.vetoes ?? [])])];
	}
	return { required, vetoes };
}

/** Record a reviewer's verdict on a commit. */
export function vote(log: CasLog<Votes>, input: Omit<VoteRecord, "at" | "by" | "stamp">, stamper?: Stamper) {
	return appendRecord<Votes, never>(log, input.reviewer, () => ({ votes: [] }), async (state) => {
		const record: VoteRecord = { ...input, at: new Date().toISOString() };
		const cast = stamper ? { ...record, by: stamper.by } : record;
		return {
			state: { ...state, votes: [...state.votes, stamper ? { ...cast, stamp: await stamper.stamp(stampPayload("vote", cast)) } : cast] },
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
export function approval(state: Votes | null | undefined, commit: string, base: ReviewPolicy, author?: Author, paths: string[] = []) {
	const policy = effectiveFreePolicy(base, paths);
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
