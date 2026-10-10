import git from "isomorphic-git";
import { type Remote, Workspace } from "../../git";
import { projectBranch } from "../../project-branch";
import { Timing } from "../../timing";
import { claimInto, presentClaim } from "../branch-scope";
import { DEFAULT_SKIP_CHECKS } from "../check-scope";
import type { ClaimRecord, Registry, ReleaseRecord } from "../claims";
import type { VoteStore, VotesView } from "../vote-store";
import { DEFAULT_GRANT, type FlagRecord, openFlag, type ReviewPolicy, type VoteRecord } from "../votes";
import { holdKey, ROLE_WAIT_MS, waitingRoleReviews } from "../work";
import { runAudit } from "./audit-tools";
import { changeHead, changeSourceFor, changeStatus } from "./change-state";
import { targetBranch } from "./claim-input";
import type { HostedStatus, ToolContext } from "./context";
import { claimsRef, DEFAULT_POLICY, recordLog, shardingOf, shardVotesIfBusy, storeFor, votesFor } from "./repo";

// What the dashboard reads and does through the toolkit: a repo's snapshot and audit, a change's
// history, and votes, branches and counts on a person's behalf.

/**
 * Flags each blocking-role review that has waited unheld for ROLE_WAIT_MS, once per commit and role,
 * so a person can take it or nudge its holders.
 */
export async function tellPeopleOfWaitingRoles(
	ctx: ToolContext,
	repo: string,
	votes: VoteStore,
	policy: ReviewPolicy,
	open: { claim: ClaimRecord; head: string | null }[],
	counted: VoteRecord[],
	policyOf?: (claim: ClaimRecord) => ReviewPolicy,
) {
	if (!ctx.reviews?.waits || !ctx.reviews.told) return;
	const waiting = waitingRoleReviews({
		policy,
		...(policyOf ? { policyOf } : {}),
		open,
		votes: counted,
		held: await ctx.reviews.held(repo),
	});
	const waits = await ctx.reviews.waits(
		repo,
		waiting.map((review) => holdKey(review.head, review.role)),
	);
	let told = false;
	for (const review of waiting) {
		const key = holdKey(review.head, review.role);
		const since = waits[key];
		if (!since || since.told || Date.now() - since.since < ROLE_WAIT_MS) continue;
		const holders = policy.grants?.[review.role] ?? DEFAULT_GRANT;
		const people = holders.some((holder) => holder.startsWith("person:"));
		const minutes = Math.round((Date.now() - since.since) / 60_000);
		const next = people
			? `You can review it as ${review.role} from the dashboard.`
			: `No person holds ${review.role}, so you can't sign it off: nudge its holders, or grant it to more.`;
		const reason =
			`${review.change}'s ${review.role} review has waited ${minutes} minutes and none of its holders ` +
			`(${holders.join(", ")}) has taken it. ${next}`;
		await votes.flag({ change: review.change, agent: "githive", role: review.role, reason });
		await ctx.reviews.told(repo, key);
		told = true;
	}
	if (told) {
		await ctx.ping?.(repo).catch(() => undefined);
		await repoSnapshot(ctx, repo).catch(() => undefined);
	}
}

/**
 * One change's history for its dashboard page: its claim (or how it ended), its last 50 commits
 * newest first, every vote on them, and its merge if it merged.
 */
export async function changeHistory(ctx: ToolContext, repo: string, change: string) {
	const timing = ctx.timing ?? new Timing();
	const registry = (await timing.time("registry", () => recordLog<Registry>(ctx, repo, claimsRef(repo)).read()))?.commit
		.state;
	if (!registry?.baseline) throw new Error(`[404] GitHive hasn't started on ${repo}`);
	const { claim: record, released } = await timing.time("change", () =>
		storeFor(ctx, repo, registry).readChange(change),
	);
	if (!record && !released.length) throw new Error(`[404] no change ${change} on ${repo}`);
	// The change's own commits are those since it left the branch it lands on.
	const branch = record ? claimInto(record, projectBranch(registry)) : projectBranch(registry);
	const claim = record ? presentClaim(record, projectBranch(registry)) : undefined;
	const mergedAs = released.find((release) => release.mergedAs)?.mergedAs;
	const commits = await Promise.resolve()
		.then(() =>
			timing.time("fork", () => changeSourceFor(ctx, repo)(claim?.agent ?? released.at(-1)!.agent, "read", change)),
		)
		.then((source) => ownCommits(ctx, repo, { change, source, branch, mergedAs, timing }))
		// Nothing pushed yet (no fork, or no branch on it).
		.catch(() => [] as OwnCommit[]);
	const ids = new Set(commits.map((commit) => commit.commit));
	const votes = (await votesFor(ctx, repo).readFor([...ids])).votes.filter((vote) => ids.has(vote.commit));
	return { change, branch, claim: claim ?? null, released, commits, votes };
}

