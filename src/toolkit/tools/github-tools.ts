import { fail } from "../../errors";
import { GitHubError, type GitHubLink, type PullRequest } from "../../github";
import { mirrorTo } from "../actions-checks";
import { pullStory, untaken } from "../github-pr";
import type { ClaimRecord, Registry } from "../claims";
import { type GitHubImport, type GitHubImports, importedAt, importsRef, verifiedImports } from "../github-imports";
import { githubSync, type GitHubSyncState, isGitHubChange, PR_BRANCH, trustsGitHub } from "../github-settings";
import { branchHistory } from "../history";
import type { ToolCall, ToolContext, ToolHandlers } from "./context";
import { recordLog } from "./repo";

// The standing pull request on GitHub (see docs/github-prs.md): github_pr opens it, or says where it is, and with
// refresh rewrites its title and body. Asking is also a moment to look at GitHub's branch: if it holds commits
// GitHive's main lacks, they're brought back as githive-github's change. Merging and closing happen on GitHub.

export const githubTools: ToolHandlers = {
	async github_pr(call) {
		const { args, ctx, repo, registered, branch } = call;
		const refresh = args.refresh === true;
		const link = await connectedLink(call);
		const seen = await link.defaultHead();
		const sync = ctx.githubSync?.(repo);
		// No timers: someone asking is when GitHive looks, and refresh tries again what needed a person.
		const state = await sync
			?.notice({ github: link.repo, branch: seen.branch, commit: seen.head }, refresh)
			.catch((err) => (console.error(`noticing ${link.repo}'s ${seen.branch} failed`, String(err)), undefined));
		const inbound = inboundOf(state);
		if (githubSync(registered) !== "pr")
			fail(409, `${repo} mirrors ${branch} to ${link.repo}: set github_sync to "pr" for a pull request`);
		const open = await link.openPull(PR_BRANCH);
		const reply = (pull: PullRequest, how: "open" | "opened" | "refreshed", changes?: number) => ({
			pr: pull.url,
			number: pull.number,
			title: pull.title,
			[how]: true,
			...(changes !== undefined ? { changes } : {}),
			...inbound,
		});
		if (open && !refresh) {
			await notePull(call, open);
			return {
				...reply(open, "open"),
				note: `a pull request from ${PR_BRANCH} is open already; it updates itself as changes land`,
			};
		}
		const [landed, taken] = await Promise.all([branchHistory(ctx, repo), takenAt(call, seen)]);
		const story = pullStory(untaken(landed.changes, taken), seen.branch);
		if (open) {
			const updated = await link.updatePull(open.number, { title: story.title, body: story.body });
			await notePull(call, updated);
			return reply(updated, "refreshed", story.changes);
		}
		await sync?.notePull(null).catch(() => undefined);
		if (!story.changes)
			fail(409, `nothing has landed on GitHive since ${link.repo}'s ${seen.branch} took its work: no pull request`);
		await pushPullBranch(call, link);
		const pull = await link
			.createPull({ head: PR_BRANCH, base: seen.branch, title: story.title, body: story.body })
			.catch((err) =>
				err instanceof GitHubError && err.status === 422
					? fail(409, `GitHub won't open the pull request: ${err.message}`)
					: Promise.reject(err),
			);
		await notePull(call, pull);
		return reply(pull, "opened", story.changes);
	},
};

/**
 * Whether a change lands without votes at a head: githive-github's claim of a GitHub branch, while the repo trusts
 * GitHub's changes, at a head the import record holds, stamped. The record is read once, when first needed.
 */
export function trustedImports(ctx: ToolContext, repo: string, registry: Registry | undefined) {
	if (!registry || !trustsGitHub(registry)) return undefined;
	let imports: Promise<GitHubImport[]> | undefined;
	const read = async () => {
		const head = await recordLog<GitHubImports>(ctx, repo, importsRef(repo)).read();
		return verifiedImports(head?.commit.state.imports ?? [], registry.stampKey);
	};
	return async (claim: ClaimRecord, head: string) => {
		if (!isGitHubChange(claim)) return false;
		imports ??= read().catch((err) => (console.error(`reading ${repo}'s GitHub imports failed`, String(err)), []));
		const branch = claim.source!.slice("github/".length);
		return !!importedAt(await imports, branch, head);
	};
}

// The newest commit of GitHive's main whose work GitHub's branch has: its head, or for a head GitHive brought in, the
// commit its import found GitHub had taken (a squash's or rebase's head is no commit of main's).
async function takenAt({ ctx, repo }: ToolCall, seen: { branch: string; head: string }) {
	const imports = (await recordLog<GitHubImports>(ctx, repo, importsRef(repo)).read())?.commit.state.imports ?? [];
	return imports.findLast((entry) => entry.branch === seen.branch && entry.commit === seen.head)?.base ?? seen.head;
}

// The connected GitHub repo, through GitHive's App.
async function connectedLink({ ctx, repo, registered }: ToolCall): Promise<GitHubLink> {
	const github = registered?.github;
	if (!github) fail(409, `${repo} isn't connected to GitHub: connect it with settings github ("owner/name")`);
	if (!ctx.github) fail(501, "GitHub isn't set up on this GitHive (its App's ID and key)");
	const link = await ctx.github(github.repo);
	if (!link) fail(409, `GitHive's GitHub app isn't installed on ${github.repo} any more: install it there again`);
	return link;
}

// githive/main follows main after every landing; it's pushed here too, for a repo connected since its last landing.
async function pushPullBranch({ ctx, repo, branch }: ToolCall, link: GitHubLink) {
	if (!ctx.batchGit) fail(503, "GitHive can't push to GitHub here: no Gate is set up");
	const head = await ctx.head(repo, branch);
	await mirrorTo(ctx.batchGit(repo), link, branch, head, PR_BRANCH).catch((err) =>
		fail(409, `GitHub refused ${PR_BRANCH} (did someone push to it?): ${String(err).slice(0, 300)}`),
	);
}

// Kept for the dashboard, as a hint: GitHub has the truth.
async function notePull({ ctx, repo }: ToolCall, pull: PullRequest) {
	await ctx
		.githubSync?.(repo)
		.notePull({ number: pull.number, url: pull.url, at: new Date().toISOString() })
		.catch(() => undefined);
}

// Where bringing GitHub's changes back stands, for the reply.
function inboundOf(state: GitHubSyncState | undefined) {
	const job = state?.job;
	if (!job) return {};
	const { step, commit, change, reason } = job;
	return {
		fromGitHub: { step, commit, ...(change ? { change } : {}), ...(reason ? { reason } : {}) },
	};
}
