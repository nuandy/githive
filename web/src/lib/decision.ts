import type { ChangeAwareness, MergeCheck, RepoLanding, RepoSnapshot } from "../api";
import { entriesOverlap } from "../../../src/claim-paths";
import { settingsForBranch } from "../../../src/toolkit/branch-rules";
import { identityName } from "./agent";
import { openOverlaps } from "./awareness";
import { batchLimit } from "./batchSize";
import { type Claim, isFromGitHub, type Vote } from "./claimStatus";
import { changeState, rejectionsOnHead, type StateContext } from "./status";

// What the decision box on a change's page works out, from the claim, the votes on its head, the repo's policy, the
// landing and the change's last merge check: who approved as each role it needs, its latest check, whether it
// conflicts with its branch, what lands with it, and the one thing the reader can do next. The server decides all of
// it again when anyone acts; these only say where things stand.

type Policy = RepoSnapshot["policy"];
/** Who is reading: a person's identity in the records and their teams in the repo's org, where the server says. */
export interface Reader {
	by?: string | undefined;
	teams?: string[] | undefined;
}

/** The branch a change lands on. */
export const branchOf = (claim: Pick<Claim, "into">, snapshot: Pick<RepoSnapshot, "branch">) =>
	claim.into ?? snapshot.branch ?? "main";

/** The review policy and checks of a branch: the repo's, or its branch rule's (see the server's branch-rules.ts). */
export function branchSettings(
	snapshot: Pick<RepoSnapshot, "policy" | "verify" | "branchRules" | "branch">,
	branch: string,
): { policy: Policy; verify: string[] } {
	return settingsForBranch(
		{
			policy: snapshot.policy,
			verify: snapshot.verify,
			rules: snapshot.branchRules,
			project: snapshot.branch ?? "main",
		},
		branch,
	);
}

/** The checks a change on `branch` runs before it lands. */
export const checksFor = (snapshot: Parameters<typeof branchSettings>[0], branch: string) =>
	branchSettings(snapshot, branch).verify;

/** The roles that can block a change on these paths: the policy's, and those of each escalation its paths touch. */
export function blockingRolesFor(policy: Policy, paths: string[]): string[] {
	const escalated = (policy.escalate ?? []).filter((rule) =>
		paths.some((path) => rule.paths.some((entry) => entriesOverlap(path, entry))),
	);
	return [...new Set([...policy.vetoes, ...escalated.flatMap((rule) => rule.vetoes ?? [])])];
}

/** Each reviewer's latest vote on the change's head, its agent's and the checks' left out, oldest first. */
function latestOnHead(claim: Claim, votes: Vote[]): Vote[] {
	if (!claim.head) return [];
	const latest = new Map<string, Vote>();
	const onHead = votes.filter((vote) => vote.commit === claim.head && vote.reviewer !== claim.agent);
	for (const vote of [...onHead].sort((a, b) => a.at.localeCompare(b.at)))
		if (vote.role !== "checks" && vote.reviewer !== CHECKS) latest.set(vote.by ?? vote.reviewer, vote);
	return [...latest.values()];
}

/** GitHive's checks, which reject a head whose checks failed. */
const CHECKS = "githive-checks";

/** One role a change needs, on its head: review's count of approvals, or a blocking role's sign-off. */
export interface RoleLine {
	role: string;
	/** Approvals review needs; one, from someone granted it, for a blocking role. */
	needed: number;
	approvals: number;
	/** Who approved: for review every approval that counts, for a blocking role those who approved as it. */
	approvedBy: string[];
	/** Who blocked it as this role. */
	blockedBy: string[];
	done: boolean;
	/** GitHive's reviewer for the role is at work on it. */
	working?: true;
	/** GitHive's reviewer for the role gave this verdict, though no vote as the role counts yet. */
	hosted?: "approve" | "reject";
}