type OwnCommit = { commit: string; message: string; author: string; at: string };

// A change's last 50 commits, newest first, back to where it left `branch`, or where it left the main its merge
// went onto once it merged.
async function ownCommits(
	ctx: ToolContext,
	repo: string,
	at: { change: string; source: Remote; branch: string; mergedAs?: string; timing: Timing },
): Promise<OwnCommit[]> {
	const { change, source, branch, mergedAs, timing } = at;
	// Shallow: a change is a few commits on a recent head, and finding the merge base deepens it if needed.
	const workspace = await timing.time("clone", () => Workspace.clone(source, `changes/${change}`, { depth: 8 }));
	const head = await workspace.head();
	// For a merged change, its base is found from the merge's first parent, not the branch's current head.
	const projectHead = await timing.time("project", async () =>
		workspace.fetch("project", await ctx.remote(repo, "read"), branch),
	);
	// Merged: its own commits are those since it left the branch as it was before the merge.
	const beforeMerge = mergedAs ? (await workspace.ensureCommit(mergedAs)).commit.parent[0] : undefined;
	const before = beforeMerge ?? projectHead;
	const stop = await timing.time("base", () => workspace.mergeBase(before, head));
	const own: OwnCommit[] = [];
	for (const { oid, commit } of await git.log({ fs: workspace.fs, dir: "/repo", ref: head, depth: 50 })) {
		if (oid === stop) break;
		own.push({
			commit: oid,
			message: commit.message.trim(),
			author: commit.author.name,
			at: new Date(commit.author.timestamp * 1000).toISOString(),
		});
	}
	return own;
}

/**
 * A person's vote from the dashboard on a change's current commit, stamped with their verified identity
 * and counted like any other vote (never the author's). It also answers any open question about the change.
 */
export async function voteAsPerson(
	ctx: ToolContext,
	repo: string,
	change: string,
	input: { role: string; verdict: "approve" | "reject"; evidence: string },
	person: string,
) {
	if (!person.startsWith("person:"))
		throw new Error("[403] only a person signed in through Access votes from the dashboard; agents use vote");
	if (!input.role?.trim()) throw new Error("[400] a vote needs a role");
	if (input.verdict !== "approve" && input.verdict !== "reject") throw new Error("[400] verdict is approve or reject");
	if (typeof input.evidence !== "string" || !input.evidence.trim())
		throw new Error("[400] a vote needs evidence: what you checked");
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const { claim } = await storeFor(ctx, repo, registry).readChange(change);
	if (!claim) throw new Error(`[409] ${change} holds no claim: there's nothing to vote on`);
	const head = await changeHead(ctx, repo, claim.agent, change, claim.since).catch(() => null);
	if (!head) throw new Error(`[409] ${change} has nothing pushed to vote on`);
	const stamper = await ctx.stamper?.();
	const teams = (await ctx.teamsOf?.(repo)) ?? [];
	await votesFor(ctx, repo, await shardVotesIfBusy(ctx, repo, registry, person)).vote(
		{
			commit: head,
			reviewer: person,
			role: input.role,
			verdict: input.verdict,
			evidence: input.evidence,
			...(teams.length ? { teams } : {}),
		},
		stamper,
	);
	await ctx.ping?.(repo).catch(() => undefined);
	return { commit: head, role: input.role, verdict: input.verdict };
}

/**
 * Makes or adopts a branch from the dashboard, as a claim with `into` and `from` would,
 * recorded under the person's name.
 */
export async function makeBranch(
	ctx: ToolContext,
	repo: string,
	input: { name: string; from: string },
	person: string,
) {
	const claims = recordLog<Registry>(ctx, repo, claimsRef(repo));
	const registered = (await claims.read())?.commit.state;
	if (!registered?.baseline)
		throw new Error(`[409] GitHive hasn't started on ${repo}: its admins start it with settings`);
	if (input.name === projectBranch(registered) || registered.branches?.[input.name])
		throw new Error(`[409] ${input.name} takes changes already`);
	const made = await targetBranch(ctx, repo, {
		into: input.name,
		from: input.from,
		registered,
		claims,
		agent: person,
		...(ctx.stamper ? { stamper: await ctx.stamper() } : {}),
	});
	await ctx.ping?.(repo).catch(() => undefined);
	return { name: input.name, made };
}

/** The audit for the dashboard. It replays every record, so it runs apart from the snapshot. */
export async function repoAudit(ctx: ToolContext, repo: string) {
	const { merges, violations } = await runAudit(ctx, repo);
	const open = violations.filter((violation) => !violation.resolvedBy).length;
	await ctx.summarize?.(repo, { merged: merges, violations: open }).catch(() => undefined);
	return { merges, open, violations };
}

