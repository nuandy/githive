import { entriesOverlap } from "../claim-paths";
import type { ClaimRecord } from "./claims";
import { hivePlace } from "./hive-agents";
import {
	type Author,
	approval,
	effectivePolicy,
	holdsRole,
	type ReviewPolicy,
	sentBackBy,
	type VoteRecord,
} from "./votes";

// What there is to do: reviews an agent may give and backlog items nobody has claimed. GitHive assigns nothing;
// each agent looks and picks. Each sees equally good choices in its own order, so a crowd spreads out instead of
// all taking the first. Nothing is reserved: if two agents pick the same thing, the claim or vote count settles it.

/** A backlog item: taken once a change with its id is claimed, done once that change merges. */
export interface WorkItem {
	id: string;
	title: string;
	intent: string;
	/** What it's likely to touch, as a starting claim. */
	paths?: string[];
	/** Items it depends on. It's handed out only once each has merged (see ClaimRecord.after). */
	after?: string[];
	/**
	 * Items it lands after, though it's handed out at once: it's claimed with them as `after`, so it's built while they
	 * are and merges only once they have.
	 */
	landsAfter?: string[];
	/** Clef found it too big for one change: whoever takes it may build a part and add the rest to the backlog. */
	big?: true;
	by: string;
	/** The verified identity of whoever added it: building it is other people's work for anyone else's agent. */
	owner?: string;
	at: string;
}

export interface Work {
	items: WorkItem[];
}

export const workId = (title: string) =>
	title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48) || "work";

export interface WorkInput {
	agent: string;
	/** The caller's verified identity, to tell whether it holds a role. */
	by?: string;
	/** The caller's teams in the repo's org, for roles granted to a team. */
	teams?: string[];
	policy: ReviewPolicy;
	/** A change's policy by the branch it lands on (see branch-rules.ts). Defaults to `policy`. */
	policyOf?: (claim: ClaimRecord) => ReviewPolicy;
	/** The claims in force, each with its change's pushed head, or null if nothing is pushed. */
	open: { claim: ClaimRecord; head: string | null }[];
	votes: VoteRecord[];
	merged: Set<string>;
	/** Review holds by holdKey. A review held by as many agents as it needs isn't offered. */
	held?: Record<string, string[]>;
	work: WorkItem[];
	/** Changes their agents abandoned (see staleness.ts). Their claims block nothing and their work is free. */
	abandoned?: Set<string>;
}

export interface ReviewOption {
	change: string;
	author: string;
	head: string;
	/** A blocking role the change awaits and the caller holds, otherwise "review". */
	role: string;
	/** Whether the role can veto the merge. These reviews hold a change up the most. */
	blocking: boolean;
	intent: string;
	paths: string[];
	/** Approvals so far, and how many more reviews it needs in this role. */
	approvals: number;
	needed: number;
	/** Agents reviewing it in this role now, including the caller once it starts. */
	reviewing: string[];
	/** An earlier commit of the change the caller rejected, and its findings: the fix is for it to check. */
	earlier?: { commit: string; findings: string };
}

/**
 * The reviews the caller may give: others' pushed changes it hasn't voted on, that weren't sent back and still
 * need an approval it can give. Its own holds come first, then blocking roles, fewest approvals and oldest.
 */
export function reviewsFor(input: WorkInput): ReviewOption[] {
	const { agent } = input;
	const options = input.open
		.filter((open): open is { claim: ClaimRecord; head: string } => !!open.head && open.claim.agent !== agent)
		.flatMap(({ claim, head }) => reviewOption(input, claim, head) ?? [])
		.sort(
			(a, b) =>
				Number(b.reviewing.includes(agent)) - Number(a.reviewing.includes(agent)) ||
				Number(!!b.earlier) - Number(!!a.earlier) ||
				Number(b.blocking) - Number(a.blocking) ||
				a.approvals - b.approvals ||
				a.since.localeCompare(b.since),
		);
	return inOwnOrder(
		agent,
		options,
		(a, b) =>
			a.reviewing.includes(agent) === b.reviewing.includes(agent) &&
			!!a.earlier === !!b.earlier &&
			a.blocking === b.blocking &&
			a.approvals === b.approvals,
	).map(({ since: _, ...option }) => option);
}

/**
 * The caller's latest rejection of an earlier commit of `change`, if it has one: it reviews the revision first, since
 * it knows what it found.
 */
export function earlierRejection(input: Pick<WorkInput, "agent" | "by" | "votes">, change: string, head: string) {
	const mine = (vote: VoteRecord) => {
		if (vote.reviewer === input.agent) return true;
		if (!input.by) return false;
		return vote.by === input.by;
	};
	const rejectedEarlier = (vote: VoteRecord) => {
		if (vote.change !== change) return false;
		if (vote.commit === head) return false;
		if (vote.verdict !== "reject") return false;
		return mine(vote);
	};
	const latest = input.votes
		.filter(rejectedEarlier)
		.sort((a, b) => a.at.localeCompare(b.at))
		.at(-1);
	return latest ? { commit: latest.commit, findings: latest.evidence } : undefined;
}

