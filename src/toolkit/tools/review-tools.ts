import { fail, requiredString } from "../../errors";
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
		const outcome = await votesFor(ctx, repo, await shardVotesIfBusy(ctx, repo, registered, reviewer)).vote(
			{
				commit,
				reviewer,
				role: requiredString(args, "role"),
				verdict,
				evidence: requiredString(args, "evidence"),
				...(teams.length ? { teams } : {}),
			},
			stamper,
		);
		// The review is done, so drop the hold credentials placed when the review began.
		await ctx.reviews?.release(repo, holdKey(commit, requiredString(args, "role")), reviewer).catch(() => undefined);
		if (verdict === "approve") await warmChecks("approved", commit);
		return outcome;
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
	async ask_human({ args, votes, actAs, stamper, claimOf }) {
		const change = requiredString(args, "change");
		if (!(await claimOf(change))) fail(409, `${change} holds no claim`);
		return votes.flag({ change, agent: actAs("agent"), reason: requiredString(args, "reason") }, stamper);
	},
};
