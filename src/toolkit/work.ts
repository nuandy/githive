import type { CasLog } from "../record-log";
import { entriesOverlap } from "../claim-paths";
import type { ClaimRecord } from "./claims";
import { appendRecord } from "./records";
import { type Author, approval, effectivePolicy, holdsRole, type ReviewPolicy, type VoteRecord } from "./votes";

// What an agent should do next, so users can send
// any number of agents without giving them roles: GitHive hands each one
// the most useful work there is. First its own change (revise it when a
// reviewer asked for changes, even if approved: a cooperative agent doesn't
// merge over an objection; merge it once approved; finish it if nothing is
// pushed), then a
// review someone else's change is waiting for (never its own; a role that can
// block a merge only if it holds that role), then a piece of the repo's
// backlog nobody has claimed. Nothing is reserved: two agents told the same
// thing both try, and the claim (or the vote count) settles it.

/** A piece of work in the repo's backlog: taken once a change by its id is claimed, done once that change merges. */
export interface WorkItem {
	id: string;
	title: string;
	intent: string;
	/** What it's likely to touch: the claim to start from. */
	paths?: string[];
	by: string;
	at: string;
}

export interface Work {
	items: WorkItem[];
}

/** A work item's id from its title: lowercase words joined by dashes. */
export const workId = (title: string) =>
	title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "work";

/** Add a piece of work to the backlog (refused if its id is taken). */
export function addWork(log: CasLog<Work>, input: Omit<WorkItem, "at">) {
	return appendRecord<Work, string>(log, input.by, () => ({ items: [] }), (state) =>
		state.items.some((i) => i.id === input.id)
			? { refused: `${input.id} is in the backlog already` }
			: { state: { items: [...state.items, { ...input, at: new Date().toISOString() }] }, text: `${input.by} adds ${input.id} to the backlog: ${input.title}` },
	);
}

export type NextStep =
	| { kind: "merge"; change: string; head: string; next: string }
	| { kind: "revise"; change: string; head: string; reviewer: string; evidence: string; next: string }
	| { kind: "finish"; change: string; next: string }
	| { kind: "review"; change: string; author: string; head: string; role: string; intent: string; paths: string[]; needed: number; next: string }
	| { kind: "build"; work: WorkItem; next: string }
	| { kind: "wait"; reason: string; retryAfterSeconds: number; next: string };

export interface NextInput {
	agent: string;
	/** The caller's verified identity, as its votes would carry it (to tell whether it holds a role). */
	/** The teams the caller is on in the repo's org (@<org>/<team>), for roles granted to a team. */
	teams?: string[];
	by?: string;
	policy: ReviewPolicy;
	/** The claims in force, each with its change's pushed head (null: nothing pushed). */
	open: { claim: ClaimRecord; head: string | null }[];
	/** The votes that count. */
	votes: VoteRecord[];
	/** Changes that merged. */
	merged: Set<string>;
	/** Changes waiting on a person (asked about, and not answered on their head): their agent can do other work meanwhile. */
	asked?: Set<string>;
	/** Reviews other agents are on now, by commit and role (review holds, see holdKey): a review already held as often as it's needed is left to them. */
	held?: Record<string, string[]>;
	work: WorkItem[];
	/** How many agents may be asking at once (those registered, or holding claims): they're spread over about as many choices. */
	crowd?: number;
	/** Changes whose agents abandoned them (see staleness.ts): their claims stand in nobody's way, and their work is free to take. */
	abandoned?: Set<string>;
}

/**
 * A review hold's key: a commit and the role reviewed. An ordinary reviewer's
 * hold mustn't keep the holder of a role that can block away (in a run, one
 * lingering after its vote sent the only security holder to build instead).
 */
export const holdKey = (head: string, role: string) => `${head}#${role}`;

/** How long a review a role that can block awaits may wait, unheld, before people are told. */
export const ROLE_WAIT_MS = 10 * 60_000;

