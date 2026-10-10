import { requiredString } from "../../errors";
import { projectBranch } from "../../project-branch";
import { Timing } from "../../timing";
import { audit } from "../audit";
import { scopeFile } from "../branch-scope";
import type { Registry } from "../claims";
import { mergeRecordOf, readMainMerges, readRecordHistory, readRefHistories, readShardHistories } from "../git-records";
import { revertViolation } from "../revert";
import { votesPrefix } from "../vote-store";
import type { Votes } from "../votes";
import type { ToolContext, ToolHandlers } from "./context";
import { claimsRef, DEFAULT_POLICY, votesRef } from "./repo";

// The audit and revert tools, and the audit run they share with the dashboard.

/** Replays a repo's records from Git: the merges since GitHive started on it, and every broken convention. */
export async function runAudit(ctx: ToolContext, repo: string) {
	const t = ctx.timing ?? new Timing();
	const remote = await t.time("token", () => ctx.remote(repo, "read"));
	// The votes don't depend on the registry, so read them in parallel.
	const votesRead = t.time("votes", () => readRecordHistory<Votes>(remote, votesRef(repo)));
	votesRead.catch(() => undefined);
	const registry = await t.time("registry", () => readRecordHistory<Registry>(remote, claimsRef(repo)));
	const baseline = registry[0]?.state.baseline;
	if (!baseline) throw new Error(`[409] GitHive hasn't started on ${repo}`);
	const start = registry[0].state;
	// Whether claims are sharded, from the start or later, is in the latest state.
	const latest = registry.at(-1)!.state;
	// Read with git in the repo's Gate when there is one: reading many merges in memory exhausts a Worker.
	const branchMerges = (from: string, branch: string) =>
		ctx.readBranch
			? ctx.readBranch(repo, from, branch).then((commits) => commits.map(mergeRecordOf))
			: readMainMerges(remote, from, branch);
	const [merges, shards, votesHistory] = await Promise.all([
		t.time("merges", () => branchMerges(baseline, projectBranch(start))),
		latest.shardDepth
			? t.time("shards", async () =>
					readShardHistories(
						latest.recordsRepos && ctx.recordsRemote
							? await Promise.all(
									Array.from({ length: latest.recordsRepos }, (_, k) => ctx.recordsRemote!(repo, k, "read")),
								)
							: [remote],
						repo,
					),
				)
			: undefined,
		votesRead,
	]);
	// Once votes are sharded, their buckets are where the latest state says.
	const votesNow = votesHistory.at(-1)?.state;
	const voteBuckets = votesNow?.buckets
		? await t.time("buckets", async () =>
				readRefHistories<Votes>(
					votesNow.recordsRepos && ctx.recordsRemote
						? await Promise.all(
								Array.from({ length: votesNow.recordsRepos }, (_, k) => ctx.recordsRemote!(repo, k, "read")),
							)
						: [remote],
					votesPrefix(repo),
				),
			)
		: undefined;
	// Merges on other branches, each read from where it started, with files named as their claims name them.
	const project = projectBranch(start);
	const onBranches = (
		await t.time("branches", () =>
			Promise.all(
				Object.entries(latest.branches ?? {}).map(async ([name, record]) =>
					(await branchMerges(record.base, name)).map((m) => ({
						...m,
						branch: name,
						claimFiles: m.files.map((f) => scopeFile(f, name, project)),
					})),
				),
			),
		)
	).flat();
	const all = [...merges, ...onBranches];
	const violations = await t.time("audit", () =>
		audit({
			registry,
			...(shards ? { shards } : {}),
			votes: votesHistory,
			...(voteBuckets ? { voteBuckets } : {}),
			policy: start.policy ?? DEFAULT_POLICY,
			verify: start.verify,
			merges: all,
		}),
	);
	return { merges: all.length, violations };
}

export const auditTools: ToolHandlers = {
	async audit({ ctx, repo }) {
		const { merges, violations } = await runAudit(ctx, repo);
		return { merges, open: violations.filter((v) => !v.resolvedBy).length, violations };
	},
	async revert({ args, ctx, repo, write, claims, votes, registered, actAs, stamper }) {
		const { violations } = await runAudit(ctx, repo);
		return revertViolation({
			remote: await write(),
			branch: projectBranch(registered),
			claims,
			votes,
			stamper,
			target: requiredString(args, "commit"),
			violations,
			agent: actAs("agent"),
		});
	},
};
