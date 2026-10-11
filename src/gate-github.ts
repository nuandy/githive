// How the repo's own Gate brings a GitHub branch into the project (see docs/github-prs.md, "Inbound"): it fetches
// GitHub's branch and, unless the project's branch has it already, writes it to the project as github/<branch>, the
// source of the change githive-github then claims and merges. Only the toolkit writes that branch, never an agent.
//
// A squash or rebase merge of GitHive's pull request gives GitHive's commits new ids, so git's own merge base for
// GitHub's commit is GitHub's branch from before the pull request, and merging it would set the pull request's own
// lines against what landed on GitHive since: conflicts, for work GitHub already has. So the Gate finds the newest
// commit of GitHive's main whose tree a commit on GitHub's branch has, the work GitHub took, and joins GitHub's
// commit to it: a commit with GitHub's tree and both as parents. Merging that brings in only what GitHub added since.
// A merge commit needs no joining: GitHive's commit is already one of its parents.
import { WORKDIR, clip, gitWithToken, run } from "./container";
import type { BatchBase } from "./gate-types";
import { BOT } from "./git";

/** How far back each side's first-parent history is searched for the work GitHub took. */
const MAIN_SEARCHED = 1_000;
const GITHUB_SEARCHED = 500;

export interface GitHubImport {
	/** GitHub's repo, its credentials as the App gives them. */
	from: { remote: string; token: string; user?: string };
	/** GitHub's branch to bring in. */
	githubBranch: string;
	/** The project's branch to write it to: github/<branch>. */
	as: string;
}

/**
 * The outcome: GitHub's head is on the project's branch already (known), or it was written to `as` (head: GitHub's
 * commit, or the commit joining it to `base`, the newest of GitHive's commits whose work GitHub had), or why not.
 */
export type GitHubImportResult =
	{ known: string } | { commit: string; head: string; base: string } | { failed: string };

const SHA = /^[0-9a-f]{40}$/;

/** Brings GitHub's branch into the project as `as`, once the checkout has the project's branch at `baseHead`. */
export async function importFromGitHub(
	container: Container,
	input: BatchBase & GitHubImport,
): Promise<GitHubImportResult> {
	const { from, githubBranch, as, baseHead: main } = input;
	const fetched = await gitWithToken(
		container,
		from.token,
		["fetch", "-q", "--no-tags", from.remote, `+refs/heads/${githubBranch}:refs/remotes/github/${githubBranch}`],
		WORKDIR,
		from.user,
	);
	if (fetched.exitCode !== 0)
		return { failed: `fetching GitHub's ${githubBranch} failed: ${clip(fetched.output, 500)}` };
	const git = async (...args: string[]) => (await run(container, ["git", ...args])).output.trim();
	const isAncestor = async (ancestor: string, of: string) =>
		(await run(container, ["git", "merge-base", "--is-ancestor", ancestor, of])).exitCode === 0;
	const head = await git("rev-parse", `refs/remotes/github/${githubBranch}`);
	if (!SHA.test(head)) return { failed: `GitHub's ${githubBranch} couldn't be read: ${clip(head, 300)}` };
	if (await isAncestor(head, main)) return { known: head };
	const mergeBase = await git("merge-base", main, head);
	if (!SHA.test(mergeBase))
		return { failed: `GitHub's ${githubBranch} shares no history with ${input.branch}: GitHive can't bring it in` };
	const took = await workTaken(git, main, head, mergeBase);
	const base = took?.main ?? mergeBase;
	const joined = took && !(await isAncestor(took.main, head)) && took.tree !== (await treeOf(git, mergeBase));
	const tip = joined ? await joinedCommit(container, { head, base, githubBranch, branch: input.branch }) : head;
	if (!SHA.test(tip))
		return { failed: `joining GitHub's ${githubBranch} to ${input.branch} failed: ${clip(tip, 300)}` };
	const pushed = await gitWithToken(container, input.base.token, [
		"push",
		"-q",
		"--force",
		input.base.remote,
		`${tip}:refs/heads/${as}`,
	]);
	if (pushed.exitCode !== 0) return { failed: `writing ${as} failed: ${clip(pushed.output, 500)}` };
	return { commit: head, head: tip, base };
}

type Git = (...args: string[]) => Promise<string>;

const treeOf = (git: Git, commit: string) => git("rev-parse", `${commit}^{tree}`);

// Each commit on `ref`'s first-parent history since `since` (and `since` itself), newest first, with its tree.
async function chain(git: Git, ref: string, since: string, most: number) {
	const listed = await git("log", "--first-parent", `--max-count=${most}`, "--format=%H %T", ref, `^${since}`);
	const commits = listed
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split(" ") as [string, string]);
	return [...commits, [since, await treeOf(git, since)] as [string, string]];
}

// The newest commit of GitHive's main whose tree is also on GitHub's branch: the work GitHub took, by whatever
// merge. Null when GitHub has no tree of GitHive's since the merge base.
async function workTaken(git: Git, main: string, head: string, mergeBase: string) {
	const ours = new Map<string, string>();
	for (const [commit, tree] of await chain(git, main, mergeBase, MAIN_SEARCHED))
		if (!ours.has(tree)) ours.set(tree, commit);
	for (const [, tree] of await chain(git, head, mergeBase, GITHUB_SEARCHED)) {
		const commit = ours.get(tree);
		if (commit) return { main: commit, tree };
	}
	return null;
}

// A commit with GitHub's tree whose parents are GitHub's commit and GitHive's `base`. Its dates are GitHub's
// commit's, so making it again makes the same commit.
async function joinedCommit(
	container: Container,
	at: { head: string; base: string; githubBranch: string; branch: string },
) {
	const short = (commit: string) => commit.slice(0, 8);
	const message = [
		`Join GitHub's ${at.githubBranch} at ${short(at.head)} to ${at.branch} at ${short(at.base)}`,
		"",
		`GitHub's ${at.githubBranch} took GitHive's work up to ${short(at.base)} by a merge that gave its commits new ids ` +
			"(a squash or a rebase). This commit has GitHub's files and both as parents, so merging it brings in only " +
			"what GitHub added since.",
	].join("\n");
	const script =
		`d=$(git show -s --format=%cI ${at.head}) && GIT_AUTHOR_DATE="$d" GIT_COMMITTER_DATE="$d" ` +
		`GIT_AUTHOR_NAME="${BOT.name}" GIT_AUTHOR_EMAIL="${BOT.email}" GIT_COMMITTER_NAME="${BOT.name}" ` +
		`GIT_COMMITTER_EMAIL="${BOT.email}" git commit-tree ${at.head}^{tree} -p ${at.head} -p ${at.base} -F -`;
	return (await run(container, ["bash", "-c", script], WORKDIR, message)).output.trim();
}
