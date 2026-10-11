import { fail } from "../../errors";
import { GitHubError, type GitHubLink, type PullRequest } from "../../github";
import { mirrorTo } from "../actions-checks";
import { pullStoryAt } from "../github-pr";
import type { ClaimStore } from "../claim-store";
import type { Stamper } from "../stamp";
import type { ClaimRecord, Registry } from "../claims";
import { type GitHubImport, type GitHubImports, importsRef, trustedGitHubChange } from "../github-imports";
import {
	bringsGitHubBack,
	githubSync,
	type GitHubSyncState,
	isGitHubChange,
	PR_BRANCH,
	trustsGitHub,
} from "../github-settings";
import type { ToolCall, ToolContext, ToolHandlers } from "./context";
import { claimsRef, recordLog } from "./repo";

// The standing pull request on GitHub (see docs/github-prs.md): github_pr opens it, or says where it is, and with
// refresh rewrites its title and body. Asking is also a moment to look at GitHub's branch: if it holds commits
// GitHive's main lacks, they're brought back as githive-github's change. Merging and closing happen on GitHub.

export const githubTools: ToolHandlers = {
	async github_pr(call) {
		const { args, ctx, repo, registered, branch } = call;
		const refresh = args.refresh === true;
		const link = await connectedLink(call);
		const seen = await link.defaultHead();
		// A link made before modes brings nothing back.
		const sync = bringsGitHubBack(registered) ? ctx.githubSync?.(repo) : undefined;
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
		// GitHub's default branch may have changed since it was opened: refresh points it there.
		const elsewhere = open && open.base !== seen.branch;
		if (open && !refresh) {
			await notePull(call, open);
			const moved = elsewhere
				? `; it goes into ${open.base}, but ${link.repo}'s default branch is ${seen.branch} now: refresh points it there`
				: "";
			return {
				...reply(open, "open"),
				note: `a pull request from ${PR_BRANCH} is open already; it updates itself as changes land${moved}`,
			};
		}
		const story = await pullStoryAt(ctx, repo, await takenAt(call, seen), seen.branch);
		const changes = story.changes ?? undefined;
		if (open) {
			const rewritten = { title: story.title, body: story.body, ...(elsewhere ? { base: seen.branch } : {}) };
			const updated = await link.updatePull(open.number, rewritten);
			await notePull(call, updated);
			return reply(updated, "refreshed", changes);
		}
		await sync?.notePull(null).catch(() => undefined);
		if (story.changes === 0)
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
		return reply(pull, "opened", changes);
	},
};

/**
 * Whether a change lands without votes at a head: the trust rule (trustedGitHubChange), the audit's own, against its
 * claim's records as written and the registry the merge is checked against. Only githive-github's claims of a GitHub
 * branch are looked at further, and the import record is read once, when first needed.
 */
export function trustedImports(ctx: ToolContext, repo: string, registry: Registry | undefined, store: ClaimStore) {
	if (!registry || !trustsGitHub(registry)) return undefined;
	let imports: Promise<GitHubImport[]> | undefined;
	const read = async () =>
		(await recordLog<GitHubImports>(ctx, repo, importsRef(repo)).read())?.commit.state.imports ?? [];
	return async (claim: ClaimRecord, head: string) => {
		if (!isGitHubChange(claim)) return false;
		imports ??= read().catch((err) => (console.error(`reading ${repo}'s GitHub imports failed`, String(err)), []));
		return trustedGitHubChange({
			records: await store.claimRecords(claim.change),
			head,
			registry,
			imports: () => imports!,
			stampKey: registry.stampKey,
		});
	};
}

// The newest commit of GitHive's main whose work GitHub's branch has: its head, or for a head GitHive brought in, the
// commit its import found GitHub had taken (a squash's or rebase's head is no commit of main's).
async function takenAt({ ctx, repo }: ToolCall, seen: { branch: string; head: string }) {
	const imports = (await recordLog<GitHubImports>(ctx, repo, importsRef(repo)).read())?.commit.state.imports ?? [];
	return imports.findLast((entry) => entry.branch === seen.branch && entry.commit === seen.head)?.base ?? seen.head;
}

/**
 * Gives up GitHub's change on `who`'s word (see docs/github-prs.md, "Giving up GitHub's changes"): its claim released,
 * recorded like a stale release with their stamp, so its paths are free, and its job ended until GitHub's branch moves
 * or someone asks again. It's the one exception to "only a claim's agent releases it", since githive-github's claim
 * otherwise holds its paths until GitHub's branch moves. Who may is the caller's to check: a person who can write,
 * from the dashboard, or a repo admin, through release.
 */
export async function giveUpGitHubChange(
	ctx: ToolContext,
	repo: string,
	input: { store: ClaimStore; claim: ClaimRecord; who: string; stamper?: Stamper },
) {
	const { store, claim, who, stamper } = input;
	if (!isGitHubChange(claim))
		fail(409, `${claim.change} is ${claim.agent}'s change, not GitHub's: only its agent releases it`);
	const reason = `GitHub's changes given up by ${who}`;
	const outcome = await store.giveUp({ change: claim.change, agent: who, reason }, stamper);
	if (!outcome.ok) return outcome;
	await ctx
		.githubSync?.(repo)
		.gaveUp(claim.change, reason)
		.catch((err) => console.error(`telling ${repo}'s GitHubSync ${claim.change} was given up failed`, String(err)));
	return {
		ok: true as const,
		released: claim.change,
		note:
			"Its paths are free. GitHive brings GitHub's changes back again when GitHub's branch moves, or when asked " +
			"(github_pr with refresh, or the dashboard).",
	};
}

/**
 * Looks at GitHub's branch now and brings its changes back, even a commit given up, sent to a person or failed before:
 * a person asking again from the dashboard. Returns where bringing them back stands.
 */
export async function bringGitHubBackAgain(ctx: ToolContext, repo: string) {
	const registered = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const link = await connectedLink({ ctx, repo, registered });
	if (!bringsGitHubBack(registered))
		fail(409, `${repo}'s link to ${link.repo} only mirrors: set github_sync to bring GitHub's changes back`);
	const sync = ctx.githubSync?.(repo) ?? fail(503, "GitHive can't bring GitHub's changes back here");
	const seen = await link.defaultHead();
	return inboundOf(await sync.notice({ github: link.repo, branch: seen.branch, commit: seen.head }, true));
}

// The connected GitHub repo, through GitHive's App.
async function connectedLink({
	ctx,
	repo,
	registered,
}: Pick<ToolCall, "ctx" | "repo" | "registered">): Promise<GitHubLink> {
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
