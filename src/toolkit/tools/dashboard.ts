import git from "isomorphic-git";
import { diffCommits } from "../../change-diff";
import { type Remote, Workspace } from "../../git";
import { fetchCommits } from "../../git-fetch";
import { projectBranch } from "../../project-branch";
import { Timing } from "../../timing";
import { claimInto, presentClaim } from "../branch-scope";
import { DEFAULT_SKIP_CHECKS } from "../check-scope";
import type { ClaimRecord, Registry, ReleaseRecord } from "../claims";
import { bringsGitHubBack, githubSync, isGitHubChange, trustsGitHub } from "../github-settings";
import type { LandingView } from "../landing";
import { leaseFor } from "../staleness";
import type { VoteStore, VotesView } from "../vote-store";
import { DEFAULT_GRANT, type FlagRecord, openFlag, peopleOnly, type ReviewPolicy, type VoteRecord } from "../votes";
import { holdKey, ROLE_WAIT_MS, waitingRoleReviews } from "../work";
import { runAudit } from "./audit-tools";
import { changeHead, changeSigns, changeSourceFor, changeState, type changeStatus } from "./change-state";
import { targetBranch } from "./claim-input";
import { giveUpGitHubChange } from "./github-tools";
import type { HostedStatus, ToolContext, WaitingItem } from "./context";
import {
	branchSettings,
	claimPolicy,
	claimsRef,
	DEFAULT_POLICY,
	recordLog,
	shardingOf,
	shardVotesIfBusy,
	storeFor,
	votesFor,
} from "./repo";
import { fail } from "../../errors";

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
		held: await ctx.reviews.held(
			repo,
			open.flatMap((entry) => (entry.head ? [entry.head] : [])),
		),
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
	if (!registry?.baseline) fail(404, `GitHive hasn't started on ${repo}`);
	const { claim: record, released } = await timing.time("change", () =>
		storeFor(ctx, repo, registry).readChange(change),
	);
	if (!record && !released.length) fail(404, `no change ${change} on ${repo}`);
	// The change's own commits are those since it left the branch it lands on.
	const branch = record ? claimInto(record, projectBranch(registry)) : projectBranch(registry);
	const claim = record ? presentClaim(record, projectBranch(registry)) : undefined;
	const mergedAs = released.find((release) => release.mergedAs)?.mergedAs;
	const hints = cachedHints(ctx, repo, change, !!claim);
	const commits = await Promise.resolve()
		.then(() =>
			timing.time("fork", () => changeSourceFor(ctx, repo)(claim?.agent ?? released.at(-1)!.agent, "read", change)),
		)
		.then((source) => ownCommits(ctx, repo, { change, source, branch, mergedAs, timing }))
		// Nothing pushed yet (no fork, or no branch on it).
		.catch(() => [] as OwnCommit[]);
	const ids = new Set(commits.map((commit) => commit.commit));
	const votes = (await votesFor(ctx, repo).readFor([...ids])).votes.filter((vote) => ids.has(vote.commit));
	return { change, branch, claim: claim ?? null, released, commits, votes, ...(await hints) };
}

/** A merge check as status kept it (see mergeCheck in work-tools.ts), with the change head it was worked out on. */
type KeptCheck = { head: string; into: string; branchHead: string; clean: boolean } & Record<string, unknown>;

/**
 * What the caches add to a change's page: while its claim is in force, its last merge check as status kept it (a
 * conflict's files, who changed each, the hunks and the fix) and what its footprint meets in other open changes; and
 * its earlier attempts to land. Each is a hint, read beside the history: one that can't be read is left out, and
 * logged. The caches bound them all (hunks, attempts and overlaps are capped where they're kept or read).
 */
