import { projectBranch } from "../project-branch";
import { GitCasLog } from "../record-log";
import { readBranchHistory } from "./branch-history";
import type { Registry } from "./claims";
import { type BranchCommit, readBranchCommits, trailer } from "./git-records";
import { type ToolContext, votesFor } from "./mcp";
import { fail } from "../errors";

// A branch's landed changes for the dashboard's History tab: each merge GitHive made, with its intent and reviews.
// It's read from Git alone, so it tells the same story as `git log` and the audit.

/** A review of a landed change's head. */
export interface HistoryReview {
	reviewer: string;
	role: string;
	verdict: "approve" | "reject";
	evidence: string;
}

export interface LandedChange {
	/** The merge commit. */
	commit: string;
	change: string;
	agent: string;
	/** The change's commit that landed. */
	head: string;
	/** The merge's subject: its intent, or "Merge <change> by <agent>" for older merges without one. */
	title: string;
	intent?: string;
	/** The files its merge changed: the first FILES_MOST of them, in git's order. */
	files: string[];
	/** How many files its merge changed: more than `files` lists when that's cut short. */
	filesTotal: number;
	/**
	 * Commits that aren't landed changes (pushed with plain git, a revert) reached the branch after it. History lists
	 * neither them nor their files, so a file it lists may have changed since. Only `branchHistory` says.
	 */
	unlistedSince?: true;
	reviews: HistoryReview[];
	/** When it landed, while the repo's landing still recalls it. */
	at?: string;
}

export interface BranchHistory {
	branch: string;
	/** How many changes have landed since GitHive started on the branch. */
	total: number;
	/** Newest first, at most HISTORY_MOST. */
	changes: LandedChange[];
}

/** How many landed changes one reply lists. */
export const HISTORY_MOST = 200;
// How many of a change's files one entry lists.
const FILES_MOST = 20;

// The branch's commits since GitHive started on it, or since it was made, oldest first.
async function branchCommits(ctx: ToolContext, repo: string, registry: Registry, branch: string) {
	const from = branch === projectBranch(registry) ? registry.baseline : registry.branches?.[branch]?.base;
	if (!from) fail(404, `GitHive lands nothing on ${branch}`);
	if (ctx.readBranch) return ctx.readBranch(repo, from, branch);
	if (ctx.history) return ctx.history(repo, (source) => readBranchHistory(source, from, branch));
	// Without Artifacts' API, as in tests, with a clone in memory.
	return readBranchCommits(await ctx.remote(repo, "read"), from, branch);
}

// A merge GitHive made as a landed change, without reviews or time yet. Null for any other commit.
function landedOf(commit: BranchCommit): LandedChange | null {
	const change = trailer(commit.message, "GitHive-Change");
	const head = commit.parents[1];
	if (!change || !head) return null;
	const intent = trailer(commit.message, "GitHive-Intent");
	return {
		commit: commit.commit,
		change,
		agent: trailer(commit.message, "GitHive-Agent") ?? commit.author,
		head,
		title: commit.message.split("\n")[0] ?? "",
		...(intent ? { intent } : {}),
		files: commit.files.slice(0, FILES_MOST),
		filesTotal: commit.files.length,
		reviews: [],
	};
}

/**
 * The changes landed on a repo's branch (its project branch by default), newest first, with their reviews, each
 * marked if commits that aren't landed changes came after it.
 */
export async function branchHistory(ctx: ToolContext, repo: string, branch?: string): Promise<BranchHistory> {
	const { shown, commits } = await readHistory(ctx, repo, branch);
	const landed: LandedChange[] = [];
	let unlisted = false;
	for (const commit of commits.toReversed()) {
		const entry = landedOf(commit);
		if (!entry) unlisted = true;
		else landed.push(unlisted ? { ...entry, unlistedSince: true } : entry);
	}
	const listed = await withReviews(ctx, repo, shown, landed.slice(0, HISTORY_MOST));
	return { branch: shown, total: landed.length, changes: listed };
}

/**
 * The changes landed on the project's branch after `since`, newest first: all of them, with the reviews of those
 * `listed` picks. `since` is null in the reply when it's no commit of the branch's since GitHive started (nor where it
 * started), and then every change is there.
 */
export async function landedSince(
	ctx: ToolContext,
	repo: string,
	since: string,
	listed: (landed: LandedChange[]) => LandedChange[],
): Promise<{ since: string | null; landed: LandedChange[]; listed: LandedChange[] }> {
	const { start, commits } = await readHistory(ctx, repo);
	const at = commits.findIndex((commit) => commit.commit === since);
	const after = at >= 0 ? commits.slice(at + 1) : commits;
	const landed = after.flatMap((commit) => landedOf(commit) ?? []).reverse();
	const found = at >= 0 || since === start;
	return { since: found ? since : null, landed, listed: await withReviews(ctx, repo, undefined, listed(landed)) };
}

// The branch's commits since GitHive started on it (its project branch by default), oldest first, and where it started.
async function readHistory(ctx: ToolContext, repo: string, branch?: string) {
	const claims = new GitCasLog<Registry>(() => ctx.remote(repo, "read"), repo, `refs/notes/githive-claims/${repo}`);
	const registry = (await claims.read())?.commit.state;
	if (!registry?.baseline) fail(404, `GitHive hasn't started on ${repo}`);
	const shown = branch || projectBranch(registry);
	const start = shown === projectBranch(registry) ? registry.baseline : registry.branches?.[shown]?.base;
	return { shown, start, commits: await branchCommits(ctx, repo, registry, shown) };
}

// The reviews of each landed change's head, and when it landed while the repo's landing recalls it.
async function withReviews(ctx: ToolContext, repo: string, branch: string | undefined, listed: LandedChange[]) {
	if (!listed.length) return listed;
	const heads = listed.map((entry) => entry.head);
	const [votes, landing] = await Promise.all([
		votesFor(ctx, repo).readFor(heads),
		branch
			? (ctx
					.landing?.(repo, branch)
					.view()
					.catch(() => null) ?? null)
			: null,
	]);
	const outcomes = (landing?.recent ?? []).filter((outcome) => outcome.commit);
	const landedAt = new Map(outcomes.map((outcome) => [outcome.commit!, outcome.at]));
	for (const entry of listed) {
		const onHead = votes.votes.filter((vote) => vote.commit === entry.head);
		entry.reviews = onHead.map(({ reviewer, role, verdict, evidence }) => ({ reviewer, role, verdict, evidence }));
		const at = landedAt.get(entry.commit);
		if (at) entry.at = at;
	}
	return listed;
}
