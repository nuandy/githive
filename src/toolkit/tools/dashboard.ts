import git from "isomorphic-git";
import { Workspace } from "../../git";
import { projectBranch } from "../../project-branch";
import { Timing } from "../../timing";
import { claimInto, presentClaim } from "../branch-scope";
import { DEFAULT_SKIP_CHECKS } from "../check-scope";
import type { ClaimRecord, Registry } from "../claims";
import type { VoteStore } from "../vote-store";
import { approval, DEFAULT_GRANT, openFlag, type ReviewPolicy, type VoteRecord } from "../votes";
import { holdKey, ROLE_WAIT_MS, waitingRoleReviews } from "../work";
import { runAudit } from "./audit-tools";
import { changeHead, changeSourceFor, changeStatus } from "./change-state";
import { targetBranch } from "./claim-input";
import type { ToolContext } from "./context";
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
	const seen = await ctx.reviews.waits(
		repo,
		waiting.map((w) => holdKey(w.head, w.role)),
	);
	let told = false;
	for (const w of waiting) {
		const key = holdKey(w.head, w.role);
		const since = seen[key];
		if (!since || since.told || Date.now() - since.since < ROLE_WAIT_MS) continue;
		const holders = policy.grants?.[w.role] ?? DEFAULT_GRANT;
		const people = holders.some((h) => h.startsWith("person:"));
		const minutes = Math.round((Date.now() - since.since) / 60_000);
		const reason = `${w.change}'s ${w.role} review has waited ${minutes} minutes and none of its holders (${holders.join(", ")}) has taken it. ${people ? `You can review it as ${w.role} from the dashboard.` : `No person holds ${w.role}, so you can't sign it off: nudge its holders, or grant it to more.`}`;
		await votes.flag({ change: w.change, agent: "githive", role: w.role, reason });
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
	const t = ctx.timing ?? new Timing();
	const registry = (await t.time("registry", () => recordLog<Registry>(ctx, repo, claimsRef(repo)).read()))?.commit
		.state;
	if (!registry?.baseline) throw new Error(`[404] GitHive hasn't started on ${repo}`);
	const { claim: record, released } = await t.time("change", () => storeFor(ctx, repo, registry).readChange(change));
	if (!record && !released.length) throw new Error(`[404] no change ${change} on ${repo}`);
	// The change's own commits are those since it left the branch it lands on.
	const branch = record ? claimInto(record, projectBranch(registry)) : projectBranch(registry);
	const claim = record ? presentClaim(record, projectBranch(registry)) : undefined;
	const mergedAs = released.find((r) => r.mergedAs)?.mergedAs;
	const commits = await Promise.resolve()
		.then(() =>
			t.time("fork", () => changeSourceFor(ctx, repo)(claim?.agent ?? released.at(-1)!.agent, "read", change)),
		)
		.then(async (source) => {
			// Shallow: a change is a few commits on a recent head, and finding the merge base deepens it if needed.
			const ws = await t.time("clone", () => Workspace.clone(source, `changes/${change}`, { depth: 8 }));
			const head = await ws.head();
			// For a merged change, its base is found from the merge's first parent, not the branch's current head.
			const projectHead = await t.time("project", async () =>
				ws.fetch("project", await ctx.remote(repo, "read"), branch),
			);
			const before = mergedAs ? (await ws.ensureCommit(mergedAs)).commit.parent[0] : projectHead;
			const stop = await t.time("base", () => ws.mergeBase(before, head));
			const own = [];
			for (const { oid, commit } of await git.log({ fs: ws.fs, dir: "/repo", ref: head, depth: 50 })) {
				if (oid === stop) break;
				own.push({
					commit: oid,
					message: commit.message.trim(),
					author: commit.author.name,
					at: new Date(commit.author.timestamp * 1000).toISOString(),
				});
			}
			return own;
		})
		// Nothing pushed yet (no fork, or no branch on it).
		.catch(() => [] as { commit: string; message: string; author: string; at: string }[]);
	const ids = new Set(commits.map((c) => c.commit));
	const votes = (await votesFor(ctx, repo).readFor([...ids])).votes.filter((v) => ids.has(v.commit));
	return { change, branch, claim: claim ?? null, released, commits, votes };
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
	const open = violations.filter((v) => !v.resolvedBy).length;
	await ctx.summarize?.(repo, { merged: merges, violations: open }).catch(() => undefined);
	return { merges, open, violations };
}

/** The dashboard's view of a repo, read from the records' tips. The audit is separate (see repoAudit). */
export async function repoSnapshot(ctx: ToolContext, repo: string) {
	const t = ctx.timing ?? new Timing();
	const [registry, votes] = await t.time("records", () =>
		Promise.all([recordLog<Registry>(ctx, repo, claimsRef(repo)).read(), votesFor(ctx, repo).read()]),
	);
	const state = registry?.commit.state;
	if (!state?.baseline) throw new Error(`[404] GitHive hasn't started on ${repo}`);
	const held = await t.time("claims", () => storeFor(ctx, repo, state).read());
	const claims = await t.time("status", () =>
		Promise.all(
			held.claims.map(async (record) => {
				const c = presentClaim(record, projectBranch(state));
				const { head, approval, hosted } = await changeStatus(ctx, repo, state, async () => votes.votes, c.change, c);
				// A question stays open until a person votes on the change's commit. For a waiting role's review,
				// it closes once that role signs off.
				const asked = openFlag(votes, c.change, head);
				const flag = asked?.role && !approval.awaiting?.includes(asked.role) ? null : asked;
				const attention = flag
					? { reason: flag.reason, agent: flag.agent, at: flag.at }
					: hosted?.builder?.status === "failed"
						? {
								reason: `GitHive's builder failed${hosted.builder.error ? `: ${hosted.builder.error.slice(0, 160)}` : ""}`,
								agent: "githive-builder",
								at: c.active,
							}
						: null;
				// Dependencies not yet merged into the branch this change lands on.
				const into = c.into ?? projectBranch(state);
				const waitsOn = (c.after ?? []).filter(
					(dep) =>
						!held.released.some((r) => r.change === dep && r.mergedAs && (r.into ?? projectBranch(state)) === into),
				);
				return {
					...c,
					head,
					approval,
					...(hosted ? { hosted } : {}),
					...(attention ? { attention } : {}),
					...(waitsOn.length ? { waitsOn } : {}),
				};
			}),
		),
	);
	const waiting = claims.filter((c) => c.attention);
	await ctx
		.summarize?.(repo, {
			open: claims.length,
			needsYou: waiting.length,
			waiting: waiting.slice(0, 20).map((c) => ({
				change: c.change,
				title: c.intent.split("\n")[0].slice(0, 120),
				reason: c.attention!.reason.slice(0, 500),
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
		branches: Object.entries(state.branches ?? {}).map(([name, b]) => ({
			name,
			base: b.base,
			...(b.from ? { from: b.from } : {}),
			at: b.at,
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

/** The number of claims in force, for the repo list; null before GitHive starts on the repo. */
export async function openCount(ctx: ToolContext, repo: string) {
	const state = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	if (!state?.baseline) return null;
	return (await storeFor(ctx, repo, state).read()).claims.length;
}
