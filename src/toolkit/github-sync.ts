import type { GitHubLink } from "../github";
import type { BatchGit } from "./merge";

// What lands goes back to the connected GitHub repo after each landing. By default as a pull request: GitHive's branch
// is pushed to githive/<branch> there, and one pull request into <branch> is kept open, for people or GitHub's
// auto-merge to merge, so the repo's branch protection and CI apply. A repo can choose "push" instead, and have
// <branch> itself fast-forwarded. Either way nothing on GitHub is overwritten: a push that isn't a fast-forward is
// refused.

/** How landed work reaches the GitHub repo's branch: through a pull request, or pushed to it directly. */
export type GitHubMain = "pr" | "push";

/** The branch on GitHub that carries GitHive's `branch`, for the pull request into it. */
export const mirrorBranch = (branch: string) => `githive/${branch}`;

/** What the pull request says, and why it must be merged with a merge commit. */
export function pullRequestText(branch: string) {
	return {
		title: `GitHive: what agents landed on ${branch}`,
		body: [
			`What agents landed on ${branch} through GitHive, each change reviewed and checked as the repo's settings ` +
				"ask. Every merge commit says why its change was made and who approved it.",
			"",
			`GitHive keeps this pull request up to date as more lands. Merge it with **Create a merge commit**: ` +
				"squashing or rebasing rewrites these commits, and the next pull request would show them again.",
		].join("\n"),
	};
}

/**
 * Sends `head`, just landed on `branch`, to the GitHub repo: to its githive/<branch> with a pull request open into
 * `branch`, or straight to `branch`. A push GitHub refuses throws, for the caller to log.
 */
export async function syncToGitHub(
	gate: Pick<BatchGit, "pushBranch">,
	link: GitHubLink,
	branch: string,
	head: string,
	main: GitHubMain = "pr",
) {
	const target = main === "push" ? branch : mirrorBranch(branch);
	await gate.pushBranch({ branch: target, head, to: link.remote });
	if (main === "push") return;
	await link.openPullRequest({ head: target, base: branch, ...pullRequestText(branch) });
}