/**
 * The reviews roles that can block are waiting for, that no one holds: on
 * changes pushed, not sent back, and still awaiting that role's approval.
 */
export function waitingRoleReviews(input: Pick<NextInput, "policy" | "open" | "votes" | "held">) {
	return input.open.flatMap(({ claim, head }) => {
		if (!head) return [];
		const author: Author = { agent: claim.agent, ...(claim.by ? { by: claim.by } : {}) };
		if (input.votes.some((v) => v.commit === head && v.verdict === "reject" && v.reviewer !== author.agent)) return [];
		const { awaiting } = approval({ votes: input.votes }, head, input.policy, author, claim.paths);
		return awaiting.filter((role) => !input.held?.[holdKey(head, role)]?.length).map((role) => ({ change: claim.change, head, role }));
	});
}

/** A small, stable hash, to spread agents over equally good choices. */
function spread(agent: string, n: number) {
	let h = 0x811c9dc5;
	for (let i = 0; i < agent.length; i++) h = Math.imul(h ^ agent.charCodeAt(i), 0x01000193);
	return (h >>> 0) % n;
}

/**
 * How many equally good choices agents are spread over, at least: as many as
 * there are agents, past that, so a crowd asking at once isn't sent to the
 * same few (in a run of 200, one review drew 71 reviewers).
 */
const SPREAD = 3;

