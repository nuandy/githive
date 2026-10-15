import { changeId, normalizeClaim } from "../../claim-paths";
import { fail, requiredPaths, requiredString } from "../../errors";
import { isReservedPath, presentClaim, scopePaths } from "../branch-scope";
import { GITHUB_AGENT, GITHUB_CHANGE_PREFIX, isGitHubChange, isImportedBranch } from "../github-settings";
import { briefSteers, claimHints, keepSteering, steeringReply } from "../clef-hints";
import { giveBackPartClaim, withoutLeftovers } from "./claim-leftovers";
import { abandonedRule } from "./change-state";
import { askHolders, type Judged, keepingJudged } from "./ask-holders";
import { branchMerge, changeList, dependencyLoop, newChangeId, targetBranch } from "./claim-input";
import type { ClaimOutcome } from "../claim-store";
import type { ClaimRecord } from "../claims";
import type { Args, ToolCall, ToolHandlers } from "./context";
import { giveUpGitHubChange } from "./github-tools";
import { ownerOf } from "../votes";
import type { Work } from "../work";
import { containerChecks, recordLog, shardIfBusy, STALE_AFTER_MS, storeFor, workRef } from "./repo";

// Tools for claims: claim, release, claims, and build (a claim worked by GitHive's hosted builder).

// A string argument with its whitespace trimmed, or undefined if it's missing or blank.
const optionalString = (args: Args, field: string) =>
	typeof args[field] === "string" && args[field].trim() ? args[field].trim() : undefined;

export const claimTools: ToolHandlers = {
	async claims({ adviceView }) {
		return (await adviceView()).claims;
	},
	claim: (call) => claimChange(call),
	async release(call) {
		const { args, ctx, repo, votes, registered, actAs, stamper, store, claimOf } = call;
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
		const mergedAs = held ? await landedAs(call, held) : undefined;
		// Still the caller's when it's written: another agent may take the name over meanwhile.
		const holder = held ? { holder: held.agent } : {};
		const released = await store.release(
			{ change, agent, reason, ...holder, ...(mergedAs ? { mergedAs } : {}) },
			stamper,
		);
		// What it freed, so the repo wakes only agents it may offer work (see ring-concerns.ts).
		if (!held || !released.ok) return released;
		return { ...released, freed: held.paths, ...(mergedAs ? { merged: true } : {}) };
	},
	async build({ args, ctx, repo, votes, registered, stamper, store }) {
		if (!ctx.startBuilder) fail(501, "hosted builders aren't available here");
		if (ctx.mayUseHosted && !(await ctx.mayUseHosted()))
			fail(403, "GitHive's hosted agents are by invitation: ask an admin to add you");
		const intent = requiredString(args, "intent");
		const change = changeId(intent);
		const steers = await briefSteers(ctx, intent);
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
		if (steers === undefined) return ctx.startBuilder({ repo, change });
		// The builder still starts: its reviewers and the people watching hear of the flag.
		await keepSteering(ctx, repo, change, { in: "intent", likelihood: steers });
		return { ...(await ctx.startBuilder({ repo, change })), steering: steeringReply(steers) };
	},
};

/**
 * Claims a change. From claim_work, `piece` is the backlog piece taken: its intent is the text its author wrote, so a
 * steering flag on it names them.
 */
export async function claimChange(call: ToolCall, piece?: { by: string }) {
	const { args, ctx, repo, claims, votes, registered, actAs, stamper, store, branch, changeSource, warmChecks } = call;
	const change = newChangeId(args);
	const agent = actAs("agent");
	// With `source`, the change merges a whole branch, claiming what it changed (see branchMerge).
	const source = optionalString(args, "source");
	refuseGitHubBranches(args, agent);
	refuseGitHubChangeName(change, agent);
	const holder = await call.claimOf(change);
	if (holder && holder.agent !== agent) await refuseOthersChange(call, holder);
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
	const { similar, steers } = await asClefSees(call, { change, agent, intent, paths });
	// The claims in the way that the claim judges, so a refusal can ask their holders whether they're still there.
	const judged = new Map<string, Judged>();
	const input = {
		change,
		agent,
		paths: scopePaths(paths, into, branch),
		intent,
		...(after.length ? { after } : {}),
		...(source ? { source } : {}),
		staleAfterMs: STALE_AFTER_MS,
		abandoned: keepingJudged(abandonedRule(ctx, repo, registered, votes), judged),
	};
	// If one record would hold agents up, shard first, then claim in the shards.
	const sharded = await shardIfBusy(ctx, repo, claims, registered, input.agent);
	// Asked before claiming: claiming again renews what was counted then.
	const renewing = (await call.claimOf(change))?.agent === agent;
	const claimStore = sharded ? storeFor(ctx, repo, sharded) : store;
	const giveBack = (reason: string) => giveBackPartClaim(call, claimStore, { change, agent, reason });
	const written = await claimStore.claim(input, stamper).catch(async (err) => {
		// A store can answer an error after the claim is written; a new claim is given back, so it doesn't sit
		// in the agent's name unbuilt. A renewal stays: the change was the agent's already.
		if (!renewing) await giveBack("its claim failed partway");
		throw await askingHolderOfName(call, judged, change, err);
	});
	const outcome = await withoutLeftovers(written, renewing, giveBack);
	if (outcome.ok) await keepToOwnerLimit(call, claimStore, { change, agent, renewing });
	// Once claimed, the source's tip becomes the change's branch in the agent's fork.
	if (outcome.ok && merging) await merging.push(await changeSource(agent, "write"), change);
	// Without container checks, a Gate that lands batches does so within minutes, so warm it from the claim. A cold
	// Gate holds up the first batch. With checks, a claim is too early to install for; they warm at the check.
	if (outcome.ok && !containerChecks(registered?.verify).length) await warmChecks("claimed", change);
	const reply = claimReply(outcome, { change, into, branch, made, source, merging, paths });
	if (!outcome.ok) return withAsked(reply, await asking(call, judged, outcome.conflicts));
	if (steers !== undefined) {
		const written = piece ? { in: "backlog piece", by: piece.by } : { in: "intent", by: agent };
		await keepSteering(ctx, repo, change, { ...written, likelihood: steers });
	}
	return {
		...reply,
		...(similar ? { similar } : {}),
		...(steers === undefined ? {} : { steering: steeringReply(steers) }),
	};
}

