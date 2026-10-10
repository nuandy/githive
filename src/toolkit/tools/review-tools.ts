import { requiredString } from "../../errors";
import { branchHead } from "../../git";
import { effectivePolicy } from "../votes";
import { holdKey } from "../work";
import type { ToolHandlers } from "./context";
import { branchSettings, hostedRoles, shardVotesIfBusy, votesFor } from "./repo";

// Tools for reviewing: vote, review_access, request_review, and ask_human.

export const reviewTools: ToolHandlers = {
	async vote({ args, ctx, repo, registered, actAs, stamper, warmChecks }) {
		const verdict = requiredString(args, "verdict");
		if (verdict !== "approve" && verdict !== "reject") throw new Error("[400] verdict is approve or reject");
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
		// The review is done, so drop the hold review_access placed.
		await ctx.reviews?.release(repo, holdKey(commit, requiredString(args, "role")), reviewer).catch(() => undefined);
		if (verdict === "approve") await warmChecks("approved", commit);
		return outcome;
	},
	async review_access({ args, ctx, repo, acting, branch, changeOf, claimOf, changeSource }) {
		// Anyone may review, with read-only access to the change's branch in its author's fork.
		const change = requiredString(args, "change");
		const { claim: held, released } = await changeOf(change);
		const author = held?.agent ?? released.at(-1)?.agent;
		if (!author) throw new Error(`[404] no change ${change} on ${repo}`);
		const [fork, project] = await Promise.all([
			changeSource(author, "read", change, held?.since),
			ctx.remote(repo, "read"),
		]);
		const head = await branchHead(fork, `changes/${change}`).catch(() => null);
		if (!head) throw new Error(`[409] ${change} has nothing pushed to review yet`);
		// Agent names only: a person's identity stays in the records, out of logs.
		console.log(`review access to ${repo} ${change} (${author}) for ${acting ?? "an unregistered caller"}`);
		const into = (await claimOf(change))?.into ?? branch;
		// Mark this commit and role as under review, so others see it taken. The mark binds nobody
		// and goes when the reviewer votes, or after 15 minutes.
		const role = typeof args.role === "string" && args.role.trim() ? args.role.trim() : "review";
		const reviewer = acting ?? (typeof args.agent === "string" ? args.agent : undefined);
		if (reviewer)
			await ctx.reviews?.hold(repo, holdKey(head, role), reviewer, Number.POSITIVE_INFINITY).catch(() => undefined);
		return {
			change,
			author,
			url: fork.url,
			token: fork.token,
			branch: `changes/${change}`,
			head,
			role,
			project: { url: project.url, token: project.token, branch: into },
			...(into !== branch ? { into } : {}),
		};
	},
	async request_review({ args, ctx, repo, registered, claimOf }) {
		if (ctx.mayUseHosted && !(await ctx.mayUseHosted()))
			throw new Error("[403] GitHive's hosted agents are by invitation: ask an admin to add you");
		const change = requiredString(args, "change");
		const registry = registered;
		const claim = await claimOf(change);
		if (!claim) throw new Error(`[409] ${change} holds no claim: claim the change's paths first`);
		if (!ctx.requestReview) throw new Error("[501] hosted reviewers aren't available here");
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
		if (!(await claimOf(change))) throw new Error(`[409] ${change} holds no claim`);
		return votes.flag({ change, agent: actAs("agent"), reason: requiredString(args, "reason") }, stamper);
	},
};
