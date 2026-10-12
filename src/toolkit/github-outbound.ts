import { type GitHubLink, withinMs } from "../github";
import { mirrorTo } from "./actions-checks";
import { type GitHubSeen, type GitHubSync, PR_BRANCH } from "./github-settings";
import type { BatchGit } from "./merge-types";

// GitHive's work going to a connected GitHub repo after each landing (see docs/github-prs.md). In mirror mode main
// goes to GitHub's main; in pr mode to githive/main, the standing pull request's head, which updates itself with no
// API call. Both are fast-forwards only: a refused push is logged, never forced. Then one read of GitHub's default
// branch says whether GitHub has commits GitHive's main lacks, and if so the repo's GitHubSync brings them back in
// steps of its own. None of it holds up the landing: it runs once the lease is handed on, and every failure is
// caught and logged.

/**
 * How long the read of GitHub's branch may take. It runs in the merging agent's request, after the landing, so a
 * GitHub that never answers would leave the agent with no answer.
 */
export const NOTICE_WITHIN_MS = 5_000;

export interface AfterLanding {
	gate: Pick<BatchGit, "pushBranch">;
	link: GitHubLink;
	sync: GitHubSync;
	/** The project's branch, which just landed `commit`. */
	branch: string;
	commit: string;
	/** Tells the repo's GitHubSync where GitHub's branch is. */
	notice?: (seen: GitHubSeen) => Promise<unknown>;
}

/** Pushes the landed branch to GitHub, then notices GitHub's branch if it may hold what main lacks. Never throws. */
export async function pushToGitHub(input: AfterLanding): Promise<void> {
	const { gate, link, sync, branch, commit } = input;
	const target = sync === "pr" ? PR_BRANCH : branch;
	const pushed = await mirrorTo(gate, link, branch, commit, sync === "pr" ? PR_BRANCH : undefined).then(
		() => true,
		(err) => {
			console.error(`pushing ${target} to ${link.repo} failed (someone pushed there?)`, String(err));
			return false;
		},
	);
	// A mirror that took the push has GitHub's main at main: nothing there main lacks.
	if (sync === "mirror" && pushed) return;
	await noticeGitHub(input).catch((err) =>
		console.error(`reading where ${link.repo}'s default branch is failed`, String(err)),
	);
}

// One read of GitHub's default branch, told to the repo's GitHubSync unless it's the commit just pushed.
async function noticeGitHub({ link, commit, notice }: AfterLanding) {
	if (!notice) return;
	const read = `${link.repo}'s default branch`;
	const { branch, head } = await withinMs(NOTICE_WITHIN_MS, read, (signal) => link.defaultHead(signal));
	if (head === commit) return;
	await notice({ github: link.repo, branch, commit: head });
}