/** Who approved as each role the change needs, review first. GitHub's trusted changes need none. */
export function roleLines(claim: Claim, votes: Vote[], policy: Policy): RoleLine[] {
	if (claim.trusted) return [];
	const latest = latestOnHead(claim, votes);
	const approving = latest.filter((vote) => vote.verdict === "approve");
	const { approvals, required, vetoedBy } = claim.approval;
	const lines: RoleLine[] = [];
	if (required > 0)
		lines.push({
			role: "review",
			needed: required,
			approvals,
			approvedBy: approving.map((vote) => vote.reviewer),
			blockedBy: [],
			done: approvals >= required,
		});
	const awaiting = claim.approval.awaiting;
	const roles = [...new Set([...blockingRolesFor(policy, claim.paths), ...(awaiting ?? [])])];
	for (const role of roles) {
		const approvedBy = approving.filter((vote) => vote.role === role).map((vote) => vote.reviewer);
		const blockedBy = latest
			.filter((vote) => vote.role === role && vote.verdict === "reject" && vetoedBy.includes(vote.reviewer))
			.map((vote) => vote.reviewer);
		// The server says which roles still wait; older servers don't, so an approval as the role is taken for it.
		const done = !blockedBy.length && (awaiting ? !awaiting.includes(role) : approvedBy.length > 0);
		const reviewer = claim.hosted?.reviewers.find((each) => each.role === role);
		const working = !!reviewer && !reviewer.verdict && reviewer.status !== "done";
		const said = reviewer?.verdict === "approve" || reviewer?.verdict === "reject" ? reviewer.verdict : undefined;
		const settled = done || blockedBy.length > 0;
		lines.push({
			role,
			needed: 1,
			approvals: approvedBy.length,
			approvedBy,
			blockedBy,
			done,
			...(working && !settled ? { working: true as const } : {}),
			...(said && !settled && !approvedBy.length ? { hosted: said } : {}),
		});
	}
	return lines;
}

/** A name for who voted, to the reader: "you" for themselves, an agent by its name, never a person's hash. */
export function voterName(identity: string, reader: Reader = {}): string {
	if (reader.by && identity === reader.by) return "you";
	if (/^person:[^/]+$/.test(identity)) return "a person";
	return identityName(identity) ?? identity;
}

/** A role's line in words, after its name: "githive-guard ✓", "1 of 2 · robin/reviewer", "blocked by …". */
export function roleSaying(line: RoleLine, reader: Reader = {}): { text: string; mark: "✓" | "×" | null } {
	const names = (identities: string[]) => identities.map((identity) => voterName(identity, reader)).join(", ");
	if (line.blockedBy.length) return { text: `blocked by ${names(line.blockedBy)}`, mark: "×" };
	if (line.role === "review" && !line.done) {
		const count = `${line.approvals} of ${line.needed}`;
		return { text: line.approvedBy.length ? `${count} · ${names(line.approvedBy)}` : count, mark: null };
	}
	if (line.done) return { text: names(line.approvedBy) || `${line.approvals} of ${line.needed}`, mark: "✓" };
	if (line.hosted === "reject") return { text: "GitHive's reviewer asked for changes", mark: "×" };
	if (line.hosted === "approve") return { text: "GitHive's reviewer approved", mark: "✓" };
	return { text: line.working ? "GitHive's reviewer is at work" : "waiting", mark: null };
}

/** The latest result of the checks on the change's head. */
export type CheckResult =
	| { kind: "running"; since: string }
	| { kind: "failed"; evidence: string; at: string }
	| { kind: "passed"; evidence?: string; at: string }
	| { kind: "none" };

/**
 * The checks on the change's head: running while it's in the batch being checked, else the newest result for its head,
 * from the checks' vote (a failed batch rejects the head) or the landing's recent outcomes. An earlier push's result
 * says nothing of this one.
 */
export function latestCheck(claim: Claim, votes: Vote[], landing: RepoLanding | undefined): CheckResult {
	const head = claim.head;
	if (!head) return { kind: "none" };
	const checking = landing?.checking;
	if (checking?.changes.some((each) => each.change === claim.change && each.head === head))
		return { kind: "running", since: checking.since };
	const results: (CheckResult & { at: string })[] = [
		...votes
			.filter((vote) => vote.commit === head && (vote.reviewer === CHECKS || vote.role === "checks"))
			.map((vote) =>
				vote.verdict === "reject"
					? { kind: "failed" as const, evidence: vote.evidence, at: vote.at }
					: { kind: "passed" as const, evidence: vote.evidence, at: vote.at },
			),
		...(landing?.recent ?? [])
			.filter((outcome) => outcome.change === claim.change && outcome.head === head)
			.map((outcome) =>
				outcome.how === "failed"
					? { kind: "failed" as const, evidence: (outcome.reasons ?? ["its checks failed"]).join("; "), at: outcome.at }
					: { kind: "passed" as const, at: outcome.at },
			),
	];
	return results.sort((a, b) => b.at.localeCompare(a.at))[0] ?? { kind: "none" };
}

