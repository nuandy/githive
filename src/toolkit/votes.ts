import { entriesOverlap } from "../claim-paths";
import { isHiveAgent, isHiveIdentity } from "./hive-agents";
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
		(state) => {
			if (state.buckets) return { refused: "sharded" };
			return {
				state: {
					...state,
					buckets: input.buckets,
					...(input.recordsRepos ? { recordsRepos: input.recordsRepos } : {}),
					shardedAt: new Date().toISOString(),
					shardedBecause: input.reason,
				},
				text: `Votes are sharded from here on, over ${input.buckets} buckets: ${input.reason}`,
			};
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
			const flag = stamper ? { ...asked, stamp: await stamper.stamp(stampPayload("flag", asked)) } : asked;
			return {
				state: { ...state, flags: [...(state.flags ?? []), flag] },
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
	...new Set([...policy.vetoes, ...(policy.escalate ?? []).flatMap((escalation) => escalation.vetoes ?? [])]),
];

/**
 * Warnings about who holds each blocking role. A role with a single holder waits whenever it's busy, and a role
 * no person holds can be flagged to people but not signed off by them.
 */
export function grantWarnings(policy: ReviewPolicy): string[] {
	return blockingRoles(policy).flatMap((role) => {
		const holders = policy.grants?.[role] ?? DEFAULT_GRANT;
		// A team is people, however many it has; a pool of one person's agents isn't.
		const people = holders.some((holder) => holder === "person:*" || isPerson(holder) || holder.startsWith("@"));
		const many = holders.some((holder) => poolOf(holder) || holder.startsWith("@")) || holders.length > 1;
		const warnings: string[] = [];
		if (!many && !people)
			warnings.push(
				`${role} is held by ${holders[0]} alone: its reviews wait whenever it's busy. Grant it to ` +
					`two or more agents, or a pool ("service:<id>/*": every agent registered under that ` +
					"identity).",
			);
		if (!people)
			warnings.push(
				`no person holds ${role}: when its reviews wait 10 minutes people are told, but can't sign ` +
					`them off. Add "person:*" to let them.`,
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
		if (grant === "githive") return isGitHiveReviewer(vote, role);
		return vote.reviewer === grant && (!vote.by || vote.by.endsWith(`/${grant}`));
	});
}

/**
 * GitHive's reviewer for `role`, or one of a repo's hosted agents (hive-agents.ts) reviewing under its own name: the
 * voters the "githive" grant names. Without a stamp, the name alone says, since only GitHive's agents take githive-.
 */
function isGitHiveReviewer(vote: Pick<VoteRecord, "reviewer" | "by">, role: string) {
	if (vote.by) return vote.by === `service:githive-reviewer:${role}` || isHiveIdentity(vote.by);
	return vote.reviewer === `githive-${role}` || isHiveAgent(vote.reviewer);
}

/** The policy for a change touching `paths`, made stricter by every escalation whose paths it touches. */
export function effectivePolicy(policy: ReviewPolicy, paths: string[]): { required: number; vetoes: string[] } {
	let { required, vetoes } = policy;
	for (const escalation of policy.escalate ?? []) {
		if (!paths.some((path) => escalation.paths.some((entry) => entriesOverlap(path, entry)))) continue;
		required = Math.max(required, escalation.required ?? required);
		vetoes = [...new Set([...vetoes, ...(escalation.vetoes ?? [])])];
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
			const stamped = stamper ? { ...cast, stamp: await stamper.stamp(stampPayload("vote", cast)) } : cast;
			const verb = input.verdict === "approve" ? "approves" : "rejects";
			return {
				state: { ...state, votes: [...state.votes, stamped] },
				text: `${input.reviewer} (${input.role}) ${verb} ${input.commit}: ${input.evidence}`,
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
	for (const vote of state?.votes ?? [])
		if (vote.commit === commit) latest.set(vote.by ?? `name:${vote.reviewer}`, vote);
	const verdicts = [...latest.values()];
	// When the author is one of a person's agents, the person may approve but their other agents may not.
	const authorPerson = author?.by && !isPerson(author.by) ? personOf(author.by) : null;
	const isAuthor = (vote: VoteRecord) =>
		!!author &&
		((!!vote.by && vote.by === author.by) ||
			vote.reviewer === author.agent ||
			(!!authorPerson && personOf(vote.by) === authorPerson && !isPerson(vote.by)));
	const approving = verdicts.filter((vote) => vote.verdict === "approve" && !isAuthor(vote));
	// One approval per person, however many of their agents approve.
	const approvals = new Set(approving.map((vote) => personOf(vote.by) ?? vote.by ?? `name:${vote.reviewer}`)).size;
	const asRole = (vote: VoteRecord) => policy.vetoes.includes(vote.role) && holdsRole(base, vote.role, vote, author);
	const vetoedBy = verdicts.filter((vote) => vote.verdict === "reject" && asRole(vote)).map((vote) => vote.reviewer);
	const awaiting = policy.vetoes.filter((role) => !approving.some((vote) => vote.role === role && asRole(vote)));
	const ungranted = verdicts
		.filter((vote) => policy.vetoes.includes(vote.role) && !asRole(vote))
		.map((vote) => `${vote.reviewer} (${vote.role})`);
	return {
		approved: approvals >= policy.required && !vetoedBy.length && !awaiting.length,
		approvals,
		vetoedBy,
		awaiting,
		...(ungranted.length ? { ungranted } : {}),
	};
}

/** The votes that count. With a stamp key in the registry, only those GitHive stamped. */
export async function countedVotes(votesCast: VoteRecord[], stampKey: string | undefined) {
	if (!stampKey) return votesCast;
	const stamped = async (vote: VoteRecord) => verifyStamp(stampKey, stampPayload("vote", vote), vote.stamp);
	const checked = await Promise.all(votesCast.map(async (vote) => ((await stamped(vote)) ? vote : null)));
	return checked.filter((vote) => vote !== null);
}
