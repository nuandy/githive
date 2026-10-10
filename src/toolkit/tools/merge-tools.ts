import { fail, requiredString } from "../../errors";
import { actionsChecks, mirrorTo, onActions } from "../actions-checks";
import { artifactsInspect } from "../batch-reads";
import { scopeFile } from "../branch-scope";
import { checkChange } from "../check";
import { lastLandedOn } from "../landing";
import { type Candidate, mergeChange } from "../merge";
import type { ToolHandlers } from "./context";
import { mayActAs } from "./identity";
import { branchSettings } from "./repo";

// Tools for landing a change: check, merge, and credentials for pushing to a fork.

export const mergeTools: ToolHandlers = {
	async merge({
		args,
		ctx,
		repo,
		write,
		votes,
		registered,
		agentArg,
		stamper,
		store,
		branch,
		adviceView,
		claimOf,
		waitingOn,
		changeSource,
		openHeads,
	}) {
		// mergeChange reads the claims again itself, when it checks them.
		const registry = registered;
		// Anyone may merge a change whose conventions hold. It merges as its agent; the stamp says who asked.
		const change = requiredString(args, "change");
		const own = await claimOf(change);
		const holder = own?.agent;
		if (holder && holder !== agentArg("agent"))
			throw new Error(`[409] ${change} is ${holder}'s change: merge it as ${holder}`);
		// It lands on the branch its claim names, together with every other change ready there.
		const into = own?.into ?? branch;
		// Not before its dependencies have merged into that same branch.
		const waits = await waitingOn(own?.after ?? [], into);
		if (waits.length) return { ok: false, reasons: waits };
		// A repo connected to GitHub may run its checks on Actions, and gets main pushed back after each landing.
		const checksHere = branchSettings(registry, into).verify;
		const link =
			registry?.github && ctx.github
				? await ctx
						.github(registry.github.repo)
						.catch((err) => (console.error(`reaching ${registry.github!.repo} on GitHub failed`, String(err)), null))
				: null;
		if (onActions(checksHere) && !link)
			return {
				ok: false,
				reasons: [
					`checks run on GitHub Actions, but ${registry?.github ? `GitHive can't reach ${registry.github.repo}: is the GitHive app installed there?` : "no GitHub repo is connected (settings github)"}`,
				],
			};
		const project = await write();
		// The repo's Gate (a container running real git) lands every batch and does its GitHub pushes. Changes are
		// read through Artifacts' API here; the Gate reads only those it can't place (see artifactsInspect).
		const gate = ctx.batchGit
			? ctx.batchGit(repo)
			: fail(503, "GitHive can't land changes here: no Gate is set up to land them");
		const batchGit = ctx.history ? { ...gate, inspect: artifactsInspect(ctx.history, repo, gate.inspect) } : gate;
		return mergeChange({
			remote: project,
			branch: into,
			...(into !== branch ? { scope: (file: string) => scopeFile(file, into, branch) } : {}),
			store,
			votes,
			policy: branchSettings(registry, into).policy,
			verify: branchSettings(registry, into).verify,
			...(registry?.skipChecks ? { skipChecks: registry.skipChecks } : {}),
			runChecks: onActions(checksHere) && link ? actionsChecks(gate, link) : ctx.runChecks?.(repo),
			...(ctx.branchHead ? { branchHead: () => ctx.branchHead!(repo, into) } : {}),
			...(ctx.landing ? { landing: ctx.landing(repo, into) } : {}),
			batchGit,
			...(ctx.history ? { history: ctx.history } : {}),
			...(ctx.prepareLanding ? { prepareLanding: () => ctx.prepareLanding!(repo) } : {}),
			...(ctx.prepareChecks && !onActions(checksHere) ? { prepareChecks: ctx.prepareChecks(repo) } : {}),
			// Push the landed branch back to GitHub as a fast-forward, refused if someone pushed there directly.
			...(link && into === branch ? { afterLanding: (commit: string) => mirrorTo(gate, link, into, commit) } : {}),
			// Other changes ready for this branch, from the cached advice: claims in force whose dependencies
			// have merged. The batch checks each again before landing.
			others: async (): Promise<Candidate[]> => {
				const inForce = await adviceView();
				const merged = new Set(inForce.merged);
				const sameBranch = inForce.claims.filter(
					(c) => (c.into ?? branch) === into && c.change !== change && (c.after ?? []).every((dep) => merged.has(dep)),
				);
				const heads = await openHeads(inForce.claims);
				return sameBranch.map((claim) => ({
					claim,
					head: heads(claim),
					source: () => changeSource(claim.agent, "read", claim.change, claim.since),
				}));
			},
			stamper,
			stampKey: registry?.stampKey,
			source: await changeSource(holder ?? agentArg("agent"), "read", change, own?.since),
			change,
			agent: agentArg("agent"),
		});
	},
	async check({ args, ctx, repo, branch, claimOf, changeSource, warmChecks }) {
		const change = requiredString(args, "change");
		const own = await claimOf(change);
		const source = own ? await changeSource(own.agent, "read", change, own.since).catch(() => null) : null;
		if (!source) throw new Error(`[409] changes/${change} has nothing pushed to check`);
		const into = own?.into ?? branch;
		const checked = await checkChange({
			project: await ctx.remote(repo, "read"),
			branch: into,
			source,
			claims: own ? [own] : [],
			change,
			...(ctx.branchHead ? { branchHead: () => ctx.branchHead!(repo, into) } : {}),
			...(ctx.history ? { history: ctx.history } : {}),
		});
		// On a conflict, name who last changed each file, as the landing remembers it.
		const conflicting = checked.main.clean ? [] : (checked.main.conflicts ?? []);
		const causes =
			conflicting.length && ctx.landing
				? lastLandedOn(
						(
							await ctx
								.landing(repo, into)
								.view()
								.catch(() => null)
						)?.recent ?? [],
						conflicting,
					)
				: [];
		// Agents check after each push, so note this head for reviews, backlog and merge (see openHeads).
		await ctx.noteHeads?.(repo, { [change]: checked.head }).catch(() => undefined);
		// A merge is likely within minutes of a check, so warm the check container now.
		await warmChecks("checked", change);
		return causes.length ? { ...checked, causes } : checked;
	},
	async credentials({ args, ctx, repo, registered, acting, branch, claimOf, changeSource }) {
		if (typeof args.change !== "string" || !args.change.trim()) {
			const remote = await ctx.remote(repo, "read");
			return {
				url: remote.url,
				token: remote.token,
				note: "read-only: the project repo is written only through the toolkit. Ask with your change for write access to its fork.",
			};
		}
		const change = requiredString(args, "change");
		const own = await claimOf(change);
		if (!own) throw new Error(`[409] ${change} holds no claim: claim its paths first`);
		mayActAs(own.agent, acting, registered, ctx.hosted);
		// One fork serves all the agent's changes. Its default branch may lag the project's, so a new change
		// starts from the project's branch, which `project` gives read access to.
		const [remote, project] = await Promise.all([changeSource(own.agent, "write"), ctx.remote(repo, "read")]);
		const into = own.into ?? branch;
		return {
			url: remote.url,
			token: remote.token,
			branch: `changes/${change}`,
			project: { url: project.url, token: project.token, branch: into },
			...(into !== branch ? { into } : {}),
			note: `Your own fork, for all your changes: push this change's branch changes/${change} to it. Start the branch from the project's ${into} (project), not the fork's, which may be behind${into !== branch ? `: this change lands on ${into}, not ${branch}` : ""}.`,
		};
	},
};