export function nextFor(input: NextInput): NextStep {
	const { agent, policy, votes } = input;
	const width = Math.max(SPREAD, input.crowd ?? 0);
	const authorOf = (c: ClaimRecord): Author => ({ agent: c.agent, ...(c.by ? { by: c.by } : {}) });
	const on = (head: string) => votes.filter((v) => v.commit === head);
	const rejectionOf = (head: string, author: Author) => on(head).find((v) => v.verdict === "reject" && v.reviewer !== author.agent);

	// Its own changes first: a change that's done unblocks everything after it. One waiting on a person is left to them.
	const own = input.open.filter((o) => o.claim.agent === agent && !input.asked?.has(o.claim.change));
	// An objection first: a cooperative agent doesn't merge over a reviewer who asked for changes, even with enough approvals.
	for (const { claim, head } of own) {
		const rejection = head ? rejectionOf(head, authorOf(claim)) : undefined;
		if (head && rejection)
			return { kind: "revise", change: claim.change, head, reviewer: rejection.reviewer, evidence: rejection.evidence, next: `Revise ${claim.change}: ${rejection.reviewer} asked for changes (see evidence). Push the fix to changes/${claim.change}; reviewers look at the new commit. If it's not yours to settle, ask_human.` };
	}
	for (const { claim, head } of own) {
		if (head && approval({ votes }, head, policy, authorOf(claim), claim.paths).approved)
			return { kind: "merge", change: claim.change, head, next: `merge your change ${claim.change}: its commit ${head.slice(0, 8)} is approved.` };
	}
	const unpushed = own.find((o) => !o.head);
	if (unpushed) return { kind: "finish", change: unpushed.claim.change, next: `Finish ${unpushed.claim.change}: you hold its claim but nothing is pushed. Push changes/${unpushed.claim.change} to your fork (credentials), then check.` };

	// Reviews others are waiting for: never its own, nor a commit it voted on, nor one waiting on a revision.
	const reviews = input.open
		.filter((o): o is { claim: ClaimRecord; head: string } => !!o.head && o.claim.agent !== agent)
		.flatMap(({ claim, head }) => {
			const cast = on(head);
			if (cast.some((v) => v.reviewer === agent || (!!input.by && v.by === input.by))) return [];
			if (rejectionOf(head, authorOf(claim))) return [];
			const outcome = approval({ votes }, head, policy, authorOf(claim), claim.paths);
			if (outcome.approved) return [];
			// A role that can block, if it holds one the change still needs; else an ordinary review, if more are needed.
			const role = outcome.awaiting.find((r) => holdsRole(policy, r, { reviewer: agent, by: input.by, teams: input.teams }, authorOf(claim)));
			const { required } = effectivePolicy(policy, claim.paths);
			if (!role && outcome.approvals >= required) return [];
			// As many reviews as it still needs: one for a role that can block; else the approvals missing, less those the
			// roles still awaited will bring (their approvals count too). Others already on it count.
			const needed = role ? 1 : required - outcome.approvals - outcome.awaiting.length;
			if (needed <= 0) return [];
			const holders = input.held?.[holdKey(head, role ?? "review")] ?? [];
			if (holders.filter((a) => a !== agent).length >= needed) return [];
			// One it holds already (it asked again mid-review): the same one, first.
			const mine = holders.includes(agent);
			return [{ claim, head, role: role ?? "review", blocking: !!role, approvals: outcome.approvals, needed, mine }];
		})
		.sort((a, b) => Number(b.mine) - Number(a.mine) || Number(b.blocking) - Number(a.blocking) || a.approvals - b.approvals || a.claim.since.localeCompare(b.claim.since));
	if (reviews.length) {
		const best = reviews[0].mine ? [reviews[0]] : reviews.filter((r) => r.blocking === reviews[0].blocking && r.approvals === reviews[0].approvals).slice(0, width);
		const pick = best[spread(agent, best.length)];
		return {
			kind: "review",
			change: pick.claim.change,
			author: pick.claim.agent,
			head: pick.head,
			role: pick.role,
			intent: pick.claim.intent,
			paths: pick.claim.paths,
			needed: pick.needed,
			next: `Review ${pick.claim.change} by ${pick.claim.agent}: review_access for its code, read the diff against the project's branch, run the checks, then vote as ${pick.role} on ${pick.head} with your evidence.`,
		};
	}

	// A piece of the backlog nobody has taken, and that a claim in force doesn't stand in the way of (it would be refused).
	// An abandoned claim holds nothing back: claiming its paths (or its change) releases it as stale.
	const live = input.open.filter((o) => !input.abandoned?.has(o.claim.change));
	const taken = new Set(live.map((o) => o.claim.change));
	// Backlog work lands on the project's branch: a claim into another branch stands in its way nowhere.
	const blocked = (w: WorkItem) => !!w.paths?.some((p) => live.some((o) => !o.claim.into && o.claim.paths.some((held) => entriesOverlap(p, held))));
	const open = input.work.filter((w) => !taken.has(w.id) && !input.merged.has(w.id) && !blocked(w));
	if (open.length) {
		const choices = open.slice(0, width);
		const work = choices[spread(agent, choices.length)];
		const takenOver = input.open.find((o) => o.claim.change === work.id && input.abandoned?.has(work.id));
		return {
			kind: "build",
			work,
			next: `Build ${work.id}: claim with change "${work.id}"${work.paths?.length ? ` and the paths it needs (likely ${work.paths.join(", ")})` : " and the paths it needs"}; if the claim is refused as someone else's change, call next again.${takenOver ? ` ${takenOver.claim.agent} started it and abandoned it: your claim releases theirs. Start from the project's branch; their branch may hold a partial start.` : ""} Then credentials, branch changes/${work.id} from the project's branch, make the change, push it to your fork and check.`,
		};
	}

	const waiting = own.filter((o) => o.head).map((o) => o.claim.change);
	const later = input.work.filter((w) => !taken.has(w.id) && !input.merged.has(w.id) && blocked(w)).map((w) => w.id);
	return {
		kind: "wait",
		reason: waiting.length
			? `your ${waiting.join(", ")} ${waiting.length === 1 ? "waits" : "wait"} for votes, and nothing else needs you`
			: later.length
				? `the rest of the backlog (${later.join(", ")}) overlaps claims in force`
				: "no reviews are waiting and the backlog is empty",
		retryAfterSeconds: 30,
		next: "Call next again in a little while.",
	};
}