async function cachedHints(ctx: ToolContext, repo: string, change: string, open: boolean) {
	const hint = <T>(what: string, read: () => Promise<T> | undefined) =>
		Promise.resolve()
			.then(read)
			.catch((err: unknown) => {
				console.error(`reading ${change}'s ${what} on ${repo} for the dashboard failed`, String(err));
				return undefined;
			});
	const [kept, attempts, awareness] = await Promise.all([
		open ? hint("merge check", () => ctx.mergeChecks?.kept(repo, change)) : undefined,
		hint("attempts", () => ctx.attemptsOf?.(repo, [change])),
		open ? hint("footprint", () => ctx.awarenessOf?.(repo, change)) : undefined,
	]);
	// The check is kept under "<change head> <branch head>".
	const merge = kept ? ({ head: kept.key.split(" ")[0], ...(kept.result as object) } as KeptCheck) : undefined;
	const tried = attempts?.[change];
	return {
		...(merge ? { merge } : {}),
		...(tried?.length ? { attempts: tried } : {}),
		...(awareness ? { awareness } : {}),
	};
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
 * A change's files for its page's Files tab (see change-diff.ts). Open, or released without landing: its pushed head
 * against its merge base with the branch it lands on, each file outside its claim flagged. Landed: the commit it
 * landed as against that commit's first parent, the branch before it, which is what it brought. Nothing pushed (or its
 * branch gone): no files. When they can't be read (its branch or what it landed as unreadable just now, or no history
 * shared with its branch), no files and `unavailable` says why: an answer, kept like one, not a failure every reader
 * repeats.
 */
export async function changeDiff(ctx: ToolContext, repo: string, change: string) {
	const timing = ctx.timing ?? new Timing();
	const registry = (await timing.time("registry", () => recordLog<Registry>(ctx, repo, claimsRef(repo)).read()))?.commit
		.state;
	if (!registry?.baseline) fail(404, `GitHive hasn't started on ${repo}`);
	const { claim: record, released } = await timing.time("change", () =>
		storeFor(ctx, repo, registry).readChange(change),
	);
	if (!record && !released.length) fail(404, `no change ${change} on ${repo}`);
	const mergedAs = record ? undefined : released.find((release) => release.mergedAs)?.mergedAs;
	const of = mergedAs ? ("landed" as const) : ("head" as const);
	try {
		if (mergedAs) return { change, of, ...(await landedDiff(ctx, repo, change, mergedAs, timing)) };
		const agent = record?.agent ?? released.at(-1)!.agent;
		const branch = record ? claimInto(record, projectBranch(registry)) : projectBranch(registry);
		const claimed = record ? presentClaim(record, projectBranch(registry)).paths : null;
		const workspace = await timing
			.time("clone", async () =>
				Workspace.clone(await changeSourceFor(ctx, repo)(agent, "read", change, record?.since), `changes/${change}`, {
					depth: 8,
				}),
			)
			.catch(() => null);
		if (!workspace) return { change, of, base: null, head: null, files: [], total: 0 };
		const head = await workspace.head();
		const projectHead = await unless(`${branch} couldn't be read just now.`, head, () =>
			timing.time("project", async () => workspace.fetch("project", await ctx.remote(repo, "read"), branch)),
		);
		const base = await unless(
			(err) =>
				/no common ancestor/.test(String(err))
					? `It shares no history with ${branch}.`
					: `Where it left ${branch} couldn't be found just now.`,
			head,
			() => timing.time("base", () => workspace.mergeBase(projectHead, head)),
		);
		const diff = await unless("Its files couldn't be read just now.", head, () =>
			timing.time("diff", () => diffCommits(workspace.held, base, head, { claimed })),
		);
		return { change, of, ...diff };
	} catch (err) {
		if (!(err instanceof Unavailable)) throw err;
		return { change, of, base: null, head: err.head, files: [], total: 0, unavailable: err.message };
	}
}

// What a landed change brought: the commit it landed as against its first parent.
async function landedDiff(ctx: ToolContext, repo: string, change: string, mergedAs: string, timing: Timing) {
	const lost = "The commit it landed as couldn't be read just now.";
	// The merge and its parents, with their trees, in one fetch.
	const held = await unless(lost, mergedAs, () =>
		timing.time("fetch", async () => fetchCommits(await ctx.remote(repo, "read"), [mergedAs], "/landed", { depth: 2 })),
	);
	const { commit } = await unless(lost, mergedAs, () => git.readCommit({ ...held, oid: mergedAs }));
	const before = commit.parent[0] ?? fail(409, `${change} landed as ${mergedAs}, which has no parent`);
	return unless("Its files couldn't be read just now.", mergedAs, () =>
		timing.time("diff", () => diffCommits(held, before, mergedAs)),
	);
}

