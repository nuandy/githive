import { fail, optionalString, requiredString } from "../../errors";
import { branchHead } from "../../git";
import type { GitHubLink } from "../../github";
import { actionsChecks, onActions } from "../actions-checks";
import { artifactsInspect } from "../batch-reads";
import { scopeFile } from "../branch-scope";
import type { ClaimRecord, Registry } from "../claims";
import { pushToGitHub } from "../github-outbound";
import { type GitHubSeen, githubSync } from "../github-settings";
import { type BatchGit, type Candidate, mergeChange, type MergeInput } from "../merge";
import { countedVotes } from "../votes";
import { holdKey, reviewersNeeded } from "../work";
import type { ToolCall, ToolContext, ToolHandlers } from "./context";
import { ownChangeCommands, reviewCommands } from "./git-commands";
import { mayActAs } from "./identity";
import { branchSettings } from "./repo";

// Tools for landing a change: merge, and credentials for a change's branch: your own to push to, or someone
// else's to review.

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
		if (holder && holder !== agentArg("agent")) fail(409, `${change} is ${holder}'s change: merge it as ${holder}`);
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
		// Batches land with trees in the Worker, or in the repo's Gate (a container running real git), which also does
		// the GitHub pushes. Changes are read through Artifacts' API here; the Gate reads only those it can't place.
		const gate = ctx.batchGit
			? ctx.batchGit(repo)
			: fail(503, "GitHive can't land changes here: no Gate is set up to land them");
		const inspect = ctx.history && artifactsInspect(ctx.history, repo, gate.inspect, ctx.placements?.(repo));
		const batchGit = inspect ? { ...gate, inspect } : gate;
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
	async credentials(call) {
		const { args, ctx, repo, acting, changeOf } = call;
		if (typeof args.change !== "string" || !args.change.trim()) {
			const remote = await ctx.remote(repo, "read");
			return {
				url: remote.url,
				token: remote.token,
				note:
					"read-only: the project repo is written only through the toolkit. Ask with your change for " +
					"write access to its fork.",
			};
		}
		const change = requiredString(args, "change");
		const { claim: held, released } = await changeOf(change);
		const named = optionalString(args, "agent");
		const caller = acting ?? named;
		// Your own change gets write access to your fork; anyone else's, read-only access to review it.
		if (held && (caller === undefined || caller === held.agent)) return ownChangeAccess(call, change, held);
		const author = held?.agent ?? released.at(-1)?.agent;
		if (!author) fail(404, `no change ${change} on ${repo}`);
		return reviewAccess(call, change, author, held, caller);
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
	if (ctx.prefetchChange) optional.prefetch = (change) => ctx.prefetchChange!(repo, into, change);
	if (ctx.prepareChecks && !at.checksOnActions) optional.prepareChecks = ctx.prepareChecks(repo);
	// Push the landed branch to GitHub as a fast-forward (its main, or githive/main for the pull request), refused if
	// someone pushed there directly, then notice whether GitHub's branch holds what main lacks.
	const sync = githubSync(registered);
	if (link && sync && into === branch) {
		const github = ctx.githubSync?.(repo);
		optional.afterLanding = (commit: string) =>
			pushToGitHub({
				gate,
				link,
				sync,
				branch: into,
				commit,
				...(github ? { notice: (seen: GitHubSeen) => github.notice(seen) } : {}),
			});
	}
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

/** Write access to the agent's own fork for its change, and read access to the project it starts from. */
async function ownChangeAccess(call: ToolCall, change: string, own: ClaimRecord) {
	const { ctx, repo, registered, acting, branch, changeSource } = call;
	mayActAs(own.agent, acting, registered, ctx.hosted);
	// One fork serves all the agent's changes. Its default branch may lag the project's, so a new change starts
	// from the project's branch, fetched into a clone of the fork with the read access `project` gives.
	const [remote, project] = await Promise.all([changeSource(own.agent, "write"), ctx.remote(repo, "read")]);
	const into = own.into ?? branch;
	const elsewhere = into !== branch ? `: this change lands on ${into}, not ${branch}` : "";
	return {
		url: remote.url,
		token: remote.token,
		branch: `changes/${change}`,
		project: { url: project.url, token: project.token, branch: into },
		...(into !== branch ? { into } : {}),
		git: ownChangeCommands({ project, fork: remote, into, change }),
		note:
			`Your own fork, for all your changes: push this change's branch changes/${change} to it. Clone the ` +
			`fork, then start the branch from the project's ${into} (project), fetched on top: the fork's own ` +
			`copy may be behind${elsewhere}.`,
	};
}

/**
 * Read-only access to another agent's change, to review it, and to the project to diff against. It takes the
 * reviewer's place among the change's reviewers first, on the head GitHive already knows, while the slower reads
 * run; when as many others already review it as it needs, it refuses, so agents whose list of reviews was a few
 * seconds old don't all review the same change. The place moves to the head read if that differs.
 */
async function reviewAccess(
	call: ToolCall,
	change: string,
	author: string,
	held: ClaimRecord | undefined,
	reviewer?: string,
) {
	const { args, ctx, repo, branch, changeSource } = call;
	const role = optionalString(args, "role") ?? "review";
	// A released change can't land, so reading it takes no reviewer's place.
	const take = async (head: string) => {
		if (held && reviewer) await takeReview(call, held, head, role, reviewer);
	};
	const known = ctx.knownHeads
		? await ctx.knownHeads(repo, [{ change, agent: author }]).catch(() => undefined)
		: undefined;
	const knownHead = known?.[change]?.head ?? undefined;
	const taking = knownHead ? take(knownHead) : undefined;
	const [fork, project] = await Promise.all([
		changeSource(author, "read", change, held?.since),
		ctx.remote(repo, "read"),
		taking,
	]);
	const head = await branchHead(fork, `changes/${change}`).catch(() => null);
	if (!head) fail(409, `${change} has nothing pushed to review yet`);
	if (head !== knownHead) await take(head);
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
		git: reviewCommands({ project, fork, into, change, head }),
		note: "read-only: review this commit, then vote on it. Others aren't offered this review while you hold it.",
	};
}

/**
 * Takes `reviewer`'s place among the reviewers `head` still needs in `role`, by compare-and-swap, or refuses when
 * that many others already hold it. A hold that can't be written (the record busy) doesn't stop the review.
 */
async function takeReview(call: ToolCall, claim: ClaimRecord, head: string, role: string, reviewer: string) {
	const { ctx, repo, registered, votes } = call;
	if (!ctx.reviews) return;
	const policy = branchSettings(registered, claim.into).policy;
	const cast = (await votes.readFor([head])).votes.filter((vote) => vote.commit === head);
	const counted = await countedVotes(cast, registered?.stampKey);
	const needed = reviewersNeeded(policy, claim, head, counted, role);
	const short = head.slice(0, 8);
	const reviews = role === "review" ? "reviews" : `${role} reviews`;
	if (needed <= 0) fail(409, `${claim.change} needs no more ${reviews} at ${short}: take another from reviews`);
	const key = holdKey(head, role);
	const taken = await ctx.reviews.hold(repo, key, reviewer, needed).catch(() => true);
	if (taken) return;
	const held: Record<string, string[]> = await ctx.reviews.held(repo, [head]).catch(() => ({}));
	const holders = held[key] ?? [];
	const others = holders.filter((holder) => holder !== reviewer).join(", ") || "others";
	fail(409, `${claim.change} is already being reviewed by ${others} (${role}, ${short}): take another from reviews`);
}
