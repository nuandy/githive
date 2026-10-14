import { fail, optionalString, requiredString } from "../../errors";
import { questionHints, voteHints } from "../clef-hints";
import { effectivePolicy } from "../votes";
import { holds } from "./merge-tools";
import { holdKey } from "../work";
import type { ToolCall, ToolHandlers } from "./context";
import { agentsAtWorkIn, siblingsOf } from "./no-reviewer";
import { branchSettings, claimPolicy, hostedRoles, shardVotesIfBusy, votesFor } from "./repo";

// Tools for reviewing: vote, request_review, and ask_human. A reviewer gets a change's code from credentials.

// A change's own agent approves it only when no other agent of its owner works in the repo: one that does reviews it
// instead, with a fresh view. Where review must be independent its approval doesn't count anyway, so it isn't asked.
async function refuseOwnApprovalBesideSiblings(call: ToolCall, change: string, reviewer: string) {
	const held = await call.claimOf(change);
	if (!held || held.agent !== reviewer) return;
	if (claimPolicy(call.registered, held).independent) return;
	const siblings = siblingsOf(await agentsAtWorkIn(call), held);
	if (!siblings.length) return;
	const who = siblings.slice(0, 3).join(", ");
	fail(
		409,
		`${change} is your own change, and your owner's other agents work here too (${who}): ` +
			"your own approval counts only when none does",
		"one of them reviews it: they see it in `reviews`. Meanwhile, work or `wait`",
	);
}

// When GitHive's reviewers won't review a change, a refused review says who else can: another agent, the change's
// own in a fresh context when none may, or a person.
function askAPersonInstead(args: Record<string, unknown>) {
	const change = typeof args.change === "string" && args.change.trim() ? args.change.trim() : "<change>";
	return (
		"wait for another agent's review, or, when `status` says no other agent may, review it yourself in a fresh " +
		`context; or ask a person: \`ask_human\` with change ${change} and why puts it in their Inbox, where they ` +
		"can approve it"
	);
}

export const reviewTools: ToolHandlers = {
	async vote(call) {
		const { args, ctx, repo, registered, actAs, stamper, warmChecks } = call;
		const verdict = requiredString(args, "verdict");
		if (verdict !== "approve" && verdict !== "reject") fail(400, "verdict is approve or reject");
		const reviewer = actAs("reviewer");
		// If one record would hold reviewers up, shard the votes first.
		const commit = requiredString(args, "commit");
		const teams = (await ctx.teamsOf?.(repo)) ?? [];
		const change = optionalString(args, "change");
		const evidence = requiredString(args, "evidence");
		const role = requiredString(args, "role");
		if (verdict === "approve" && change) await refuseOwnApprovalBesideSiblings(call, change, reviewer);
		// A vote without a review taken first (credentials) still counts against the owner's limit.
		if (ctx.ownerLimits) {
			const counted = await holds({ ctx, repo }, commit, role, reviewer);
			const refused = counted ? null : await ctx.ownerLimits.take("review");
			if (refused) fail(403, refused);
		}
		const { vague, thin } = await voteHints(ctx, { verdict, evidence });
		const outcome = await votesFor(ctx, repo, await shardVotesIfBusy(ctx, repo, registered, reviewer)).vote(
			{
				commit,
				...(change ? { change } : {}),
				reviewer,
				role,
				verdict,
				evidence,
				...(thin ? { thin: true as const } : {}),
				...(teams.length ? { teams } : {}),
			},
			stamper,
		);
		// The review is done, so drop the hold credentials placed when the review began.
		await ctx.reviews?.release(repo, holdKey(commit, role), reviewer).catch(() => undefined);
		if (verdict === "approve") await warmChecks("approved", commit);
		// The vote counts either way; the reply only says its evidence may not do its job.
		if (vague) return { ...(outcome as Record<string, unknown>), vagueEvidence: true };
		if (thin) return { ...(outcome as Record<string, unknown>), thinEvidence: true };
		return outcome;
	},
	async request_review({ args, ctx, repo, registered, claimOf }) {
		if (ctx.mayUseHosted && !(await ctx.mayUseHosted()))
			fail(403, "GitHive's hosted agents are by invitation: ask an admin to add you", askAPersonInstead(args));
		const change = requiredString(args, "change");
		const registry = registered;
		const claim = await claimOf(change);
		if (!claim) fail(409, `${change} holds no claim: claim the change's paths first`);
		if (!ctx.requestReview) fail(501, "hosted reviewers aren't available here", askAPersonInstead(args));
		const policy = branchSettings(registry, claim.into).policy;
		// By default a general review, and every role that can veto a change to these paths.
		const roles =
			Array.isArray(args.roles) && args.roles.length
				? (args.roles as string[])
				: hostedRoles(effectivePolicy(policy, claim.paths).vetoes);
		return ctx.requestReview({
			repo,
			change,
			roles,
			...(typeof args.summary === "string" ? { summary: args.summary } : {}),
		});
	},
	async ask_human({ args, ctx, votes, actAs, stamper, claimOf }) {
		const change = requiredString(args, "change");
		if (!(await claimOf(change))) fail(409, `${change} holds no claim`);
		const agent = actAs("agent");
		const reason = requiredString(args, "reason");
		const urgency = await questionHints(ctx, reason);
		return votes.flag({ change, agent, reason, ...(urgency === undefined ? {} : { urgency }) }, stamper);
	},
};