/**
 * Another agent's change may be taken over, once its agent has gone silent, by its owner's other agents, or by anyone
 * when it's a backlog piece (owner limits count that); another person's agents claim under a name of their own.
 */
async function refuseOthersChange(call: ToolCall, held: ClaimRecord) {
	const owner = ownerOf(held.by);
	if (!owner || owner === ownerOf(call.ctx.identity)) return;
	const backlog = await recordLog<Work>(call.ctx, call.repo, workRef(call.repo)).read();
	if (backlog?.commit.state.items.some((item) => item.id === held.change)) return;
	fail(
		403,
		`${held.change} is ${held.agent}'s change, and only its owner's agents may take it over: claim under a ` +
			"change name of your own",
	);
}

/** Asks the holders of the claims in the way; a question that can't be written leaves the refusal as it is. */
async function asking(call: ToolCall, judged: Map<string, Judged>, conflicts: { change: string }[]) {
	return askHolders(
		call,
		judged,
		conflicts.map((conflict) => conflict.change),
	).catch((err: unknown) => {
		console.error(`asking holders in ${call.repo} whether they're still there failed`, String(err));
		return [];
	});
}

function withAsked(reply: Record<string, unknown>, asked: Awaited<ReturnType<typeof askHolders>>) {
	return asked.length ? { ...reply, asked } : reply;
}

// A claim refused because another agent holds the change's name asks that agent too, and says when to claim again.
async function askingHolderOfName(call: ToolCall, judged: Map<string, Judged>, change: string, err: unknown) {
	if (!(err instanceof Error) || !judged.has(change)) return err;
	const [asked] = await asking(call, judged, [{ change }]);
	return asked ? new Error(`${err.message}\n${asked.note}`) : err;
}

/**
 * What Clef sees in a new claim, as advice, since the claim still goes ahead: an open change that may already do what
 * its intent says, and how sure it is that the intent steers the agents who will read it. Asked of a new claim only;
 * claiming again renews what was asked about then.
 */
async function asClefSees(call: ToolCall, claim: { change: string; agent: string; intent: string; paths: string[] }) {
	const held = await call.claimOf(claim.change);
	if (held?.agent === claim.agent) return {};
	const open = (await call.adviceView()).claims.filter((other) => other.change !== claim.change);
	const comparable = open.map((other) => ({ id: other.change, intent: other.intent }));
	const { same, steers } = await claimHints(call.ctx, claim, comparable);
	const match = same && open.find((other) => other.change === same.id);
	if (!match) return { steers };
	const intent = match.intent.split("\n")[0] ?? "";
	return { similar: { change: match.change, agent: match.agent, intent, likelihood: same.likelihood }, steers };
}

/**
 * The commit a held claim's change landed as while it was held, if it did. A claim can outlast its landing, and its
 * release then names the merge as merge's own release does, so the audit doesn't read it as given up first.
 */
async function landedAs(call: ToolCall, held: ClaimRecord) {
	const branch = held.into ?? call.branch;
	const view = await call.ctx
		.landing?.(call.repo, branch)
		.view()
		.catch(() => null);
	const landed = view?.recent.findLast((outcome) => outcome.change === held.change && outcome.how === "landed");
	if (!landed) return undefined;
	// A landing before this claim was made is an earlier change under the same name.
	if (landed.at < held.since) return undefined;
	return landed.commit;
}

/**
 * Counts a claimed piece of someone else's backlog against the agent owner's limit (see agent-limits.ts). Counted
 * once claimed, so losing a race for a piece costs nothing; a refusal gives the claim back.
 */
async function keepToOwnerLimit(
	call: ToolCall,
	claimStore: ToolCall["store"],
	claimed: { change: string; agent: string; renewing: boolean },
) {
	const { ctx, repo, stamper } = call;
	if (!ctx.ownerLimits) return;
	if (claimed.renewing) return;
	const backlog = await recordLog<Work>(ctx, repo, workRef(repo)).read();
	const piece = backlog?.commit.state.items.find((item) => item.id === claimed.change);
	// Not a backlog piece: the agent's own new work.
	if (!piece) return;
	if (piece.owner === ctx.identity) return;
	const refused = await ctx.ownerLimits.take("build");
	if (!refused) return;
	await claimStore.release({ change: claimed.change, agent: claimed.agent, reason: "its owner's limit" }, stamper);
	fail(403, refused);
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

// What a claim reports: its outcome with conflicting paths as agents wrote them, where the change lands, and a note on
// a branch merge or on paths a refused claim still holds.
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
	},
) {
	const { change, into, branch, made, source, merging, paths } = claimed;
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
	if (conflicts) reply.conflicts = conflicts;
	if (into !== branch) reply.into = into;
	if (made) reply.branch = made;
	return Object.assign(reply, merged, stuck);
}
