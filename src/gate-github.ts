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
//
// When GitHub's branch had commits of its own before it squashed or rebased, no tree is GitHive's, so the base found
// can be older than the work GitHub took, and merging from it would bring back what GitHive changed since, such as a
// file it deleted. Unless the import can show that can't happen, it comes back untrusted, for people to review.
import { WORKDIR, clip, gitWithToken, run } from "./container";
import type { BatchBase } from "./gate-types";
import { BOT } from "./git";

/** How far back each side's first-parent history is searched for the work GitHub took. */
const MAIN_SEARCHED = 1_000;
const GITHUB_SEARCHED = 500;

/**
 * A fetch from GitHub is given this long, and tried this many times when its transport fails. Its own Gate holds up no
 * landing while it runs, but the job's alarm waits on it.
 */
const GITHUB_FETCH_S = 120;
const GITHUB_FETCH_TRIES = 2;

/** The Gate that brings a repo's GitHub branch in (see Gate.importGitHub): its own, so batches never wait on GitHub. */
export const githubGate = (repo: string) => `repo:${repo}:github`;

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
 * commit, or the commit joining it to `base`, the newest of GitHive's commits whose work GitHub had, and `untrusted`:
 * why it needs review), or why not.
 */
export type GitHubImportResult =
	{ known: string } | { commit: string; head: string; base: string; untrusted?: string } | { failed: string };

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
		GITHUB_FETCH_S,
		GITHUB_FETCH_TRIES,
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
	// The merge sets GitHub's commit against the join's base, or git's own.
	const untrusted = await doubtedBase(git, { main, head, base: joined ? base : mergeBase });
	// The join's commits go into a shell script: both must be commit ids, whatever a later caller passes.
	if (joined && !SHA.test(base)) return { failed: `joining GitHub's ${githubBranch} found no commit to join: ${base}` };
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
	return { commit: head, head: tip, base, ...(untrusted ? { untrusted } : {}) };
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
// merge. Null when GitHub has no tree of GitHive's since the merge base. Newest on main's side, not on GitHub's: a
// GitHub commit that goes back to an older state of GitHive's (a revert of what a squash took, say) is GitHub's own
// change, made after it took the newer one, and must come back as one rather than read as the older one taken.
async function workTaken(git: Git, main: string, head: string, mergeBase: string) {
	// Each tree on main's side, with its newest commit and how far back that is (0 the newest).
	const ours = new Map<string, { commit: string; back: number }>();
	(await chain(git, main, mergeBase, MAIN_SEARCHED)).forEach(([commit, tree], back) => {
		if (!ours.has(tree)) ours.set(tree, { commit, back });
	});
	let taken: { commit: string; back: number; tree: string } | null = null;
	for (const [, tree] of await chain(git, head, mergeBase, GITHUB_SEARCHED)) {
		const ourCommit = ours.get(tree);
		if (ourCommit && (!taken || ourCommit.back < taken.back)) taken = { ...ourCommit, tree };
	}
	return taken && { main: taken.commit, tree: taken.tree };
}

/** How many of the paths both sides changed a doubted import names. */
const DOUBTED_SHOWN = 5;

// Why merging `head` from `base` may bring back what GitHive changed since, or undefined when it can't. It can't
// when each of GitHub's commits that main lacks sits straight on main: a squash or rebase there would have GitHive's
// files exactly, and been found, so these are GitHub's own. Nor when GitHub changed no path GitHive changed after
// `base`. Otherwise a squash or rebase may have taken GitHive's newer work under new ids, and the base is in doubt.
async function doubtedBase(git: Git, at: { main: string; head: string; base: string }) {
	if (await onMain(git, at)) return undefined;
	const theirs = lines(await git("diff", "--name-only", "--no-renames", at.base, at.head));
	const changedSince = ["log", "--format=", "--name-only", "--no-renames", `${at.base}..${at.main}`];
	const ours = new Set(lines(await git(...changedSince)));
	const both = theirs.filter((path) => ours.has(path));
	if (!both.length) return undefined;
	const more = both.length > DOUBTED_SHOWN ? ` and ${both.length - DOUBTED_SHOWN} more` : "";
	const shown = `${both.slice(0, DOUBTED_SHOWN).join(", ")}${more}`;
	return (
		"GitHub's commits sit on commits of its own that GitHive doesn't have, as after a squash or rebase onto a " +
		`branch that had moved on, and change ${shown}, which GitHive changed after ${at.base.slice(0, 8)}: GitHive ` +
		"can't tell which of its work GitHub took, so merging could bring back what GitHive changed since"
	);
}

// Whether each of GitHub's commits that main lacks has only parents on main: none is on another of them.
async function onMain(git: Git, at: { main: string; head: string }) {
	const listed = await git("rev-list", "--parents", `--max-count=${GITHUB_SEARCHED}`, at.head, `^${at.main}`);
	const commits = lines(listed).map((line) => line.split(" "));
	// As many as were searched: there may be more, so it can't say.
	if (commits.length >= GITHUB_SEARCHED) return false;
	const lacked = new Set(commits.map(([commit]) => commit));
	return commits.every(([, ...parents]) => parents.every((parent) => !lacked.has(parent)));
}

const lines = (output: string) => output.split("\n").filter(Boolean);

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