/** Whether the change conflicts with its branch, as its last merge check found on its head. */
export type ConflictState =
	| { kind: "conflicts"; into: string; files: string[] }
	| { kind: "clean"; into: string }
	/** Not checked, or checked on an earlier push. */
	| { kind: "unknown"; into: string };

export function conflictOf(claim: Pick<Claim, "head" | "into">, merge: MergeCheck | undefined): ConflictState {
	const into = merge?.into ?? claim.into ?? "main";
	// A check that doesn't say which push it was of counts (older servers).
	if (!merge || (merge.head && claim.head && merge.head !== claim.head)) return { kind: "unknown", into };
	if (!merge.clean && merge.conflicts?.length) return { kind: "conflicts", into, files: merge.conflicts };
	return { kind: "clean", into };
}

/** How many open changes the change's code meets, and how many more weren't listed. */
export function meetsCount(awareness: ChangeAwareness | undefined, claims: Claim[]): number {
	if (!awareness) return 0;
	const omitted = (awareness.omitted?.usedBy ?? 0) + (awareness.omitted?.alteredBy ?? 0);
	return openOverlaps(awareness.usedBy, claims).length + openOverlaps(awareness.alteredBy, claims).length + omitted;
}

/**
 * Whether a person may land the change now: approved (nothing on its head stands against it, no question waits, it
 * isn't being checked to land already), waiting on no other change, and its head not in conflict with its branch.
 */
export function landable(
	claim: Claim,
	votes: Vote[],
	context: Pick<StateContext, "landing" | "settings"> & { merge?: MergeCheck | undefined },
): boolean {
	if (claim.waitsOn?.length) return false;
	if (conflictOf(claim, context.merge).kind === "conflicts") return false;
	return changeState(claim, { votes, landing: context.landing, settings: context.settings }) === "approved";
}

/** The other changes that land with one, as the server would gather its batch now. */
export interface Batch {
	/** Those it takes, oldest claims first. */
	changes: string[];
	/** Those ready past its room, left for a later batch. */
	left: number;
	/** How many others a batch has room for now: its size (batchSize.ts), less this change. */
	room: number;
}

/**
 * The other changes that land with this one, as the server gathers a batch (src/toolkit/merge-batch.ts): on the same
 * branch, pushed, approved, nothing rejecting their heads, waiting on nothing, not GitHub's (left to their own merge),
 * not just landed at that head, and not in the batch being checked already; the oldest claims first, as many as the
 * batch has room for. The snapshot's votes are its latest, so this is the best guess the page can make; the server
 * decides as it lands.
 */
export function landsWith(
	claim: Claim,
	snapshot: Pick<RepoSnapshot, "claims" | "votes" | "branch">,
	landing: Pick<RepoLanding, "checking" | "recent"> | undefined,
	checks: string[],
): Batch {
	const branch = branchOf(claim, snapshot);
	const checking = new Set((landing?.checking?.changes ?? []).map((each) => each.change));
	const recent = landing?.recent ?? [];
	const landed = new Set(recent.filter((each) => each.how === "landed").map((each) => `${each.change} ${each.head}`));
	const ready = snapshot.claims
		.filter(
			(other) =>
				other.change !== claim.change &&
				branchOf(other, snapshot) === branch &&
				!!other.head &&
				!landed.has(`${other.change} ${other.head}`) &&
				!isFromGitHub(other) &&
				other.approval.approved &&
				!other.waitsOn?.length &&
				!checking.has(other.change) &&
				!rejectionsOnHead(other, snapshot.votes).length,
		)
		.sort((a, b) => a.since.localeCompare(b.since));
	const room = batchLimit(recent, checks) - 1;
	return {
		changes: ready.slice(0, room).map((each) => each.change),
		left: Math.max(0, ready.length - room),
		room,
	};
}

/** "a", "a and b", "a, b and c". */
export const listed = (items: string[]) =>
	items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/**
 * What lands with it, in words: "It lands with footer-links and product-reviews", "It lands on its own"; or, when more
 * are ready than the batch has room for, "It lands with up to 3 of the 5 other ready changes, the oldest first".
 */
export function batchWords(batch: Batch): string {
	if (!batch.changes.length) return "It lands on its own";
	if (!batch.left) return `It lands with ${listed(batch.changes)}`;
	const ready = batch.changes.length + batch.left;
	return `It lands with up to ${batch.room} of the ${ready} other ready changes, the oldest first`;
}

