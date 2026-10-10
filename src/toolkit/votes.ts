import { entriesOverlap } from "../claim-paths";
import type { CasLog } from "../record-log";
import { appendRecord } from "./records";
import { type Stamper, stampPayload, verifyStamp } from "./stamp";

// Review (see docs/design.md). Reviewers append verdicts on the exact commit they reviewed. A merging agent
// counts them under the repo's policy, and the audit counts them again.

export interface VoteRecord {
	commit: string;
	reviewer: string;
	role: string;
	verdict: "approve" | "reject";
	evidence: string;
	at: string;
	by?: string;
	/** The voter's teams in the repo's org when they voted, as GitHive checked, so a grant to a team counts. */
	teams?: string[];
	stamp?: string;
}

export interface Votes {
	votes: VoteRecord[];
	/** Changes an agent has asked a person about, oldest first. Always kept here, never in a bucket. */
	flags?: FlagRecord[];
	/** When set, new votes are split by commit into this many buckets (see vote-store.ts). */
	buckets?: number;
	/** How many records repos hold the buckets. Absent means the project repo. */
	recordsRepos?: number;
	shardedAt?: string;
	shardedBecause?: string;
}

/** When an unsharded votes record should shard. These match the claims limits (see SHARD_WHEN in claims.ts). */
export const SHARD_VOTES_WHEN = { reviewers: 8, writesPerMinute: 15, windowMs: 5 * 60_000 };

export function votesShardingReason(
	state: Votes | null | undefined,
	reviewer: string,
	now = Date.now(),
): string | null {
	if (state?.buckets) return null;
	const since = now - SHARD_VOTES_WHEN.windowMs;
	const recent = (state?.votes ?? []).filter((v) => Date.parse(v.at) >= since);
	// This measures load rather than trust, so count reviewers by name: agents sharing an Access identity each
	// write their own votes.
	const reviewers = new Set([...recent.map((v) => v.reviewer), reviewer]);
	if (reviewers.size >= SHARD_VOTES_WHEN.reviewers) return `${reviewers.size} reviewers voting`;
	const writes = recent.length + (state?.flags ?? []).filter((f) => Date.parse(f.at) >= since).length;
	const perMinute = writes / (SHARD_VOTES_WHEN.windowMs / 60_000);
	if (perMinute > SHARD_VOTES_WHEN.writesPerMinute) return `${Math.round(perMinute)} votes a minute`;
	return null;
}

/** Shards the votes from here on, unless they already are. Votes cast so far stay in this record. */
export function shardVotes(log: CasLog<Votes>, input: { buckets: number; recordsRepos: number; reason: string }) {
	return appendRecord<Votes, "sharded">(
		log,
		"githive",
		() => ({ votes: [] }),
		(state) =>
			state.buckets
				? { refused: "sharded" }
				: {
						state: {
							...state,
							buckets: input.buckets,
							...(input.recordsRepos ? { recordsRepos: input.recordsRepos } : {}),
							shardedAt: new Date().toISOString(),
							shardedBecause: input.reason,
						},
						text: `Votes are sharded from here on, over ${input.buckets} buckets: ${input.reason}`,
					},
	);
}

/** An agent asking a person to decide something about a change, for example when reviewers disagree. */
export interface FlagRecord {
	change: string;
	reason: string;
	agent: string;
	/** Set when GitHive flagged a review this role awaits. It's answered once the role signs it off too. */
	role?: string;
	at: string;
	by?: string;
	stamp?: string;
}

/** Asks a person about a change. It waits in their inbox until a person votes on its commit. */
export function flagChange(log: CasLog<Votes>, input: Omit<FlagRecord, "at" | "by" | "stamp">, stamper?: Stamper) {
	return appendRecord<Votes, never>(
		log,
		input.agent,
		() => ({ votes: [] }),
		async (state) => {
			const record: FlagRecord = { ...input, at: new Date().toISOString() };
			const asked = stamper ? { ...record, by: stamper.by } : record;
			return {
				state: {
					...state,
					flags: [
						...(state.flags ?? []),
						stamper ? { ...asked, stamp: await stamper.stamp(stampPayload("flag", asked)) } : asked,
					],
				},
				text: `${input.agent} asks a person about ${input.change}: ${input.reason}`,
			};
		},
	);
}

