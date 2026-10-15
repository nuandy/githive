import { fail, statusOf } from "../../errors";
import { branchHead, type Remote } from "../../git";
import { projectBranch } from "../../project-branch";
import { presentClaim } from "../branch-scope";
import { type Challenges, challengesRef, openChallenge } from "../challenges";
import type { Abandoned, ClaimRecord, Registry } from "../claims";
import { trustedClaim } from "../github-settings";
import type { LandingView } from "../landing";
import { abandoned, type ChangeSigns, type Turn } from "../staleness";
import type { VoteStore } from "../vote-store";
import {
	approval,
	countedVotes,
	effectivePolicy,
	latestVotes,
	openFlag,
	type ReviewPolicy,
	type VoteRecord,
	type Votes,
} from "../votes";
import type { ToolContext } from "./context";
import { branchSettings, claimPolicy, hostedRoles, recordLog } from "./repo";

// Where a change stands: where its branch lives, its pushed head, its votes against the policy,
// and whether it has been abandoned.

/**
 * When forks became per agent. A change claimed since then has no fork of its own, so none is looked
 * for, which saves a failed lookup per unpushed change. The date leaves a day's margin for deploys.
 */
const FORKS_PER_AGENT_SINCE = "2026-10-08T00:00:00Z";

/**
 * Where a repo's change branches live: changes/<change> in the agent's own fork. A change claimed before
 * forks were per agent, or at an unknown time, may still be in a fork of its own.
 */
export function changeSourceFor(ctx: ToolContext, repo: string) {
	return async (agent: string, scope: "read" | "write", change?: string, since?: string): Promise<Remote> => {
		if (!ctx.changeRemote) fail(501, "change forks aren't available here");
		const legacy = !!change && !!ctx.legacyChangeRemote && !(since && since >= FORKS_PER_AGENT_SINCE);
		if (scope === "write" || !legacy) return ctx.changeRemote(repo, agent, scope);
		const fork = await ctx.changeRemote(repo, agent, "read").catch(() => null);
		if (fork && (await branchHead(fork, `changes/${change}`).catch(() => null))) return fork;
		return (
			(await ctx.legacyChangeRemote!(repo, change!).catch(() => null)) ?? fork ?? ctx.changeRemote(repo, agent, "read")
		);
	};
}

/**
 * A change's pushed head, or null if nothing is pushed. A change claimed since forks were per agent is read
 * with one Artifacts API call on its agent's fork, far cheaper than listing refs over Git.
 */
export async function changeHead(
	ctx: ToolContext,
	repo: string,
	agent: string,
	change: string,
	since?: string,
): Promise<string | null> {
	const ref = `changes/${change}`;
	if (ctx.forkHead && since && since >= FORKS_PER_AGENT_SINCE) return ctx.forkHead(repo, agent, ref);
	return branchHead(await changeSourceFor(ctx, repo)(agent, "read", change, since), ref);
}

/** What status says of GitHub's change while the repo trusts GitHub's changes. */
export const TRUSTED_NOTE =
	"GitHub's changes, brought back by githive-github: trusted, so it lands through the checks without review " +
	"(settings github_trust)";

/** Where a change stands: its head, the votes on it, its approval under the policy, and its hosted agents. */
export async function changeStatus(...args: Parameters<typeof changeState>) {
	return (await changeState(...args)).status;
}

/**
 * Where a change stands, and the votes on its head that count (their stamps checked), for a caller that works out more
 * from them without checking every stamp again.
 */
export async function changeState(
	ctx: ToolContext,
	repo: string,
	registry: Registry | null | undefined,
	votesOn: (head: string) => Promise<VoteRecord[]>,
	change: string,
	author: ClaimRecord | undefined,
	agent = author?.agent,
) {
	// No fork (or no branch on it) means nothing pushed yet.
	const head = await Promise.resolve()
		.then(() => changeHead(ctx, repo, agent ?? fail(409, `${change} has no agent`), change, author?.since))
		.catch(() => null);
	// Note the fresh head for reviews, backlog and merge (see openHeads).
	if (head) await ctx.noteHeads?.(repo, { [change]: head }).catch(() => undefined);
	// The claimed paths can escalate the policy (stricter for CI or deploy files, for example).
	const paths = author?.paths ?? [];
	// The branch it lands on decides the policy too (see branch-rules.ts); GitHub's change, while trusted, needs none.
	const policy = author ? claimPolicy(registry, author) : branchSettings(registry, undefined).policy;
	const { required, vetoes } = effectivePolicy(policy, paths);
	const votesCast = head ? (await votesOn(head)).filter((vote) => vote.commit === head) : [];
	const counted = head ? await countedVotes(votesCast, registry?.stampKey) : [];
	const outcome = head
		? approval({ votes: counted }, head, policy, author, paths)
		: { approved: false, approvals: 0, vetoedBy: [], awaiting: vetoes };
	const hosted = ctx.agentStatus
		? await ctx.agentStatus(repo, change, head, hostedRoles(vetoes)).catch(() => undefined)
		: undefined;
	// GitHub's change says why it needs no review.
	const trusted = author && trustedClaim(registry, author) ? { trusted: TRUSTED_NOTE } : {};
	const status = {
		head,
		votes: votesCast,
		approval: { ...outcome, required },
		...trusted,
		...(hosted ? { hosted } : {}),
	};
	return { status, counted };
}

