import type { CasLog } from "../record-log";
import { entriesOverlap } from "../claim-paths";
import type { ClaimRecord } from "./claims";
import { appendRecord } from "./records";
import { type Author, approval, effectivePolicy, holdsRole, type ReviewPolicy, type VoteRecord } from "./votes";

// What there is to do, for agents to choose from: reviews waiting that an
// agent may give, and pieces of the backlog nobody has claimed. GitHive tells
// no agent what to do: each looks (reviews, backlog, claims, status) and picks,
// and its own judgement and instructions order its work. Each sees the choices
// in an order of its own, so a crowd looking at once spreads over them rather
// than all taking the first. Nothing is reserved: two agents picking the same
// thing both try, and the claim (or the vote count) settles it.

/** A piece of work in the repo's backlog: taken once a change by its id is claimed, done once that change merges. */
export interface WorkItem {
	id: string;
	title: string;
	intent: string;
	/** What it's likely to touch: the claim to start from. */
	paths?: string[];
	/** Pieces it depends on: it's handed out only once each has merged (and its claim says so, see ClaimRecord.after). */
	after?: string[];
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
	return appendRecord<Work, string>(
		log,
		input.by,
		() => ({ items: [] }),
		(state) =>
			state.items.some((i) => i.id === input.id)
				? { refused: `${input.id} is in the backlog already` }
				: {
						state: { items: [...state.items, { ...input, at: new Date().toISOString() }] },
						text: `${input.by} adds ${input.id} to the backlog: ${input.title}`,
					},
	);
}

/**
 * Add several pieces of work at once: one write for a backlog filed together.
 * Those whose ids are in the backlog already are left as they are, and named.
 */
export async function addWorks(log: CasLog<Work>, by: string, items: Omit<WorkItem, "at" | "by">[]) {
	let already: string[] = [];
	const added = await appendRecord<Work, string>(
		log,
		by,
		() => ({ items: [] }),
		(state) => {
			already = items.filter((i) => state.items.some((s) => s.id === i.id)).map((i) => i.id);
			const fresh = items.filter((i) => !already.includes(i.id));
			if (!fresh.length) return { refused: "all of them are in the backlog already" };
			const at = new Date().toISOString();
			return {
				state: { items: [...state.items, ...fresh.map((i) => ({ ...i, by, at }))] },
				text: `${by} adds ${fresh.map((i) => i.id).join(", ")} to the backlog`,
			};
		},
	);
	return { ok: added.ok, added: added.ok ? items.map((i) => i.id).filter((id) => !already.includes(id)) : [], already };
}

/** What's known of the repo's open work, for the choices an agent has (see reviewsFor, backlogFor). */
export interface WorkInput {
	agent: string;
	/** The caller's verified identity, as its votes would carry it (to tell whether it holds a role). */
	by?: string;
	/** The teams the caller is on in the repo's org (@<org>/<team>), for roles granted to a team. */
	teams?: string[];
	policy: ReviewPolicy;
	/** A change's policy, by the branch it lands on (see branch-rules.ts); absent, `policy` for all. */
	policyOf?: (claim: ClaimRecord) => ReviewPolicy;
	/** The claims in force, each with its change's pushed head (null: nothing pushed). */
	open: { claim: ClaimRecord; head: string | null }[];
	/** The votes that count. */
	votes: VoteRecord[];
	/** Changes that merged. */
	merged: Set<string>;
	/** Reviews agents are on now, by commit and role (review holds, see holdKey): one held as often as it's needed isn't offered. */
	held?: Record<string, string[]>;
	work: WorkItem[];
	/** Changes whose agents abandoned them (see staleness.ts): their claims stand in nobody's way, and their work is free to take. */
	abandoned?: Set<string>;
}

/** A review the caller may give: a change pushed, waiting for approvals in a role it holds (or ordinary ones). */
export interface ReviewOption {
	change: string;
	author: string;
	head: string;
	/** The role to vote as: one that can block, if the change awaits one the caller holds; else "review". */
	role: string;
	/** Whether the role can block the merge (a veto role): those reviews hold a change up most. */
	blocking: boolean;
	intent: string;
	paths: string[];
	/** Approvals it has, and how many more reviews it needs in this role. */
	approvals: number;
	needed: number;
	/** Agents reviewing it in this role now (review holds), the caller among them if it started. */
	reviewing: string[];
}

/**
 * The reviews the caller may give: changes pushed, not its own, not voted on
 * by it, not sent back for changes, and still needing approvals it can give
 * (a role that can block it holds, else ordinary approvals) that others
 * reviewing don't already cover. Those it's reviewing first, then the roles
 * that can block, the fewest approvals and the oldest, equals in its own order.
 */