/** The latest question about `change` that no person has answered with a vote on `head` since. */
export function openFlag(
	state: Pick<Votes, "votes" | "flags"> | null | undefined,
	change: string,
	head: string | null,
) {
	const flag = (state?.flags ?? []).filter((f) => f.change === change).at(-1);
	if (!flag) return null;
	// Only a person can answer. An agent, even the person's own, can't answer what was put to people.
	const answered = (state?.votes ?? []).some((v) => isPerson(v.by) && v.commit === head && v.at >= flag.at);
	return answered ? null : flag;
}

/** Paths whose changes need more review by default: dependencies, CI and deployment. */
export const SENSITIVE_PATHS = [
	".github/",
	"package.json",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	".npmrc",
	"Dockerfile",
	"wrangler.json",
	"wrangler.jsonc",
	"wrangler.toml",
];

export interface ReviewPolicy {
	/** Approvals a commit needs; 0 merges on the checks alone (unless a veto role must approve). */
	required: number;
	/** Roles whose rejection blocks a merge whatever the approvals; each must approve. */
	vetoes: string[];
	/** Stricter rules for a change touching any of these paths: more approvals, more vetoes. */
	escalate?: { paths: string[]; required?: number; vetoes?: string[] }[];
	/**
	 * Who may vote as each veto role: agent names, "person:*" (people, not their agents), a verified identity, a pool
	 * ("service:<id>/*"), an org team ("@<org>/<team>") or "githive". Unlisted roles use DEFAULT_GRANT.
	 */
	grants?: Record<string, string[]>;
}

/** Who holds a veto role the policy doesn't grant: people, and GitHive's own reviewers. */
export const DEFAULT_GRANT = ["person:*", "githive"];

/** The person a verified identity is or acts for, or null for service tokens and GitHive's own agents. */
export const personOf = (by: string | undefined) => by?.match(/^person:[^/]+/)?.[0] ?? null;

export const isPerson = (by: string | undefined) => !!by && /^person:[^/]+$/.test(by);

