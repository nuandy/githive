import { changeId, normalizeClaim } from "../../claim-paths";
import { requiredPaths, requiredString } from "../../errors";
import { isReservedPath, presentClaim, scopePaths } from "../branch-scope";
import { abandonedRule } from "./change-state";
import { branchMerge, changeList, dependencyLoop, targetBranch } from "./claim-input";
import type { ToolHandlers } from "./context";
import { containerChecks, shardIfBusy, STALE_AFTER_MS, storeFor } from "./repo";

// Tools for claims: claim, release, claims, and build (a claim worked by GitHive's hosted builder).

export const claimTools: ToolHandlers = {
	async claims({ adviceView }) {
		return (await adviceView()).claims;
	},
	async claim({
		args,
		ctx,
		repo,
		claims,
		votes,
		registered,
		actAs,
		stamper,
		store,
		branch,
		claimOf,
		changeSource,
		warmChecks,
	}) {
		const change = requiredString(args, "change");
		const agent = actAs("agent");
		// With `source`, the change merges a whole branch, claiming what it changed (see branchMerge).
		const source = typeof args.source === "string" && args.source.trim() ? args.source.trim() : undefined;
		const given = source ? [] : normalizeClaim(requiredPaths(args, "paths"));
		const reserved = given.find(isReservedPath);
		if (reserved) throw new Error(`[400] ${reserved}: a path can't start with "::"`);
		// A change lands on one branch: claiming again keeps it there, and naming another is refused.
		const held = await claimOf(change);
		const asked = typeof args.into === "string" && args.into.trim() ? args.into.trim() : undefined;
		const into = asked ?? held?.into ?? branch;
		if (held && (held.into ?? branch) !== into)
			throw new Error(
				`[409] ${change} lands on ${held.into ?? branch}: a change lands on one branch; claim another change for ${into}`,
			);
		const made =
			into === branch || held
				? undefined
				: await targetBranch(ctx, repo, {
						into,
						from: typeof args.from === "string" && args.from.trim() ? args.from.trim() : undefined,
						registered,
						claims,
						agent,
						stamper,
					});
		const merging = source ? await branchMerge(ctx, repo, source, into) : undefined;
		const paths = merging ? merging.paths : given;
		const after = changeList(args.after, "after");
		if (after.includes(change)) throw new Error(`[400] ${change} can't wait on itself`);
		// Refuse a dependency loop, which would leave every change in it waiting forever.
		const loop = after.length
			? await dependencyLoop(change, after, async (dep) => (await claimOf(dep))?.after ?? [])
			: undefined;
		if (loop) throw new Error(`[409] after ${loop.at(1)}, ${change} would wait on itself: ${loop.join(" waits on ")}`);
		const input = {
			change,
			agent,
			paths: scopePaths(paths, into, branch),
			intent: requiredString(args, "intent"),
			...(after.length ? { after } : {}),
			...(source ? { source } : {}),
			staleAfterMs: STALE_AFTER_MS,
			abandoned: abandonedRule(ctx, repo, registered, votes),
		};
		// If one record would hold agents up, shard first, then claim in the shards.
		const sharded = await shardIfBusy(ctx, repo, claims, registered, input.agent);
		const outcome = await (sharded ? storeFor(ctx, repo, sharded) : store).claim(input, stamper);
		// Report conflicting paths as agents wrote them, without the branch scoping.
		const conflicts = outcome.ok
			? undefined
			: outcome.conflicts.map((c) => ({
					...c,
					path: presentClaim({ paths: [c.path] }, branch).paths[0],
					held: presentClaim({ paths: [c.held] }, branch).paths[0],
				}));
		// Once claimed, the source's tip becomes the change's branch in the agent's fork.
		if (outcome.ok && merging) await merging.push(await changeSource(agent, "write"), change);
		// Without container checks, the Gate lands the change within minutes, so warm it from the claim. A cold
		// Gate holds up the first batch. With checks, a claim is too early to install for; they warm at the check.
		if (outcome.ok && !containerChecks(registered?.verify).length) await warmChecks("claimed", change);
		const merged = merging
			? {
					source,
					head: merging.tip,
					claimed: paths,
					note: `${change} merges ${source} at ${merging.tip.slice(0, 8)} into ${into}: its branch changes/${change} is that commit, in your fork. Get it reviewed, check and merge it like any change. If ${source} moves on, claim again to bring the change up to its new tip (a new head, so a new review).`,
				}
			: {};
		// A refused claim that couldn't be fully backed out still holds paths: releasing the change frees them.
		const stuck =
			!outcome.ok && outcome.stillHeld?.length
				? {
						note: `part of ${change}'s claim couldn't be undone and still holds paths (${outcome.stillHeld.length} record(s)): release ${change} to free them`,
					}
				: {};
		return {
			...outcome,
			...(conflicts ? { conflicts } : {}),
			...(into !== branch ? { into } : {}),
			...(made ? { branch: made } : {}),
			...merged,
			...stuck,
		};
	},
	async release({ args, ctx, repo, votes, registered, actAs, stamper, store, claimOf }) {
		const change = requiredString(args, "change");
		const agent = actAs("agent");
		// Only a claim's agent may release it; anyone else may release it only as stale, once abandoned.
		const held = args.stale === true ? null : await claimOf(change);
		if (held && held.agent !== agent)
			throw new Error(
				`[403] ${change} is ${held.agent}'s claim: only its agent releases it, or anyone once it's abandoned (release with stale: true)`,
			);
		if (args.stale === true)
			return store.releaseStale(
				{ change, agent, staleAfterMs: STALE_AFTER_MS, abandoned: abandonedRule(ctx, repo, registered, votes) },
				stamper,
			);
		return store.release(
			{ change, agent, reason: typeof args.reason === "string" ? args.reason : "released" },
			stamper,
		);
	},
	async build({ args, ctx, repo, votes, registered, stamper, store }) {
		if (!ctx.startBuilder) throw new Error("[501] hosted builders aren't available here");
		if (ctx.mayUseHosted && !(await ctx.mayUseHosted()))
			throw new Error("[403] GitHive's hosted agents are by invitation: ask an admin to add you");
		const intent = requiredString(args, "intent");
		const change = changeId(intent);
		const claimed = await store.claim(
			{
				change,
				agent: "githive-builder",
				paths: normalizeClaim(requiredPaths(args, "paths")),
				intent,
				staleAfterMs: STALE_AFTER_MS,
				abandoned: abandonedRule(ctx, repo, registered, votes),
			},
			stamper,
		);
		if (!claimed.ok) return claimed;
		return ctx.startBuilder({ repo, change });
	},
};