const authorOf = (claim: ClaimRecord): Author => ({ agent: claim.agent, ...(claim.by ? { by: claim.by } : {}) });

/**
 * How many more reviewers `claim`'s `head` needs in `role`: one for a blocking role it still awaits, none for one it
 * doesn't; for an ordinary review, the approvals still missing beyond those the awaited roles will bring. `votes`
 * are the votes that count.
 */
export function reviewersNeeded(
	policy: ReviewPolicy,
	claim: ClaimRecord,
	head: string,
	votes: VoteRecord[],
	role: string,
) {
	const outcome = approval({ votes }, head, policy, authorOf(claim), claim.paths);
	if (outcome.approved) return 0;
	if (role !== "review") return outcome.awaiting.includes(role) ? 1 : 0;
	const { required } = effectivePolicy(policy, claim.paths);
	return Math.max(0, required - outcome.approvals - outcome.awaiting.length);
}

// The review the caller may give on `claim`'s pushed `head`, with its claim time for sorting, or null if none.
function reviewOption(input: WorkInput, claim: ClaimRecord, head: string): (ReviewOption & { since: string }) | null {
	const { agent, votes } = input;
	const votesCast = votes.filter((vote) => vote.commit === head);
	if (votesCast.some((vote) => vote.reviewer === agent || (!!input.by && vote.by === input.by))) return null;
	if (sentBackBy(votesCast, head, claim.agent)) return null;
	const policy = input.policyOf?.(claim) ?? input.policy;
	const outcome = approval({ votes }, head, policy, authorOf(claim), claim.paths);
	if (outcome.approved) return null;
	// Prefer a blocking role the change still needs; otherwise an ordinary review, if more are needed.
	const caller = { reviewer: agent, by: input.by, teams: input.teams };
	const role = outcome.awaiting.find((awaited) => holdsRole(policy, awaited, caller, authorOf(claim)));
	const needed = reviewersNeeded(policy, claim, head, votes, role ?? "review");
	if (needed <= 0) return null;
	const reviewing = input.held?.[holdKey(head, role ?? "review")] ?? [];
	if (reviewing.filter((reviewer) => reviewer !== agent).length >= needed) return null;
	const earlier = earlierRejection(input, claim.change, head);
	return {
		change: claim.change,
		author: claim.agent,
		head,
		...(earlier ? { earlier } : {}),
		role: role ?? "review",
		blocking: !!role,
		intent: claim.intent,
		paths: claim.paths,
		approvals: outcome.approvals,
		needed,
		reviewing,
		since: claim.since,
	};
}

export interface BacklogView {
	/**
	 * Unclaimed or abandoned, clear of other claims, and with its dependencies merged. Those with longer chains of
	 * pieces waiting behind them come first, each with how many wait on it in all (`unblocks`).
	 */
	open: (WorkItem & { abandonedBy?: string; unblocks?: number })[];
	/** Claimed, overlapping a claim in force, or waiting on a dependency. */
	waiting: { id: string; reason: string }[];
}

/** Backlog items free to build, in the caller's own order so a crowd spreads over them, and why the rest wait. */
export function backlogFor(input: WorkInput): BacklogView {
	// An abandoned claim holds nothing back, since claiming its paths releases it as stale.
	const live = input.open.filter((change) => !input.abandoned?.has(change.claim.change));
	const holder = new Map(live.map((change) => [change.claim.change, change.claim.agent]));
	// Backlog work lands on the project's branch, so claims into other branches don't block it.
	const covers = (claim: ClaimRecord, item: WorkItem) =>
		item.paths?.some((path) => claim.paths.some((held) => entriesOverlap(path, held)));
	const overlapping = (item: WorkItem) => live.find((change) => !change.claim.into && covers(change.claim, item));
	const unmerged = (item: WorkItem) => (item.after ?? []).filter((dependency) => !input.merged.has(dependency));
	const abandonerOf = (item: WorkItem) =>
		input.open.find((change) => change.claim.change === item.id && input.abandoned?.has(item.id))?.claim.agent;
	const open: BacklogView["open"] = [];
	const waiting: BacklogView["waiting"] = [];
	for (const item of input.work) {
		if (input.merged.has(item.id)) continue;
		const by = holder.get(item.id);
		const over = overlapping(item);
		const dependencies = unmerged(item);
		if (by) waiting.push({ id: item.id, reason: `claimed by ${by}` });
		else if (over) waiting.push({ id: item.id, reason: `overlaps ${over.claim.change}'s claim (${over.claim.agent})` });
		else if (dependencies.length) waiting.push({ id: item.id, reason: `waits on ${dependencies.join(", ")} to merge` });
		else {
			const abandonedBy = abandonerOf(item);
			open.push({ ...item, ...(abandonedBy ? { abandonedBy } : {}) });
		}
	}
	return { open: criticalFirst(input.agent, open, input.work, input.merged), waiting };
}

