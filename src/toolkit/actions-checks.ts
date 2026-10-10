import type { GitHubLink, WorkflowRun } from "../github";
import type { BatchGit, CheckResult, CheckRunner } from "./merge";

// Checks on GitHub Actions, for a GitHive repo connected to a GitHub repo
// (settings github, with verify ["github-actions"]): no check container runs
// them. A batch's changes are merged onto main the way it will land, in the
// repo's Gate (real git, see BatchGit.checksBranch), and that commit is
// pushed to githive/checks/<id> on GitHub. The repo's workflows run on pushes
// to githive/checks/** (see the workflow in docs/design.md); GitHive waits
// for every run on that commit, and the batch passes when they all succeed.
// The branch is deleted after. And main is pushed back to GitHub after every
// landing (mirrorTo), so GitHub stays the copy people browse.

/** The checks setting that runs them on GitHub Actions rather than in containers. */
export const ACTIONS = "github-actions";
export const onActions = (verify: string[] | undefined) => !!verify?.includes(ACTIONS);

/** How long a batch's runs may take before it counts as failed, how often GitHive looks, and how long a run may take to show up. */
const RUNS_WITHIN_MS = 30 * 60_000;
const POLL_MS = 10_000;
const FIRST_RUN_WITHIN_MS = 3 * 60_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A check runner on GitHub Actions: `gate` builds and pushes the batch's commit (the repo's Gate), `link` is the connected GitHub repo. */
export function actionsChecks(
	gate: Pick<BatchGit, "checksBranch">,
	link: GitHubLink,
	timing: { pollMs?: number; firstRunWithinMs?: number; runsWithinMs?: number } = {},
): CheckRunner {
	return async ({ base, branch, changes, gate: id }) => {
		const name = `githive/checks/${id ?? crypto.randomUUID().slice(0, 12)}`;
		// The batch merged onto main as it will land, each change as its own merge, pushed to GitHub for its workflows.
		const made = await gate
			.checksBranch({ base, branch, changes, to: link.remote, ref: name })
			.catch((err) => ({ failed: String(err) }));
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
							output: `no workflow ran on ${name} (${made.tip}) in ${link.repo}: add one that runs on pushes to githive/checks/** (see GitHive's docs)`,
						},
					],
				};
			const results: CheckResult[] = runs.map((r) => ({
				command: `GitHub Actions: ${r.name}`,
				exitCode: passing(r) ? 0 : 1,
				output: `${r.conclusion ?? r.status}: ${r.url}`,
			}));
			return { passed: results.every((r) => r.exitCode === 0), results };
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

/**
 * The workflow runs on `sha` once they're all completed: none if none showed
 * up in time; a run still going past the limit is returned as it is (it fails).
 */
async function finishedRuns(
	link: GitHubLink,
	sha: string,
	timing: { pollMs?: number; firstRunWithinMs?: number; runsWithinMs?: number },
) {
	const started = Date.now();
	for (;;) {
		const runs = await link.runsFor(sha);
		const waited = Date.now() - started;
		if (runs.length && runs.every((r) => r.status === "completed")) return runs;
		if (!runs.length && waited > (timing.firstRunWithinMs ?? FIRST_RUN_WITHIN_MS)) return [];
		if (waited > (timing.runsWithinMs ?? RUNS_WITHIN_MS))
			return runs.map((r) => (r.status === "completed" ? r : { ...r, conclusion: "timed_out" }));
		await sleep(timing.pollMs ?? POLL_MS);
	}
}

/**
 * Push `branch` as it is on GitHive (at `head`) to the connected GitHub repo,
 * from the repo's Gate, as a fast-forward only: GitHub keeps a copy, and
 * GitHive never overwrites what someone pushed there directly (refused, it's
 * reported, not forced).
 */
export function mirrorTo(gate: Pick<BatchGit, "pushBranch">, link: GitHubLink, branch: string, head: string) {
	return gate.pushBranch({ branch, head, to: link.remote });
}