/**
 * The signs of whose turn a change is on: its head, the counted votes on it (stamps already checked),
 * any open question for a person, and whether it's in the batch being landed.
 */
export function changeSigns(input: {
	claim: ClaimRecord;
	head: string | null;
	counted: VoteRecord[];
	record: Pick<Votes, "votes" | "flags">;
	landing?: Pick<LandingView, "checking"> | null;
	policy: ReviewPolicy;
	/** The repo's challenges, for one open on this claim (see challenges.ts). */
	challenges?: Challenges | undefined;
}): ChangeSigns {
	const { claim, head } = input;
	const challenge = openChallenge(input.challenges, claim);
	const onHead = head ? latestVotes(input.counted.filter((v) => v.commit === head)) : [];
	const counted = onHead.filter((v) => v.reviewer !== claim.agent);
	const author = { agent: claim.agent, ...(claim.by ? { by: claim.by } : {}) };
	// The author's own approval counts as the policy says (a lone agent's own review), so it's judged with them all.
	const outcome = head ? approval({ votes: onHead }, head, input.policy, author, claim.paths) : undefined;
	const batched = input.landing?.checking?.changes.some(
		(landing) => landing.change === claim.change && landing.head === head,
	);
	return {
		active: claim.active,
		head,
		votes: counted.map((v) => ({ verdict: v.verdict, at: v.at })),
		approved: !!outcome?.approved,
		vetoed: !!outcome?.vetoedBy.length,
		landing: !!head && !!batched,
		asked: !!openFlag(input.record, claim.change, head, outcome?.awaiting ?? []),
		...(challenge ? { challenged: challenge.at } : {}),
	};
}

/** The repo's challenges, or none when they can't be read: then no claim counts as challenged, so none is freed. */
export async function readChallenges(ctx: ToolContext, repo: string): Promise<Challenges | undefined> {
	const head = await recordLog<Challenges>(ctx, repo, challengesRef(repo))
		.read()
		.catch(() => null);
	return head?.commit.state;
}

/** The abandoned rule, also saying whose turn the claim's change is on: only its agent's can be challenged. */
export type Judge = (claim: ClaimRecord) => Promise<Awaited<ReturnType<Abandoned>> & { turn?: Turn }>;

/**
 * Decides whether a claim that's in the way, or asked to be released as stale, is abandoned.
 * Everything is read fresh, because a release can't be undone.
 */
export function abandonedRule(
	ctx: ToolContext,
	repo: string,
	registered: Registry | null | undefined,
	votes: VoteStore,
): Judge {
	// Read once for the rule, when it's first asked: most claims are never in anyone's way.
	let challenges: Promise<Challenges | undefined> | undefined;
	return async (claim) => {
		// A failed read isn't "nothing pushed", which could release live work. Only a missing fork (409),
		// or no forks at all (501), means nothing is pushed.
		const head = await changeHead(ctx, repo, claim.agent, claim.change, claim.since).catch((err): null | undefined =>
			[409, 501].includes(statusOf(err).status) ? null : undefined,
		);
		if (head === undefined) return { abandoned: false, why: `${claim.change}'s head couldn't be read just now` };
		const view = await votes.readFor(head ? [head] : []);
		const counted = head
			? await countedVotes(
					view.votes.filter((v) => v.commit === head),
					registered?.stampKey,
				)
			: [];
		const shown = presentClaim(claim, projectBranch(registered));
		const landing = await ctx
			.landing?.(repo, shown.into ?? projectBranch(registered))
			.view()
			.catch(() => null);
		const signs = changeSigns({
			claim: shown,
			head,
			counted,
			record: view,
			landing,
			policy: claimPolicy(registered, shown),
			challenges: await (challenges ??= readChallenges(ctx, repo)),
		});
		const outcome = abandoned(signs, Date.now());
		const challengedAt = outcome.abandoned ? signs.challenged : undefined;
		return {
			abandoned: outcome.abandoned,
			why: outcome.why,
			turn: outcome.waiting.turn,
			...(challengedAt ? { challengedAt } : {}),
		};
	};
}
