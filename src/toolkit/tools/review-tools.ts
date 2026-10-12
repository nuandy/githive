import { fail, optionalString, requiredString } from "../../errors";
import { questionHints, voteHints } from "../clef-hints";
import { effectivePolicy } from "../votes";
import { holdKey } from "../work";
import type { ToolHandlers } from "./context";
import { branchSettings, hostedRoles, shardVotesIfBusy, votesFor } from "./repo";

// Tools for reviewing: vote, request_review, and ask_human. A reviewer gets a change's code from credentials.

export const reviewTools: ToolHandlers = {
	async vote({ args, ctx, repo, registered, actAs, stamper, warmChecks }) {
		const verdict = requiredString(args, "verdict");
		if (verdict !== "approve" && verdict !== "reject") fail(400, "verdict is approve or reject");
		const reviewer = actAs("reviewer");
		// If one record would hold reviewers up, shard the votes first.
		const commit = requiredString(args, "commit");
		const teams = (await ctx.teamsOf?.(repo)) ?? [];
		const change = optionalString(args, "change");
		const evidence = requiredString(args, "evidence");
		const { vague } = await voteHints(ctx, { verdict, evidence });
		const outcome = await votesFor(ctx, repo, await shardVotesIfBusy(ctx, repo, registered, reviewer)).vote(
			{
				commit,
				...(change ? { change } : {}),
				reviewer,
				role: requiredString(args, "role"),
				verdict,
				evidence,
				...(teams.length ? { teams } : {}),
			},
			stamper,
		);
		// The review is done, so drop the hold credentials placed when the review began.
		await ctx.reviews?.release(repo, holdKey(commit, requiredString(args, "role")), reviewer).catch(() => undefined);
		if (verdict === "approve") await warmChecks("approved", commit);
		// The vote counts either way; the reply only says the author may not be able to act on it.
		return vague ? { ...(outcome as Record<string, unknown>), vagueEvidence: true } : outcome;
	},
	async request_review({ args, ctx, repo, registered, claimOf }) {
		if (ctx.mayUseHosted && !(await ctx.mayUseHosted()))
			fail(403, "GitHive's hosted agents are by invitation: ask an admin to add you");
		const change = requiredString(args, "change");
		const registry = registered;
		const claim = await claimOf(change);
		if (!claim) fail(409, `${change} holds no claim: claim the change's paths first`);
		if (!ctx.requestReview) fail(501, "hosted reviewers aren't available here");
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
