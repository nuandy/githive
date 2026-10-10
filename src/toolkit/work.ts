import type { CasLog } from "../record-log";
import { entriesOverlap } from "../claim-paths";
import type { ClaimRecord } from "./claims";
import { appendRecord } from "./records";
import { type Author, approval, effectivePolicy, holdsRole, type ReviewPolicy, type VoteRecord } from "./votes";

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
	by: string;
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

/** Adds an item to the backlog, refused if its id is taken. */
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

/** Adds several items in one write. Items whose ids are taken are left alone and returned in `already`. */
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
}

/**
 * The reviews the caller may give: others' pushed changes it hasn't voted on, that weren't sent back and still
 * need an approval it can give. Its own holds come first, then blocking roles, fewest approvals and oldest.
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
			// Prefer a blocking role the change still needs; otherwise an ordinary review, if more are needed.
			const role = outcome.awaiting.find((r) =>
				holdsRole(policy, r, { reviewer: agent, by: input.by, teams: input.teams }, authorOf(claim)),
			);
			const { required } = effectivePolicy(policy, claim.paths);
			if (!role && outcome.approvals >= required) return [];
			// One review for a blocking role. Otherwise the missing approvals, minus those the awaited roles will bring.
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

export interface BacklogView {
	/** Unclaimed or abandoned, clear of other claims, and with its dependencies merged. */
	open: (WorkItem & { abandonedBy?: string })[];
	/** Claimed, overlapping a claim in force, or waiting on a dependency. */
	waiting: { id: string; reason: string }[];
}

/** Backlog items free to build, in the caller's own order so a crowd spreads over them, and why the rest wait. */
export function backlogFor(input: WorkInput): BacklogView {
	// An abandoned claim holds nothing back, since claiming its paths releases it as stale.
	const live = input.open.filter((o) => !input.abandoned?.has(o.claim.change));
	const holder = new Map(live.map((o) => [o.claim.change, o.claim.agent]));
	// Backlog work lands on the project's branch, so claims into other branches don't block it.
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

// Rotates each run of equally good items in the sorted `list` to start at a place of the agent's own.
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

// A small, stable hash that spreads agents over equally good choices.
function spread(agent: string, n: number) {
	let h = 0x811c9dc5;
	for (let i = 0; i < agent.length; i++) h = Math.imul(h ^ agent.charCodeAt(i), 0x01000193);
	return (h >>> 0) % n;
}
