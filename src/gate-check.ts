// How a change's Gate puts together the code it checks: the project's branch with the batch's changes merged onto
// it in order.
import { run } from "./container";
import { checkoutDetached, fetchChanges, missingCommits, requireBase } from "./gate-git";
import type { CheckPlan } from "./gate-types";

/**
 * Fetches the project's branch and the batch's changes, then merges the changes onto `baseHead` in order, ending with
 * `head`. Returns the conflicting files if a change doesn't merge.
 */
export async function mergeForCheck(container: Container, head: string, plan: CheckPlan) {
	await fetchForCheck(container, head, plan);
	await checkoutDetached(container, plan.baseHead);
	return mergeInOrder(container, [...(plan.ahead ?? []).map((a) => a.head), head]);
}

/** Fetches the project's branch and the batch's changes, throwing unless every commit to merge is there. */
async function fetchForCheck(container: Container, head: string, plan: CheckPlan) {
	const branch = plan.branch ?? "main";
	await requireBase(container, plan.base, branch);
	// Fetch the batch's changes together, since fetching them one at a time dominated a large batch's check. Fetch
	// branches rather than bare commits, because fetching a hash depends on server settings. A reused container has
	// most of them already, so only missing commits are fetched.
	const sources = [
		...(plan.ahead ?? []).map((a) => ({ remote: a.remote, token: a.token, ref: a.ref ?? branch })),
		plan.fork,
	];
	const commits = [...(plan.ahead ?? []).map((a) => a.head), head];
	const absent = await missingCommits(container, commits);
	const failed = await fetchChanges(
		container,
		absent.map((k) => ({ k, ...sources[k] })),
	);
	for (const [k, why] of failed)
		throw new Error(`fetch of ${k === sources.length - 1 ? "the change" : "a change in the batch"} failed: ${why}`);
	const missing = await missingCommits(container, commits);
	if (missing.length)
		throw new Error(`approved commits not on their branches: ${missing.map((k) => commits[k]).join(", ")}`);
}

/** Merges the commits onto the checkout in order. Returns the conflicting files of the first that doesn't merge. */
async function mergeInOrder(container: Container, commits: string[]): Promise<string[] | undefined> {
	for (const commit of commits) {
		const merge = await run(container, [
			"git",
			"-c",
			"user.name=gate",
			"-c",
			"user.email=gate@githive.invalid",
			"merge",
			"-q",
			"--no-edit",
			commit,
		]);
		if (merge.exitCode !== 0) {
			const conflicts = await run(container, ["git", "diff", "--name-only", "--diff-filter=U"]);
			await run(container, ["git", "merge", "--abort"]);
			return conflicts.output.split("\n").filter(Boolean);
		}
	}
	return undefined;
}
