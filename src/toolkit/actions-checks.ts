import type { GitHubLink, WorkflowRun } from "../github";
import { conflictLine } from "./landing";
import type { BatchGit, CheckResult, CheckRunner } from "./merge";
import type { Unlanded } from "./merge-types";
import { BATCH_MERGE } from "./merge-checks";
import { sleep } from "../retry";

// Checks on GitHub Actions, for a repo connected to GitHub with verify ["github-actions"]. The Gate merges a
// batch onto main as it will land and pushes that commit to githive/checks/<id>, where the repo's workflows run.
// The batch passes when every run on the commit succeeds. After each landing, main is pushed back to GitHub
// so it stays the copy people browse.

/** The verify setting that runs checks on GitHub Actions instead of in containers. */
export const ACTIONS = "github-actions";
export const onActions = (verify: string[] | undefined) => !!verify?.includes(ACTIONS);

const RUNS_WITHIN_MS = 30 * 60_000;
const POLL_MS = 10_000;
const FIRST_RUN_WITHIN_MS = 3 * 60_000;

/** A check runner that runs each batch on the connected GitHub repo's workflows. */
export function actionsChecks(
	gate: Pick<BatchGit, "checksBranch">,
	link: GitHubLink,
	timing: { pollMs?: number; firstRunWithinMs?: number; runsWithinMs?: number } = {},
): CheckRunner {
	return async ({ base, branch, changes, gate: id }) => {
		const name = `githive/checks/${id ?? crypto.randomUUID().slice(0, 12)}`;
		// Merge each change onto main as its own merge commit, as the batch will land.
		const made = await gate
			.checksBranch({ base, branch, changes, to: link.remote, ref: name })
			.catch((err): Unlanded => ({ failed: String(err) }));
		// A change that doesn't merge onto the batch fails it as the Gate's checks do, so it's put out for its conflict.
		if ("failed" in made && made.conflict?.files.length) {
			const { files } = made.conflict;
			const merging = { command: BATCH_MERGE, exitCode: 1, output: conflictLine(files, []) };
			return { passed: false, results: [merging], conflict: { files } };
		}
		if ("failed" in made)
			return { passed: false, results: [{ command: "(merging the batch)", exitCode: 1, output: made.failed }] };
		try {
			const runs = await finishedRuns(link, made.tip, timing);
			if (!runs.length)
				return {
					passed: false,
					results: [
						{
							command: "GitHub Actions",
							exitCode: 1,
							output:
								`no workflow ran on ${name} (${made.tip}) in ${link.repo}: add one that runs ` +
								"on pushes to githive/checks/** (see GitHive's docs)",
						},
					],
				};
			const results: CheckResult[] = runs.map((run) => ({
				command: `GitHub Actions: ${run.name}`,
				exitCode: passing(run) ? 0 : 1,
				output: `${run.conclusion ?? run.status}: ${run.url}`,
			}));
			return { passed: results.every((result) => result.exitCode === 0), results };
		} finally {
			await link
				.deleteBranch(name)
				.catch((err) => console.error(`deleting ${name} on ${link.repo} failed`, String(err)));
		}
	};
}

const passing = (run: WorkflowRun) =>
	run.status === "completed" &&
	(run.conclusion === "success" || run.conclusion === "skipped" || run.conclusion === "neutral");

// Waits for every workflow run on `sha` to complete. Returns none if no run appears in time, and marks
// runs still going at the limit as timed out.
async function finishedRuns(
	link: GitHubLink,
	sha: string,
	timing: { pollMs?: number; firstRunWithinMs?: number; runsWithinMs?: number },
) {
	const started = Date.now();
	for (;;) {
		const runs = await link.runsFor(sha);
		const waited = Date.now() - started;
		if (runs.length && runs.every((run) => run.status === "completed")) return runs;
		if (!runs.length && waited > (timing.firstRunWithinMs ?? FIRST_RUN_WITHIN_MS)) return [];
		if (waited > (timing.runsWithinMs ?? RUNS_WITHIN_MS))
			return runs.map((run) => (run.status === "completed" ? run : { ...run, conclusion: "timed_out" }));
		await sleep(timing.pollMs ?? POLL_MS);
	}
}

/**
 * Fast-forwards `branch` on the connected GitHub repo to `head`, or `as` (githive/main, say) to the project's `branch`
 * at `head`. A commit someone pushed there directly is never overwritten; the refused push is reported instead.
 */
export function mirrorTo(
	gate: Pick<BatchGit, "pushBranch">,
	link: GitHubLink,
	branch: string,
	head: string,
	as?: string,
) {
	return gate.pushBranch({ branch, head, to: link.remote, ...(as ? { as } : {}) });
}