/** Why a change's files can't be read just now, with its head where that was read. */
class Unavailable extends Error {
	constructor(
		why: string,
		readonly head: string | null,
	) {
		super(why);
	}
}

// `work`'s answer, or Unavailable saying why it failed (logged).
function unless<T>(why: string | ((err: unknown) => string), head: string | null, work: () => Promise<T>) {
	return work().catch((err: unknown) => {
		const said = typeof why === "string" ? why : why(err);
		console.error(`a change's files: ${said}`, String(err));
		throw new Unavailable(said, head);
	});
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
		fail(403, "only a person signed in through Access votes from the dashboard; agents use vote");
	if (!input.role?.trim()) fail(400, "a vote needs a role");
	if (input.verdict !== "approve" && input.verdict !== "reject") fail(400, "verdict is approve or reject");
	if (typeof input.evidence !== "string" || !input.evidence.trim())
		fail(400, "a vote needs evidence: what you checked");
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const { claim } = await storeFor(ctx, repo, registry).readChange(change);
	if (!claim) fail(409, `${change} holds no claim: there's nothing to vote on`);
	const head = await changeHead(ctx, repo, claim.agent, change, claim.since).catch(() => null);
	if (!head) fail(409, `${change} has nothing pushed to vote on`);
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
	if (!registered?.baseline) fail(409, `GitHive hasn't started on ${repo}: its admins start it with settings`);
	if (input.name === projectBranch(registered) || registered.branches?.[input.name])
		fail(409, `${input.name} takes changes already`);
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

/**
 * A person gives up GitHub's change from the dashboard: its claim released, so its paths are free, and its job ended
 * until GitHub's branch moves or someone asks again (see giveUpGitHubChange). The route checks they can write.
 */
export async function giveUpAsPerson(ctx: ToolContext, repo: string, change: string, person: string) {
	if (!person.startsWith("person:"))
		fail(403, "only a person gives up GitHub's changes from the dashboard; a repo admin's agents use release");
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const store = storeFor(ctx, repo, registry);
	const { claim } = await store.readChange(change);
	if (!claim) fail(409, `${change} holds no claim: there's nothing to give up`);
	const stamper = await ctx.stamper?.();
	const outcome = await giveUpGitHubChange(ctx, repo, { store, claim, who: person, ...(stamper ? { stamper } : {}) });
	await ctx.ping?.(repo).catch(() => undefined);
	return outcome;
}

/** What a person's release tells, and what its agent hears. */
export const RELEASED_NOTE = "Its paths are free for other agents; its agent is told; its commits stay on its branch.";

/** The most of a person's reason for a release that's kept, as of a question for people (see waitingOnPerson). */
const RELEASE_REASON_CHARS = 500;

/**
 * A person releases a change's claim from the dashboard, whoever's it is, saying why: a stuck change freed. Its paths
 * are free for other agents, its agent is told with its next reply, and its commits stay on its branch. The release is
 * stamped with the person, not as stale, which the audit accepts (see othersClaimsReleased). Not while its batch is
 * being checked, which may land it. GitHub's change is given up as before (see giveUpGitHubChange), so GitHive brings it
 * back when GitHub's branch moves; the reason, asked here as for any change, gives way to that one's own. The route
 * checks they can write.
 */
export async function releaseAsPerson(ctx: ToolContext, repo: string, change: string, person: string, reason: string) {
	if (!/^person:[^/]+$/.test(person))
		fail(403, "only a person releases another's claim from the dashboard; agents release their own with release");
	const why = reason.trim().slice(0, RELEASE_REASON_CHARS);
	if (!why) fail(400, "say why you release it: its agent is told");
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const store = storeFor(ctx, repo, registry);
	const { claim } = await store.readChange(change);
	if (!claim) fail(409, `${change} holds no claim: there's nothing to release`);
	// Released mid-check, it would land anyway and its merge's own release would fail. A landing unread doesn't stop it.
	const landing = await Promise.resolve()
		.then(() => ctx.landing?.(repo, claimInto(claim, projectBranch(registry))).view())
		.catch(() => null);
	if (landing?.checking?.changes.some((checked) => checked.change === change))
		fail(409, `${change} is being checked to land now; release it if the batch sends it back.`);
	const stamper = await ctx.stamper?.();
	if (isGitHubChange(claim))
		return giveUpGitHubChange(ctx, repo, { store, claim, who: person, ...(stamper ? { stamper } : {}) });
	const outcome = await store.giveUp({ change, agent: person, reason: why, stale: false }, stamper);
	if (!outcome.ok) return outcome;
	const at = new Date().toISOString();
	await ctx.notify?.(repo, claimInto(claim, projectBranch(registry)), [
		{
			agent: claim.agent,
			notice: {
				kind: "released",
				at,
				change,
				says: `A person released your claim on ${change}: ${why}`,
				next:
					`Its paths are free for other agents now. Your commits stay on changes/${change} in your fork; claim ` +
					"again to carry on, if they're still free.",
				from: { agent: person },
			},
		},
	]);
	await ctx.ping?.(repo, { kind: "released", agent: claim.agent, change, detail: why, at }).catch(() => undefined);
	return { ok: true as const, released: change, note: RELEASED_NOTE };
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
	if (!state?.baseline) fail(404, `GitHive hasn't started on ${repo}`);
	const held = await timing.time("claims", () => storeFor(ctx, repo, state).read());
	const landings = await timing.time("landing", () =>
		landingViews(
			ctx,
			repo,
			held.claims.map((record) => claimInto(record, projectBranch(state))),
		),
	);
	const claims = await timing.time("status", () =>
		Promise.all(
			held.claims.map((record) =>
				claimSnapshot(
					ctx,
					repo,
					state,
					votes,
					held.released,
					record,
					landings.get(claimInto(record, projectBranch(state))),
				),
			),
		),
	);
	const waiting = claims
		.flatMap((claim) => waitingOnPerson(claim, votes.votes, claimPolicy(state, claim)) ?? [])
		.sort(inboxOrder);
	await ctx
		.summarize?.(repo, {
			open: claims.length,
			needsYou: waiting.length,
			waiting: waiting.slice(0, 20),
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
		...(state.github ? { github: await githubView(ctx, repo, state) } : {}),
	};
}

/**
 * The connected GitHub repo for the dashboard: how GitHive's work reaches it, whether its changes need review, and
 * as GitHubSync last saw them (hints), the standing pull request and bringing GitHub's changes back.
 */
async function githubView(ctx: ToolContext, repo: string, state: Registry) {
	const seen = await ctx
		.githubSync?.(repo)
		.state()
		.catch(() => null);
	const job = seen?.job;
	return {
		repo: state.github!.repo,
		sync: githubSync(state),
		trust: trustsGitHub(state),
		inbound: bringsGitHubBack(state),
		pull: seen?.pull ? { number: seen.pull.number, url: seen.pull.url } : null,
		...(job
			? {
					fromGitHub: {
						step: job.step,
						commit: job.commit,
						at: job.updatedAt,
						...(job.change ? { change: job.change } : {}),
						...(job.reason ? { reason: job.reason } : {}),
					},
				}
			: {}),
	};
}

/** Why a change waits on a person. `urgency` is how urgent Clef found an agent's question, from 0 to 2. */
type Attention = { reason: string; agent: string; at: string; urgency?: number };
type ChangeStatus = Awaited<ReturnType<typeof changeStatus>>;

interface ClaimSnapshot extends ClaimRecord {
	head: string | null;
	approval: ChangeStatus["approval"];
	/** Why GitHub's change needs no review, while the repo trusts GitHub's changes. */
	trusted?: string;
	hosted?: HostedStatus;
	attention?: Attention;
	waitsOn?: string[];
	lease?: ReturnType<typeof leaseFor>;
}

/** The batch being checked on each of these branches, read once a branch; null where it can't be read. */
async function landingViews(ctx: ToolContext, repo: string, branches: string[]) {
	const views = new Map<string, LandingView | null>();
	await Promise.all(
		[...new Set(branches)].map(async (branch) => {
			const view = await Promise.resolve()
				.then(() => ctx.landing?.(repo, branch).view())
				.catch(() => null);
			views.set(branch, view ?? null);
		}),
	);
	return views;
}

// A claim as the dashboard shows it: where its change stands, what needs a person, what it waits on, and how long it
// lasts if its agent goes quiet.
async function claimSnapshot(
	ctx: ToolContext,
	repo: string,
	state: Registry,
	votes: VotesView,
	released: ReleaseRecord[],
	record: ClaimRecord,
	landing: LandingView | null | undefined,
): Promise<ClaimSnapshot> {
	const claim = presentClaim(record, projectBranch(state));
	const { status, counted } = await changeState(ctx, repo, state, async () => votes.votes, claim.change, claim);
	const { head, approval, hosted, trusted } = status;
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
	if (trusted) snapshot.trusted = trusted;
	if (hosted) snapshot.hosted = hosted;
	if (attention) snapshot.attention = attention;
	if (waitsOn.length) snapshot.waitsOn = waitsOn;
	// How long it lasts if its agent goes quiet, worked out as status does. Advice: left out if it can't be.
	// From the votes changeState already counted, so no stamp is checked twice.
	const lease = await Promise.resolve()
		.then(async () => {
			const policy = branchSettings(state, claim.into).policy;
			return leaseFor(changeSigns({ claim, head, counted, record: votes, landing, policy }));
		})
		.catch((err: unknown) => {
			console.error(`working out ${claim.change}'s lease for the dashboard failed`, String(err));
			return undefined;
		});
	if (lease) snapshot.lease = lease;
	return snapshot;
}

// What needs a person on a claim: an open question, or a hosted builder that failed.
function attentionFor(flag: FlagRecord | null, hosted: HostedStatus | undefined, claim: ClaimRecord): Attention | null {
	if (flag) {
		const asked = { reason: flag.reason, agent: flag.agent, at: flag.at };
		return flag.urgency === undefined ? asked : { ...asked, urgency: flag.urgency };
	}
	if (hosted?.builder?.status !== "failed") return null;
	const error = hosted.builder.error ? `: ${hosted.builder.error.slice(0, 160)}` : "";
	return { reason: `GitHive's builder failed${error}`, agent: "githive-builder", at: claim.active };
}

/**
 * What a change waits on a person for, for the Inbox: its agent's question (or GitHive's failed builder), or, pushed
 * and not sent back, a vote as a role only people may vote as. Failed checks are its agent's to fix. The dashboard
 * decides the same (web/src/lib/status.ts, waitingOn).
 */
function waitingOnPerson(claim: ClaimSnapshot, votes: VoteRecord[], policy: ReviewPolicy): WaitingItem | null {
	const { change, attention, approval, head } = claim;
	const title = (claim.intent.split("\n")[0] ?? "").slice(0, 120);
	if (attention)
		return {
			kind: "question",
			change,
			title,
			reason: attention.reason.slice(0, 500),
			agent: attention.agent,
			at: attention.at,
			...(attention.urgency === undefined ? {} : { urgency: attention.urgency }),
		};
	if (!head || approval.approved || approval.vetoedBy.length) return null;
	const sentBack = votes.some(
		(vote) => vote.commit === head && vote.verdict === "reject" && vote.reviewer !== claim.agent,
	);
	if (sentBack || claim.hosted?.reviewers.some((reviewer) => reviewer.verdict === "reject")) return null;
	const role = (approval.awaiting ?? []).find((each) => peopleOnly(policy, each));
	if (!role) return null;
	// Since its agent last claimed or extended it: as near as the snapshot knows to when its head was pushed.
	return {
		kind: "vote",
		change,
		title,
		role,
		reason: `Waiting for a ${role} vote, which only a person can give.`,
		agent: claim.agent,
		at: claim.active,
	};
}

/**
 * The Inbox's order, so the 20 a summary keeps are what matters most: questions before votes, the most urgent first,
 * then the oldest. The dashboard sorts by urgency too (web/src/lib/inbox.ts).
 */
function inboxOrder(a: WaitingItem, b: WaitingItem) {
	const rank = (item: WaitingItem) => (item.kind === "vote" ? 1 : 0);
	return rank(a) - rank(b) || (b.urgency ?? 0) - (a.urgency ?? 0) || (a.at ?? "").localeCompare(b.at ?? "");
}

/** The number of claims in force, for the repo list; null before GitHive starts on the repo. */
export async function openCount(ctx: ToolContext, repo: string) {
	const state = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	if (!state?.baseline) return null;
	return (await storeFor(ctx, repo, state).read()).claims.length;
}