interface Behind {
	/** The longest run of pieces waiting one after another behind this one. */
	chain: number;
	/** Every piece waiting on it, directly or through others. */
	waiting: Set<string>;
}

/**
 * The free pieces, those with the longest chains waiting behind them first, then those the most wait on: starting
 * them first is what shortens the whole backlog. Equals keep each agent's own order, so a crowd still spreads out.
 * Only the dependencies pieces declare count (`after`, `landsAfter`); nothing is guessed.
 */
function criticalFirst(agent: string, open: BacklogView["open"], work: WorkItem[], merged: Set<string>) {
	const behind = piecesBehind(work.filter((item) => !merged.has(item.id)));
	const weighed = open.map((item) => {
		const found = behind(item.id);
		const unblocks = found.waiting.size;
		return { item: unblocks ? { ...item, unblocks } : item, chain: found.chain, unblocks };
	});
	weighed.sort((a, b) => b.chain - a.chain || b.unblocks - a.unblocks);
	const same = (a: (typeof weighed)[number], b: (typeof weighed)[number]) => {
		if (a.chain !== b.chain) return false;
		return a.unblocks === b.unblocks;
	};
	return inOwnOrder(agent, weighed, same).map((weight) => weight.item);
}

/**
 * What waits behind each piece among `items`, worked out once per piece. A loop in the backlog (which claims refuse,
 * but pieces can name each other) counts each piece once rather than going round.
 */
function piecesBehind(items: WorkItem[]) {
	const waitersOf = new Map<string, string[]>();
	for (const item of items)
		for (const dependency of [...(item.after ?? []), ...(item.landsAfter ?? [])])
			waitersOf.set(dependency, [...(waitersOf.get(dependency) ?? []), item.id]);
	const known = new Map<string, Behind>();
	const visiting = new Set<string>();
	const behind = (id: string): Behind => {
		const found = known.get(id);
		if (found) return found;
		if (visiting.has(id)) return { chain: 0, waiting: new Set() };
		visiting.add(id);
		const result: Behind = { chain: 0, waiting: new Set() };
		for (const waiter of waitersOf.get(id) ?? []) {
			const next = behind(waiter);
			result.chain = Math.max(result.chain, next.chain + 1);
			result.waiting.add(waiter);
			for (const further of next.waiting) result.waiting.add(further);
		}
		result.waiting.delete(id);
		visiting.delete(id);
		known.set(id, result);
		return result;
	};
	return behind;
}

// Rotates each run of equally good items in the sorted `list` to start at a place of the agent's own.
function inOwnOrder<T>(agent: string, list: T[], same: (a: T, b: T) => boolean): T[] {
	// Runs of equally good items, in order: each run starts with the item the rest are compared to.
	const runs: T[][] = [];
	for (const item of list) {
		const current = runs.at(-1);
		const leader = current?.[0];
		if (current && leader !== undefined && same(leader, item)) current.push(item);
		else runs.push([item]);
	}
	return runs.flatMap((run) => {
		const at = spread(agent, run.length);
		return [...run.slice(at), ...run.slice(0, at)];
	});
}

/**
 * A review hold's key: the commit and the role. Keying by role keeps an ordinary reviewer's hold from turning away
 * the holder of a blocking role.
 */
export const holdKey = (head: string, role: string) => `${head}#${role}`;

/** How long a review awaited by a blocking role may sit unheld before people are told. */
export const ROLE_WAIT_MS = 10 * 60_000;

/** Unheld reviews that blocking roles still owe, on pushed changes that weren't sent back. */
export function waitingRoleReviews(input: Pick<WorkInput, "policy" | "policyOf" | "open" | "votes" | "held">) {
	return input.open.flatMap(({ claim, head }) => {
		if (!head) return [];
		const author = authorOf(claim);
		if (sentBackBy(input.votes, head, author.agent)) return [];
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

// Where an agent starts among equally good choices. A repo's hosted agents start at their places in its hive, so as
// many as there are choices start on different ones. Any other agent starts where a small, stable hash of its name
// says, which spreads a crowd only as well as chance does.
function spread(agent: string, count: number) {
	const place = hivePlace(agent);
	if (place !== undefined) return place % count;
	let hash = 0x811c9dc5;
	for (let i = 0; i < agent.length; i++) hash = Math.imul(hash ^ agent.charCodeAt(i), 0x01000193);
	return (hash >>> 0) % count;
}