// The identity behind a pool grant ("service:<id>/*"), or null for any other grant.
const poolOf = (grant: string) => grant.match(/^((?:person|service):[^/*]+)\/\*$/)?.[1] ?? null;

export const blockingRoles = (policy: ReviewPolicy) => [
	...new Set([...policy.vetoes, ...(policy.escalate ?? []).flatMap((e) => e.vetoes ?? [])]),
];

/**
 * Warnings about who holds each blocking role. A role with a single holder waits whenever it's busy, and a role
 * no person holds can be flagged to people but not signed off by them.
 */
export function grantWarnings(policy: ReviewPolicy): string[] {
	return blockingRoles(policy).flatMap((role) => {
		const holders = policy.grants?.[role] ?? DEFAULT_GRANT;
		// A team is people, however many it has; a pool of one person's agents isn't.
		const people = holders.some((h) => h === "person:*" || isPerson(h) || h.startsWith("@"));
		const many = holders.some((h) => poolOf(h) || h.startsWith("@")) || holders.length > 1;
		const warnings: string[] = [];
		if (!many && !people)
			warnings.push(
				`${role} is held by ${holders[0]} alone: its reviews wait whenever it's busy. Grant it to two or more agents, or a pool ("service:<id>/*": every agent registered under that identity).`,
			);
		if (!people)
			warnings.push(
				`no person holds ${role}: when its reviews wait 10 minutes people are told, but can't sign them off. Add "person:*" to let them.`,
			);
		return warnings;
	});
}

/**
 * Whether `vote` was cast by someone granted `role`. Signed votes match by verified identity, so a name can't be
 * borrowed, and unsigned records match by name. A pool member can't vote as the role on its own pool's change.
 */
export function holdsRole(
	policy: ReviewPolicy,
	role: string,
	vote: Pick<VoteRecord, "reviewer" | "by" | "teams">,
	author?: Pick<Author, "by">,
) {
	return (policy.grants?.[role] ?? DEFAULT_GRANT).some((grant) => {
		// People themselves, not their agents, whose identities start with the same person.
		if (grant === "person:*") return isPerson(vote.by);
		if (grant.startsWith("@")) return !!vote.teams?.includes(grant);
		const pool = poolOf(grant);
		if (pool) return !!vote.by?.startsWith(`${pool}/`) && !author?.by?.startsWith(`${pool}/`);
		if (/^(person|service):/.test(grant)) return vote.by === grant;
		if (grant === "githive")
			return vote.by ? vote.by === `service:githive-reviewer:${role}` : vote.reviewer === `githive-${role}`;
		return vote.reviewer === grant && (!vote.by || vote.by.endsWith(`/${grant}`));
	});
}

/** The policy for a change touching `paths`, made stricter by every escalation whose paths it touches. */
export function effectivePolicy(policy: ReviewPolicy, paths: string[]): { required: number; vetoes: string[] } {
	let { required, vetoes } = policy;
	for (const e of policy.escalate ?? []) {
		if (!paths.some((p) => e.paths.some((q) => entriesOverlap(p, q)))) continue;
		required = Math.max(required, e.required ?? required);
		vetoes = [...new Set([...vetoes, ...(e.vetoes ?? [])])];
	}
	return { required, vetoes };
}

export function vote(log: CasLog<Votes>, input: Omit<VoteRecord, "at" | "by" | "stamp">, stamper?: Stamper) {
	return appendRecord<Votes, never>(
		log,
		input.reviewer,
		() => ({ votes: [] }),
		async (state) => {
			const record: VoteRecord = { ...input, at: new Date().toISOString() };
			const cast = stamper ? { ...record, by: stamper.by } : record;
			return {
				state: {
					...state,
					votes: [...state.votes, stamper ? { ...cast, stamp: await stamper.stamp(stampPayload("vote", cast)) } : cast],
				},
				text: `${input.reviewer} (${input.role}) ${input.verdict === "approve" ? "approves" : "rejects"} ${input.commit}: ${input.evidence}`,
			};
		},
	);
}

/** A change's author, whose own approval doesn't count: the claim's agent and its verified identity. */
export interface Author {
	agent: string;
	by?: string;
}

/**
 * Whether `commit` may merge under `policy`. Each identity counts once by its latest verdict, a person and their
 * agents approve once between them, and neither the author nor the author's sibling agents can approve. Every veto
 * role must approve through someone granted it (see holdsRole), so a veto can always stop a merge.
 */
export function approval(
	state: Pick<Votes, "votes"> | null | undefined,
	commit: string,
	base: ReviewPolicy,
	author?: Author,
	paths: string[] = [],
) {
	const policy = effectivePolicy(base, paths);
	const latest = new Map<string, VoteRecord>();
	for (const v of state?.votes ?? []) if (v.commit === commit) latest.set(v.by ?? `name:${v.reviewer}`, v);
	const verdicts = [...latest.values()];
	// When the author is one of a person's agents, the person may approve but their other agents may not.
	const authorPerson = author?.by && !isPerson(author.by) ? personOf(author.by) : null;
	const isAuthor = (v: VoteRecord) =>
		!!author &&
		((!!v.by && v.by === author.by) ||
			v.reviewer === author.agent ||
			(!!authorPerson && personOf(v.by) === authorPerson && !isPerson(v.by)));
	const approving = verdicts.filter((v) => v.verdict === "approve" && !isAuthor(v));
	// One approval per person, however many of their agents approve.
	const approvals = new Set(approving.map((v) => personOf(v.by) ?? v.by ?? `name:${v.reviewer}`)).size;
	const asRole = (v: VoteRecord) => policy.vetoes.includes(v.role) && holdsRole(base, v.role, v, author);
	const vetoedBy = verdicts.filter((v) => v.verdict === "reject" && asRole(v)).map((v) => v.reviewer);
	const awaiting = policy.vetoes.filter((role) => !approving.some((v) => v.role === role && asRole(v)));
	const ungranted = verdicts
		.filter((v) => policy.vetoes.includes(v.role) && !asRole(v))
		.map((v) => `${v.reviewer} (${v.role})`);
	return {
		approved: approvals >= policy.required && !vetoedBy.length && !awaiting.length,
		approvals,
		vetoedBy,
		awaiting,
		...(ungranted.length ? { ungranted } : {}),
	};
}

/** The votes that count. With a stamp key in the registry, only those GitHive stamped. */
export async function countedVotes(cast: VoteRecord[], stampKey: string | undefined) {
	if (!stampKey) return cast;
	const checked = await Promise.all(
		cast.map(async (v) => ((await verifyStamp(stampKey, stampPayload("vote", v), v.stamp)) ? v : null)),
	);
	return checked.filter((v) => v !== null);
}
