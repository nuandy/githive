import { fail, statusOf } from "../../errors";
import { branchHead, type Remote } from "../../git";
import { projectBranch } from "../../project-branch";
import { presentClaim } from "../branch-scope";
import type { Abandoned, ClaimRecord, Registry } from "../claims";
import type { LandingView } from "../landing";
import { abandoned, type ChangeSigns } from "../staleness";
import type { VoteStore } from "../vote-store";
import {
	approval,
	countedVotes,
	effectivePolicy,
	openFlag,
	type ReviewPolicy,
	type VoteRecord,
	type Votes,
} from "../votes";
import type { ToolContext } from "./context";
import { branchSettings, hostedRoles } from "./repo";

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
		if (!ctx.changeRemote) throw new Error("[501] change forks aren't available here");
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

/** Where a change stands: its head, the votes on it, its approval under the policy, and its hosted agents. */
export async function changeStatus(
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
	// The branch it lands on decides the policy too (see branch-rules.ts).
	const policy = branchSettings(registry, author?.into).policy;
	const { required, vetoes } = effectivePolicy(policy, paths);
	const cast = head ? (await votesOn(head)).filter((v) => v.commit === head) : [];
	const outcome = head
		? approval({ votes: await countedVotes(cast, registry?.stampKey) }, head, policy, author, paths)
		: { approved: false, approvals: 0, vetoedBy: [], awaiting: vetoes };
	const hosted = ctx.agentStatus
		? await ctx.agentStatus(repo, change, head, hostedRoles(vetoes)).catch(() => undefined)
		: undefined;
	return { head, votes: cast, approval: { ...outcome, required }, ...(hosted ? { hosted } : {}) };
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
}): ChangeSigns {
	const { claim, head } = input;
	const counted = head ? input.counted.filter((v) => v.commit === head && v.reviewer !== claim.agent) : [];
	const outcome = head
		? approval(
				{ votes: counted },
				head,
				input.policy,
				{ agent: claim.agent, ...(claim.by ? { by: claim.by } : {}) },
				claim.paths,
			)
		: undefined;
	return {
		active: claim.active,
		head,
		votes: counted.map((v) => ({ verdict: v.verdict, at: v.at })),
		approved: !!outcome?.approved,
		vetoed: !!outcome?.vetoedBy.length,
		landing: !!head && !!input.landing?.checking?.changes.some((c) => c.change === claim.change && c.head === head),
		asked: !!openFlag(input.record, claim.change, head),
	};
}

/**
 * Decides whether a claim that's in the way, or asked to be released as stale, is abandoned.
 * Everything is read fresh, because a release can't be undone.
 */
export function abandonedRule(
	ctx: ToolContext,
	repo: string,
	registered: Registry | null | undefined,
	votes: VoteStore,
): Abandoned {
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
			policy: branchSettings(registered, shown.into).policy,
		});
		const outcome = abandoned(signs, Date.now());
		return { abandoned: outcome.abandoned, why: outcome.waiting.why };
	};
}
