import { changeId, normalizeClaim } from "../../claim-paths";
import { fail, requiredPaths, requiredString } from "../../errors";
import { isReservedPath, presentClaim, scopePaths } from "../branch-scope";
import { GITHUB_AGENT, GITHUB_CHANGE_PREFIX, isGitHubChange, isImportedBranch } from "../github-settings";
import { claimHints } from "../clef-hints";
import { abandonedRule } from "./change-state";
import { branchMerge, changeList, dependencyLoop, targetBranch } from "./claim-input";
import type { ClaimOutcome } from "../claim-store";
import { BUILDING_IDLE_MS } from "../staleness";
import type { Args, ToolCall, ToolHandlers } from "./context";
import { giveUpGitHubChange } from "./github-tools";
import { containerChecks, shardIfBusy, STALE_AFTER_MS, storeFor } from "./repo";

// Tools for claims: claim, release, claims, and build (a claim worked by GitHive's hosted builder).

// A string argument with its whitespace trimmed, or undefined if it's missing or blank.
const optionalString = (args: Args, field: string) =>
	typeof args[field] === "string" && args[field].trim() ? args[field].trim() : undefined;

export const claimTools: ToolHandlers = {
	async claims({ adviceView }) {
		return (await adviceView()).claims;
	},
	async claim(call) {
		const { args, ctx, repo, claims, votes, registered, actAs, stamper, store, branch, changeSource, warmChecks } =
			call;
		const change = requiredString(args, "change");
		const agent = actAs("agent");
		// With `source`, the change merges a whole branch, claiming what it changed (see branchMerge).
		const source = optionalString(args, "source");
		refuseGitHubBranches(args, agent);
		refuseGitHubChangeName(change, agent);
		const given = source ? [] : normalizeClaim(requiredPaths(args, "paths"));
		const reserved = given.find(isReservedPath);
		if (reserved) fail(400, `${reserved}: a path can't start with "::"`);
		const { into, made } = await landingBranch(call, change, agent);
		const merging = source ? await branchMerge(ctx, repo, source, into) : undefined;
		const paths = merging ? merging.paths : given;
		const after = changeList(args.after, "after");
		if (after.includes(change)) fail(400, `${change} can't wait on itself`);
		// Refuse a dependency loop, which would leave every change in it waiting forever.
		const afterOf = async (dependency: string) => (await call.claimOf(dependency))?.after ?? [];
		const loop = after.length ? await dependencyLoop(change, after, afterOf) : undefined;
		if (loop) fail(409, `after ${loop.at(1)}, ${change} would wait on itself: ${loop.join(" waits on ")}`);
		const intent = requiredString(args, "intent");
		const similar = await sameWorkAs(call, { change, agent, intent, paths });
		const input = {
			change,
			agent,
			paths: scopePaths(paths, into, branch),
			intent,
			...(after.length ? { after } : {}),
			...(source ? { source } : {}),
			staleAfterMs: STALE_AFTER_MS,
			abandoned: abandonedRule(ctx, repo, registered, votes),
		};
		// If one record would hold agents up, shard first, then claim in the shards.
		const sharded = await shardIfBusy(ctx, repo, claims, registered, input.agent);
		// Taken before the claim is written, so the claim's own time is no earlier (see claimReply's freeAfter).
		const claimedAt = Date.now();
		const outcome = await (sharded ? storeFor(ctx, repo, sharded) : store).claim(input, stamper);
		// Once claimed, the source's tip becomes the change's branch in the agent's fork.
		if (outcome.ok && merging) await merging.push(await changeSource(agent, "write"), change);
		// Without container checks, a Gate that lands batches does so within minutes, so warm it from the claim. A cold
		// Gate holds up the first batch. With checks, a claim is too early to install for; they warm at the check.
		if (outcome.ok && !containerChecks(registered?.verify).length) await warmChecks("claimed", change);
		const reply = claimReply(outcome, { change, into, branch, made, source, merging, paths, claimedAt });
		if (!outcome.ok) return reply;
		return similar ? { ...reply, similar } : reply;
	},
	async release({ args, ctx, repo, votes, registered, actAs, stamper, store, claimOf }) {
		const change = requiredString(args, "change");
		const agent = actAs("agent");
		const reason = typeof args.reason === "string" ? args.reason : "released";
		// Only a claim's agent may release it; anyone else may release it only as stale, once abandoned.
		const held = args.stale === true ? null : await claimOf(change);
		if (held && held.agent !== agent) {
			// GitHub's change, held by GitHive's own job, a repo admin may give up (see giveUpGitHubChange).
			const github = isGitHubChange(held);
			if (github && ctx.level === "admin")
				return giveUpGitHubChange(ctx, repo, { store, claim: held, who: agent, ...(stamper ? { stamper } : {}) });
			fail(
				403,
				`${change} is ${held.agent}'s claim: only its agent releases it, or anyone once it's ` +
					"abandoned (release with stale: true)" +
					(github ? "; GitHub's changes, also a repo admin, or a person who can write from the dashboard" : ""),
			);
		}
		if (args.stale === true)
			return store.releaseStale(
				{ change, agent, staleAfterMs: STALE_AFTER_MS, abandoned: abandonedRule(ctx, repo, registered, votes) },
				stamper,
			);
		return store.release({ change, agent, reason }, stamper);
	},
	async build({ args, ctx, repo, votes, registered, stamper, store }) {
		if (!ctx.startBuilder) fail(501, "hosted builders aren't available here");
		if (ctx.mayUseHosted && !(await ctx.mayUseHosted()))
			fail(403, "GitHive's hosted agents are by invitation: ask an admin to add you");
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

/**
 * An open change that may already do what a new claim's intent says, as Clef sees it: advice, since the claim still
 * goes ahead. Asked of a new claim only; claiming again renews what was asked about then.
 */
async function sameWorkAs(call: ToolCall, claim: { change: string; agent: string; intent: string; paths: string[] }) {
	const held = await call.claimOf(claim.change);
	if (held?.agent === claim.agent) return undefined;
	const open = (await call.adviceView()).claims.filter((other) => other.change !== claim.change);
	const comparable = open.map((other) => ({ id: other.change, intent: other.intent }));
	const same = await claimHints(call.ctx, claim, comparable);
	if (!same) return undefined;
	const match = open.find((other) => other.change === same.id);
	if (!match) return undefined;
	const intent = match.intent.split("\n")[0] ?? "";
	return { change: match.change, agent: match.agent, intent, likelihood: same.likelihood };
}

// GitHive's copies of GitHub's branches (github/<branch>) are written by the toolkit, forced at each import: no change
// lands on one or starts from one, and only githive-github merges one.
function refuseGitHubBranches(args: Args, agent: string) {
	for (const field of ["into", "from"]) {
		const named = optionalString(args, field);
		if (named && isImportedBranch(named))
			fail(
				403,
				`${named}: branches under github/ are GitHive's copies of GitHub's; no change lands on or starts from one`,
			);
	}
	const source = optionalString(args, "source");
	if (source && isImportedBranch(source) && agent !== GITHUB_AGENT)
		fail(403, `${source}: only ${GITHUB_AGENT} merges GitHive's copies of GitHub's branches`);
}

// githive-github's changes are named for the GitHub commit they bring in: another agent holding that name first would
// keep GitHub's change from being claimed.
function refuseGitHubChangeName(change: string, agent: string) {
	if (agent === GITHUB_AGENT) return;
	if (change.startsWith(GITHUB_CHANGE_PREFIX))
		fail(403, `${change}: changes named ${GITHUB_CHANGE_PREFIX}… are ${GITHUB_AGENT}'s, bringing GitHub's in`);
}

// The branch a claim lands on, and how it was made ready if it's new. A change lands on one branch: claiming again
// keeps it there, and naming another is refused.
async function landingBranch(call: ToolCall, change: string, agent: string) {
	const { args, ctx, repo, registered, claims, stamper, branch } = call;
	const held = await call.claimOf(change);
	const into = optionalString(args, "into") ?? held?.into ?? branch;
	if (held && (held.into ?? branch) !== into)
		fail(
			409,
			`${change} lands on ${held.into ?? branch}: a change lands on one branch; claim another ` + `change for ${into}`,
		);
	if (into === branch || held) return { into, made: undefined };
	const from = optionalString(args, "from");
	const made = await targetBranch(ctx, repo, { into, from, registered, claims, agent, stamper });
	return { into, made };
}

// What a claim reports: its outcome with conflicting paths as agents wrote them, where the change lands, when the claim
// may free up, and a note on a branch merge or on paths a refused claim still holds.
function claimReply(
	outcome: ClaimOutcome,
	claimed: {
		change: string;
		into: string;
		branch: string;
		made?: string;
		source?: string;
		merging?: { tip: string };
		paths: string[];
		claimedAt: number;
	},
) {
	const { change, into, branch, made, source, merging, paths, claimedAt } = claimed;
	// Report conflicting paths as agents wrote them, without the branch scoping.
	const asWritten = (path: string) => presentClaim({ paths: [path] }, branch).paths[0];
	const conflicts = outcome.ok
		? undefined
		: outcome.conflicts.map((conflict) => ({
				...conflict,
				path: asWritten(conflict.path),
				held: asWritten(conflict.held),
			}));
	const merged = merging
		? {
				source,
				head: merging.tip,
				claimed: paths,
				note:
					`${change} merges ${source} at ${merging.tip.slice(0, 8)} into ${into}: its branch changes/${change} ` +
					`is that commit, in your fork. Get it reviewed, check and merge it like any change. If ${source} ` +
					"moves on, claim again to bring the change up to its new tip (a new head, so a new review).",
			}
		: {};
	// A refused claim that couldn't be fully backed out still holds paths: releasing the change frees them.
	const stuck =
		!outcome.ok && outcome.stillHeld?.length
			? {
					note:
						`part of ${change}'s claim couldn't be undone and still holds paths (${outcome.stillHeld.length} ` +
						`record(s)): release ${change} to free them`,
				}
			: {};
	const reply: Record<string, unknown> = { ...outcome };
	// The soonest anyone may take its paths if its agent goes quiet: the floor after a claim (see staleness.ts). It
	// lasts longer once something is pushed, and status's lease says exactly; claiming again renews it.
	if (outcome.ok) reply.freeAfter = new Date(claimedAt + BUILDING_IDLE_MS).toISOString();
	if (conflicts) reply.conflicts = conflicts;
	if (into !== branch) reply.into = into;
	if (made) reply.branch = made;
	return Object.assign(reply, merged, stuck);
}