export function reviewsFor(input: WorkInput): ReviewOption[] {
	const { agent, votes } = input;
	const policyOf = (claim: ClaimRecord) => input.policyOf?.(claim) ?? input.policy;
	const authorOf = (c: ClaimRecord): Author => ({ agent: c.agent, ...(c.by ? { by: c.by } : {}) });
	const on = (head: string) => votes.filter((v) => v.commit === head);
	const options = input.open
		.filter((o): o is { claim: ClaimRecord; head: string } => !!o.head && o.claim.agent !== agent)
		.flatMap(({ claim, head }) => {
			const cast = on(head);
			if (cast.some((v) => v.reviewer === agent || (!!input.by && v.by === input.by))) return [];
			if (cast.some((v) => v.verdict === "reject" && v.reviewer !== claim.agent)) return [];
			const policy = policyOf(claim);
			const outcome = approval({ votes }, head, policy, authorOf(claim), claim.paths);
			if (outcome.approved) return [];
			// A role that can block, if it holds one the change still needs; else an ordinary review, if more are needed.
			const role = outcome.awaiting.find((r) =>
				holdsRole(policy, r, { reviewer: agent, by: input.by, teams: input.teams }, authorOf(claim)),
			);
			const { required } = effectivePolicy(policy, claim.paths);
			if (!role && outcome.approvals >= required) return [];
			// As many reviews as it still needs: one for a role that can block; else the approvals missing, less those the
			// roles still awaited will bring (their approvals count too). Others already on it count.
			const needed = role ? 1 : required - outcome.approvals - outcome.awaiting.length;
			if (needed <= 0) return [];
			const reviewing = input.held?.[holdKey(head, role ?? "review")] ?? [];
			if (reviewing.filter((a) => a !== agent).length >= needed) return [];
			return [
				{
					change: claim.change,
					author: claim.agent,
					head,
					role: role ?? "review",
					blocking: !!role,
					intent: claim.intent,
					paths: claim.paths,
					approvals: outcome.approvals,
					needed,
					reviewing,
					since: claim.since,
				},
			];
		})
		.sort(
			(a, b) =>
				Number(b.reviewing.includes(agent)) - Number(a.reviewing.includes(agent)) ||
				Number(b.blocking) - Number(a.blocking) ||
				a.approvals - b.approvals ||
				a.since.localeCompare(b.since),
		);
	return inOwnOrder(
		agent,
		options,
		(a, b) =>
			a.reviewing.includes(agent) === b.reviewing.includes(agent) &&
			a.blocking === b.blocking &&
			a.approvals === b.approvals,
	).map(({ since: _, ...o }) => o);
}

/** The backlog as the caller may take it: pieces free to build now, and why the rest wait. */
export interface BacklogView {
	/** Free to build: nobody holds a claim on it (or its agent abandoned it), nor on its paths, and what it depends on merged. */
	open: (WorkItem & { abandonedBy?: string })[];
	/** Not yet: claimed, overlapping a claim in force, or waiting on what it depends on. */
	waiting: { id: string; reason: string }[];
}

/**
 * The backlog's pieces free to build now, in the caller's own order (equally
 * good, so a crowd looking at once spreads over them), and why the others
 * aren't. Merged pieces are left out.
 */
export function backlogFor(input: WorkInput): BacklogView {
	// An abandoned claim holds nothing back: claiming its paths (or its change) releases it as stale.
	const live = input.open.filter((o) => !input.abandoned?.has(o.claim.change));
	const holder = new Map(live.map((o) => [o.claim.change, o.claim.agent]));
	// Backlog work lands on the project's branch: a claim into another branch stands in its way nowhere.
	const overlapping = (w: WorkItem) =>
		live.find((o) => !o.claim.into && w.paths?.some((p) => o.claim.paths.some((held) => entriesOverlap(p, held))));
	const unmerged = (w: WorkItem) => (w.after ?? []).filter((dep) => !input.merged.has(dep));
	const open: BacklogView["open"] = [];
	const waiting: BacklogView["waiting"] = [];
	for (const w of input.work) {
		if (input.merged.has(w.id)) continue;
		const by = holder.get(w.id);
		const over = overlapping(w);
		const deps = unmerged(w);
		if (by) waiting.push({ id: w.id, reason: `claimed by ${by}` });
		else if (over) waiting.push({ id: w.id, reason: `overlaps ${over.claim.change}'s claim (${over.claim.agent})` });
		else if (deps.length) waiting.push({ id: w.id, reason: `waits on ${deps.join(", ")} to merge` });
		else {
			const abandonedBy = input.open.find((o) => o.claim.change === w.id && input.abandoned?.has(w.id))?.claim.agent;
			open.push({ ...w, ...(abandonedBy ? { abandonedBy } : {}) });
		}
	}
	return { open: inOwnOrder(input.agent, open, () => true), waiting };
}

/** `list` (sorted best first) with each run of equally good items (`same`) started at a place of the agent's own. */
function inOwnOrder<T>(agent: string, list: T[], same: (a: T, b: T) => boolean): T[] {
	const out: T[] = [];
	for (let i = 0; i < list.length;) {
		let j = i + 1;
		while (j < list.length && same(list[i], list[j])) j++;
		const run = list.slice(i, j);
		const at = spread(agent, run.length);
		out.push(...run.slice(at), ...run.slice(0, at));
		i = j;
	}
	return out;
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
export function waitingRoleReviews(input: Pick<WorkInput, "policy" | "policyOf" | "open" | "votes" | "held">) {
	return input.open.flatMap(({ claim, head }) => {
		if (!head) return [];
		const author: Author = { agent: claim.agent, ...(claim.by ? { by: claim.by } : {}) };
		if (input.votes.some((v) => v.commit === head && v.verdict === "reject" && v.reviewer !== author.agent)) return [];
		const { awaiting } = approval(
			{ votes: input.votes },
			head,
			input.policyOf?.(claim) ?? input.policy,
			author,
			claim.paths,
		);
		return awaiting
			.filter((role) => !input.held?.[holdKey(head, role)]?.length)
			.map((role) => ({ change: claim.change, head, role }));
	});
}

/** A small, stable hash, to spread agents over equally good choices. */
function spread(agent: string, n: number) {
	let h = 0x811c9dc5;
	for (let i = 0; i < agent.length; i++) h = Math.imul(h ^ agent.charCodeAt(i), 0x01000193);
	return (h >>> 0) % n;
}
