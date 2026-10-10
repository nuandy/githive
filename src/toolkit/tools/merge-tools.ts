import { fail, requiredString } from "../../errors";
import { actionsChecks, mirrorTo, onActions } from "../actions-checks";
import { artifactsInspect } from "../batch-reads";
import { scopeFile } from "../branch-scope";
import { checkChange } from "../check";
import { lastLandedOn } from "../landing";
import type { GitHubLink } from "../../github";
import type { ClaimRecord, Registry } from "../claims";
import { type BatchGit, type Candidate, mergeChange, type MergeInput } from "../merge";
import type { ToolCall, ToolContext, ToolHandlers } from "./context";
import { mayActAs } from "./identity";
import { branchSettings } from "./repo";

// Tools for landing a change: check, merge, and credentials for pushing to a fork.

export const mergeTools: ToolHandlers = {
	async merge(call) {
		const { args, ctx, repo, write, votes, registered, agentArg, stamper, store, branch } = call;
		const { claimOf, waitingOn, changeSource } = call;
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
		const settings = branchSettings(registry, into);
		const checksOnActions = onActions(settings.verify);
		const link = await githubLink(ctx, registry);
		if (checksOnActions && !link) {
			const why = registry?.github
				? `GitHive can't reach ${registry.github.repo}: is the GitHive app installed there?`
				: "no GitHub repo is connected (settings github)";
			return { ok: false, reasons: [`checks run on GitHub Actions, but ${why}`] };
		}
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
			store,
			votes,
			policy: settings.policy,
			verify: settings.verify,
			runChecks: checksOnActions && link ? actionsChecks(gate, link) : ctx.runChecks?.(repo),
			batchGit,
			...optionalMergeInput(call, { into, link, gate, checksOnActions }),
			others: () => otherCandidates(call, change, into),
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
		let causes: ReturnType<typeof lastLandedOn> = [];
		if (conflicting.length && ctx.landing) {
			const landing = await ctx
				.landing(repo, into)
				.view()
				.catch(() => null);
			causes = lastLandedOn(landing?.recent ?? [], conflicting);
		}
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
		const elsewhere = into !== branch ? `: this change lands on ${into}, not ${branch}` : "";
		return {
			url: remote.url,
			token: remote.token,
			branch: `changes/${change}`,
			project: { url: project.url, token: project.token, branch: into },
			...(into !== branch ? { into } : {}),
			note: `Your own fork, for all your changes: push this change's branch changes/${change} to it. Start the branch from the project's ${into} (project), not the fork's, which may be behind${elsewhere}.`,
		};
	},
};

// The connected GitHub repo, or null if there is none or it can't be reached.
async function githubLink(ctx: ToolContext, registry: Registry | undefined): Promise<GitHubLink | null> {
	if (!registry?.github || !ctx.github) return null;
	const repo = registry.github.repo;
	return ctx.github(repo).catch((err) => {
		console.error(`reaching ${repo} on GitHub failed`, String(err));
		return null;
	});
}

// The parts of a merge this context and branch provide: branch scoping, cached heads, the landing, early starts and
// pushing back to GitHub.
function optionalMergeInput(
	call: ToolCall,
	at: { into: string; link: GitHubLink | null; gate: BatchGit; checksOnActions: boolean },
): Partial<MergeInput> {
	const { ctx, repo, registered, branch } = call;
	const { into, link, gate } = at;
	const optional: Partial<MergeInput> = {};
	if (into !== branch) optional.scope = (file: string) => scopeFile(file, into, branch);
	if (registered?.skipChecks) optional.skipChecks = registered.skipChecks;
	if (ctx.branchHead) optional.branchHead = () => ctx.branchHead!(repo, into);
	if (ctx.landing) optional.landing = ctx.landing(repo, into);
	if (ctx.history) optional.history = ctx.history;
	if (ctx.prepareLanding) optional.prepareLanding = () => ctx.prepareLanding!(repo);
	if (ctx.prepareChecks && !at.checksOnActions) optional.prepareChecks = ctx.prepareChecks(repo);
	// Push the landed branch back to GitHub as a fast-forward, refused if someone pushed there directly.
	if (link && into === branch) optional.afterLanding = (commit: string) => mirrorTo(gate, link, into, commit);
	return optional;
}

// Other changes ready for this branch, from the cached advice: claims in force whose dependencies have merged. The
// batch checks each again before landing.
async function otherCandidates(call: ToolCall, change: string, into: string): Promise<Candidate[]> {
	const { adviceView, openHeads, changeSource, branch } = call;
	const inForce = await adviceView();
	const merged = new Set(inForce.merged);
	const ready = (claim: ClaimRecord) =>
		(claim.into ?? branch) === into &&
		claim.change !== change &&
		(claim.after ?? []).every((dependency) => merged.has(dependency));
	const sameBranch = inForce.claims.filter(ready);
	const heads = await openHeads(inForce.claims);
	return sameBranch.map((claim) => ({
		claim,
		head: heads(claim),
		source: () => changeSource(claim.agent, "read", claim.change, claim.since),
	}));
}
