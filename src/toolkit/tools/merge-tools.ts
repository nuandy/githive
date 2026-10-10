import { fail, requiredString } from "../../errors";
import { actionsChecks, mirrorTo, onActions } from "../actions-checks";
import { artifactsInspect } from "../batch-reads";
import { scopeFile } from "../branch-scope";
import { checkChange } from "../check";
import type { ClaimRecord } from "../claims";
import { branchHead } from "../../git";
import { lastLandedOn } from "../landing";
import { holdKey } from "../work";
import { type Candidate, mergeChange } from "../merge";
import type { ToolCall, ToolHandlers } from "./context";
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
	async credentials(call) {
		const { args, ctx, repo, acting, changeOf } = call;
		if (typeof args.change !== "string" || !args.change.trim()) {
			const remote = await ctx.remote(repo, "read");
			return {
				url: remote.url,
				token: remote.token,
				note: "read-only: the project repo is written only through the toolkit. Ask with your change for write access to its fork.",
			};
		}
		const change = requiredString(args, "change");
		const { claim: held, released } = await changeOf(change);
		const named = typeof args.agent === "string" && args.agent.trim() ? args.agent.trim() : undefined;
		const caller = acting ?? named;
		// Your own change gets write access to your fork; anyone else's, read-only access to review it.
		if (held && (caller === undefined || caller === held.agent)) return ownChangeAccess(call, change, held);
		const author = held?.agent ?? released.at(-1)?.agent;
		if (!author) throw new Error(`[404] no change ${change} on ${repo}`);
		return reviewAccess(call, change, author, held, caller);
	},
};

/** Write access to the agent's own fork for its change, and read access to the project it starts from. */
async function ownChangeAccess(call: ToolCall, change: string, own: ClaimRecord) {
	const { ctx, repo, registered, acting, branch, changeSource } = call;
	mayActAs(own.agent, acting, registered, ctx.hosted);
	// One fork serves all the agent's changes. Its default branch may lag the project's, so a new change
	// starts from the project's branch, which `project` gives read access to.
	const [remote, project] = await Promise.all([changeSource(own.agent, "write"), ctx.remote(repo, "read")]);
	const into = own.into ?? branch;
	const elsewhere = into !== branch ? `: this change lands on ${into}, not ${branch}` : "";
	return {
		url: remote.url,
		token: remote.token,
		branch: `changes/${change}`,
		project: { url: project.url, token: project.token, branch: into },
		...(into !== branch ? { into } : {}),
		note: `Your own fork, for all your changes: push this change's branch changes/${change} to it. Start the branch from the project's ${into} (project), not the fork's, which may be behind${elsewhere}.`,
	};
}

/**
 * Read-only access to another agent's change, to review it, and to the project to diff against. It marks the
 * change as under review before reading anything, on the head GitHive already knows, so others aren't offered
 * the same review while the slower reads run; the mark moves to the head read if that differs.
 */
async function reviewAccess(
	call: ToolCall,
	change: string,
	author: string,
	held: ClaimRecord | undefined,
	reviewer?: string,
) {
	const { args, ctx, repo, branch, changeSource } = call;
	const role = typeof args.role === "string" && args.role.trim() ? args.role.trim() : "review";
	const hold = (head: string) =>
		reviewer
			? ctx.reviews?.hold(repo, holdKey(head, role), reviewer, Number.POSITIVE_INFINITY).catch(() => undefined)
			: undefined;
	const known = ctx.knownHeads
		? await ctx.knownHeads(repo, [{ change, agent: author }]).catch(() => undefined)
		: undefined;
	const knownHead = known?.[change]?.head ?? undefined;
	const holding = knownHead ? hold(knownHead) : undefined;
	const [fork, project] = await Promise.all([
		changeSource(author, "read", change, held?.since),
		ctx.remote(repo, "read"),
	]);
	const head = await branchHead(fork, `changes/${change}`).catch(() => null);
	await holding;
	if (!head) throw new Error(`[409] ${change} has nothing pushed to review yet`);
	if (head !== knownHead) await hold(head);
	// Agent names only: a person's identity stays in the records, out of logs.
	console.log(`review access to ${repo} ${change} (${author}) for ${reviewer ?? "an unregistered caller"}`);
	const into = held?.into ?? branch;
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
		note: "read-only: review this commit, then vote on it. Others aren't offered this review while you hold it.",
	};
}