/** The confirm's question: "Land checkout-tax now? It lands with footer-links and product-reviews, after npm test." */
export function landQuestion(change: string, batch: Batch, checks: string[]): string {
	const after = checks.length ? `, after ${listed(checks)}.` : ", with no checks to run.";
	return `Land ${change} now? ${batchWords(batch)}${after}`;
}

/** The reader's own latest vote on the change's head, if they gave one. */
export function readerVote(claim: Claim, votes: Vote[], by: string | undefined): Vote | undefined {
	if (!by || !claim.head) return undefined;
	return votes
		.filter((vote) => vote.commit === claim.head && (vote.by === by || vote.reviewer === by))
		.sort((a, b) => b.at.localeCompare(a.at))[0];
}

export type PrimaryAction = "land" | "vote" | null;

/** The one thing to do next: land it when the reader can, else vote if they can and haven't, else nothing. */
export function primaryAction({
	landable,
	voter,
	voted,
}: {
	landable: boolean;
	voter: boolean;
	voted: boolean;
}): PrimaryAction {
	if (landable) return "land";
	if (voter && !voted) return "vote";
	return null;
}

/**
 * Whether the reader may vote as `role`, as the server's holdsRole decides it for a person: a role that blocks nothing
 * is anyone's who can review; a blocking role is theirs if it's granted to people ("person:*"), to them, or to one of
 * their teams. Null when it can't be told: the reader's identity or teams aren't known and a grant names some.
 */
export function mayVoteAs(policy: Policy, role: string, reader: Reader): boolean | null {
	if (!allBlockingRoles(policy).includes(role)) return true;
	const holders = policy.grants?.[role] ?? ["person:*", "githive"];
	if (holders.includes("person:*")) return true;
	let unknown = false;
	for (const holder of holders) {
		if (/^person:[^/]+$/.test(holder)) {
			if (!reader.by) unknown = true;
			else if (holder === reader.by) return true;
		} else if (holder.startsWith("@")) {
			if (!reader.teams) unknown = true;
			else if (reader.teams.includes(holder)) return true;
		}
	}
	return unknown ? null : false;
}

/** Every role that can block a change anywhere in the repo. */
const allBlockingRoles = (policy: Policy) => [
	...new Set([...policy.vetoes, ...(policy.escalate ?? []).flatMap((rule) => rule.vetoes ?? [])]),
];

/**
 * The roles the reader may vote as on this change: a general review, and each role that can block it. When every
 * one can be told, only those that are theirs (`exact`); else every one, each marked as theirs, not, or unknown.
 */
export function voteRoles(
	policy: Policy,
	claim: Pick<Claim, "paths" | "approval">,
	reader: Reader,
): { roles: { role: string; granted: boolean | null }[]; exact: boolean } {
	const roles = [...new Set(["review", ...blockingRolesFor(policy, claim.paths), ...(claim.approval.awaiting ?? [])])];
	const marked = roles.map((role) => ({ role, granted: mayVoteAs(policy, role, reader) }));
	const exact = marked.every((each) => each.granted !== null);
	return { roles: exact ? marked.filter((each) => each.granted) : marked, exact };
}

/**
 * The role a vote starts as: the first the change waits on that the reader may vote as (theirs, else perhaps theirs),
 * else the first offered.
 */
export function startingRole(
	roles: { role: string; granted: boolean | null }[],
	awaiting: string[] = [],
): string | undefined {
	const offered = (granted: boolean | null) =>
		awaiting.find((role) => roles.some((each) => each.role === role && each.granted === granted));
	return offered(true) ?? offered(null) ?? roles[0]?.role;
}

/** The roles the change waits on that the reader can't vote as, with who can. */
export function rolesBeyondReader(
	policy: Policy,
	claim: Pick<Claim, "approval">,
	reader: Reader,
): { role: string; holders: string[] }[] {
	return (claim.approval.awaiting ?? [])
		.filter((role) => mayVoteAs(policy, role, reader) === false)
		.map((role) => ({ role, holders: policy.grants?.[role] ?? [] }));
}

/** Who holds a role, in words: "people in @acme/payments", "any person", "you", an agent by its name. */
export function holdersWords(holders: string[], reader: Reader = {}): string {
	const words = holders.map((holder) => {
		if (holder === "person:*") return "any person";
		if (holder.startsWith("@")) return `people in ${holder}`;
		return voterName(holder, reader);
	});
	return listed([...new Set(words)]);
}