/** The dashboard's view of a repo, read from the records' tips. The audit is separate (see repoAudit). */
export async function repoSnapshot(ctx: ToolContext, repo: string) {
	const timing = ctx.timing ?? new Timing();
	const [registry, votes] = await timing.time("records", () =>
		Promise.all([recordLog<Registry>(ctx, repo, claimsRef(repo)).read(), votesFor(ctx, repo).read()]),
	);
	const state = registry?.commit.state;
	if (!state?.baseline) throw new Error(`[404] GitHive hasn't started on ${repo}`);
	const held = await timing.time("claims", () => storeFor(ctx, repo, state).read());
	const claims = await timing.time("status", () =>
		Promise.all(held.claims.map((record) => claimSnapshot(ctx, repo, state, votes, held.released, record))),
	);
	const waiting = claims.filter((claim) => claim.attention);
	await ctx
		.summarize?.(repo, {
			open: claims.length,
			needsYou: waiting.length,
			waiting: waiting.slice(0, 20).map((claim) => ({
				change: claim.change,
				title: (claim.intent.split("\n")[0] ?? "").slice(0, 120),
				reason: claim.attention!.reason.slice(0, 500),
			})),
			countedAt: new Date().toISOString(),
		})
		.catch(() => undefined);
	return {
		repo,
		/** The project's branch, which changes merge into by default. */
		branch: projectBranch(state),
		skipChecks: state.skipChecks ?? DEFAULT_SKIP_CHECKS,
		...(state.branchRules?.length ? { branchRules: state.branchRules } : {}),
		/** Other branches that changes land on, and where each started. */
		branches: Object.entries(state.branches ?? {}).map(([name, record]) => ({
			name,
			base: record.base,
			...(record.from ? { from: record.from } : {}),
			at: record.at,
		})),
		policy: state.policy ?? DEFAULT_POLICY,
		verify: state.verify ?? [],
		/** Whether records and merges are stamped with verified identity. */
		verified: !!state.stampKey,
		/** Per-path shard depth for claims (absent: one registry); `sharding` says since when and why. */
		...(state.shardDepth ? { shardDepth: state.shardDepth } : {}),
		sharding: shardingOf(state).sharding,
		/** "never" (one record), "on demand" (buckets once the load calls for them), or bucketed since `since`. */
		votesSharding: votes.sharded ?? (state.autoShard || state.shardDepth ? "on demand" : "never"),
		claims,
		votes: votes.votes.slice(-20).reverse(),
	};
}

type Attention = { reason: string; agent: string; at: string };
type ChangeStatus = Awaited<ReturnType<typeof changeStatus>>;

interface ClaimSnapshot extends ClaimRecord {
	head: string | null;
	approval: ChangeStatus["approval"];
	hosted?: HostedStatus;
	attention?: Attention;
	waitsOn?: string[];
}

// A claim as the dashboard shows it: where its change stands, what needs a person, and what it waits on.
async function claimSnapshot(
	ctx: ToolContext,
	repo: string,
	state: Registry,
	votes: VotesView,
	released: ReleaseRecord[],
	record: ClaimRecord,
): Promise<ClaimSnapshot> {
	const claim = presentClaim(record, projectBranch(state));
	const { head, approval, hosted } = await changeStatus(ctx, repo, state, async () => votes.votes, claim.change, claim);
	// A question stays open until a person votes on the change's commit. For a waiting role's review,
	// it closes once that role signs off.
	const asked = openFlag(votes, claim.change, head);
	const flag = asked?.role && !approval.awaiting?.includes(asked.role) ? null : asked;
	const attention = attentionFor(flag, hosted, claim);
	// Dependencies not yet merged into the branch this change lands on.
	const into = claim.into ?? projectBranch(state);
	const mergedInto = (dependency: string) =>
		released.some(
			(release) => release.change === dependency && release.mergedAs && (release.into ?? projectBranch(state)) === into,
		);
	const waitsOn = (claim.after ?? []).filter((dependency) => !mergedInto(dependency));
	const snapshot: ClaimSnapshot = { ...claim, head, approval };
	if (hosted) snapshot.hosted = hosted;
	if (attention) snapshot.attention = attention;
	if (waitsOn.length) snapshot.waitsOn = waitsOn;
	return snapshot;
}

// What needs a person on a claim: an open question, or a hosted builder that failed.
function attentionFor(flag: FlagRecord | null, hosted: HostedStatus | undefined, claim: ClaimRecord): Attention | null {
	if (flag) return { reason: flag.reason, agent: flag.agent, at: flag.at };
	if (hosted?.builder?.status !== "failed") return null;
	const error = hosted.builder.error ? `: ${hosted.builder.error.slice(0, 160)}` : "";
	return { reason: `GitHive's builder failed${error}`, agent: "githive-builder", at: claim.active };
}

/** The number of claims in force, for the repo list; null before GitHive starts on the repo. */
export async function openCount(ctx: ToolContext, repo: string) {
	const state = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	if (!state?.baseline) return null;
	return (await storeFor(ctx, repo, state).read()).claims.length;
}
