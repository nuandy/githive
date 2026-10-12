import { statusOf } from "../errors";
import { withinMs } from "../github";
import { projectBranch } from "../project-branch";
import type { Registry } from "./claims";
import { type GitHubImports, importsRef, recordImport } from "./github-imports";
import {
	type AskedAgain,
	bringsGitHubBack,
	GITHUB_AGENT,
	githubChangeId,
	githubSync,
	type GitHubSeen,
	importedBranch,
	type InboundJob,
	type KnownPull,
	PR_BRANCH,
} from "./github-settings";
import { NOTICE_WITHIN_MS } from "./github-outbound";
import type { MergeOutcome } from "./merge-types";
import { callTool, type ToolContext } from "./mcp";
import { advice, claimsRef, recordLog, storeFor, votesFor } from "./tools/repo";
import { openFlag } from "./votes";

// Bringing a commit of GitHub's back (see docs/github-prs.md, "Inbound"): the repo's Gate imports it as github/<branch>
// and the import record notes it; githive-github claims a source merge of github/<branch> into main, so the claim
// holds the paths GitHub changed while it lands; and it merges through the batch and the checks like any change,
// without votes while the repo trusts GitHub's changes. A conflict or a failed check sends it back, to a person.
//
// It runs as a job of the repo's own (github-sync.ts), one step per alarm, so the landing that noticed GitHub moved
// never waits on it. Every step can be run again and finds its work done: the import makes the same commit, the record
// is kept once, a claim made again is extended, and a merge asked again of a landed change answers with its commit.

/** The steps that are still to run. The others are where a job ended. */
const RUNNING: InboundJob["step"][] = ["import", "claim", "merge"];
export const isRunning = (job: InboundJob | null | undefined) => !!job && RUNNING.includes(job.step);

/**
 * A running job not heard from in this long has lost its alarm, and starts again when GitHub's branch is noticed. A
 * merge step answers within JOB_MERGE's bound plus its own batch's checks.
 */
const LOST_AFTER_MS = 60 * 60_000;

/**
 * The job's merge, run in an alarm, which the runtime stops after 15 minutes. It waits for its turn at most 4 minutes,
 * then answers pending, and the job records that and merges again at its next alarm rather than holding on. When its
 * turn comes, its batch is its own change alone, so a slow check or a stopped alarm costs no one else's change.
 */
export const JOB_MERGE: NonNullable<ToolContext["mergeLimits"]> = { answerWithinMs: 4 * 60_000, maxBatch: 1 };

/** A merge refused because main kept moving under its batch is tried again this long after: a busy repo, not a fault. */
const MOVED_RETRY_MS = 30_000;

/** A job that failed is started again by a notice of the same commit only after this long (or when asked). */
const FAILED_RETRY_MS = 60 * 60_000;

/** A step that threw is tried this many times, waiting longer each time, before the job counts as failed. */
const STEP_TRIES = 5;
const RETRY_MS = 30_000;

/** Why a job ended with nothing to bring back. */
export const ON_MAIN = "main has it already";

/** A new job for GitHub's branch at `seen`. */
export function newJob(repo: string, seen: GitHubSeen, now = Date.now()): InboundJob {
	const at = new Date(now).toISOString();
	return { repo, ...seen, step: "import", attempts: 0, noticedAt: at, updatedAt: at };
}

/**
 * What noticing GitHub's branch at `seen` starts: a new job, the job that waited going on from where it waited, or
 * nothing when one is running, the commit is known to be on main, or it was brought back, sent to a person or given
 * up already (unless `asked` again; a give-up only by a person). A job that failed starts again after a while, so a
 * commit that can't come in (a GitHub branch sharing no history with main, say) doesn't start a container at every
 * landing.
 */
export function noticed(
	current: InboundJob | null | undefined,
	known: string | null | undefined,
	seen: GitHubSeen,
	repo: string,
	asked?: AskedAgain,
	now = Date.now(),
): InboundJob | null {
	if (current && isRunning(current) && now - Date.parse(current.updatedAt) < LOST_AFTER_MS) return null;
	const again = asked !== undefined;
	if (!again && seen.commit === known) return null;
	const same = current?.commit === seen.commit;
	// A person gave it up: only a person asking again undoes that, never an agent's refresh.
	const givenUp = same && current?.step === "given up";
	if (givenUp && asked !== "person") return null;
	if (current && same && current.step === "waiting") {
		const { reason: _, ...waited } = current;
		return { ...waited, step: current.resume ?? "import", attempts: 0, updatedAt: new Date(now).toISOString() };
	}
	const ended = current?.step === "done" || current?.step === "needs a person" || current?.step === "given up";
	if (!again && same && ended) return null;
	const failedLately = current?.step === "failed" && now - Date.parse(current.updatedAt) < FAILED_RETRY_MS;
	if (!again && same && failedLately) return null;
	return newJob(repo, seen, now);
}

/** A step's outcome: the job after it, when to run the next step (ms from now) if any, and the pull request seen. */
export interface StepOutcome {
	job: InboundJob;
	next?: number;
	/** The standing pull request as just read, once GitHub's commit is on main; null when none is open. */
	pull?: KnownPull | null;
}

/** Runs the job's current step as githive-github (`ctx` is a hosted tool context stamped as it). */
export async function inboundStep(ctx: ToolContext, job: InboundJob): Promise<StepOutcome> {
	// When the step ended, not when it began: a merge step can wait minutes.
	const at = (changes: Partial<InboundJob>): InboundJob => ({
		...job,
		...changes,
		updatedAt: new Date().toISOString(),
	});
	try {
		if (job.step === "import") return await importStep(ctx, job, at);
		if (job.step === "claim") return await claimStep(ctx, job, at);
		if (job.step === "merge") return await mergeStep(ctx, job, at);
		return { job };
	} catch (err) {
		// Tried again later, then left for the next time GitHub's branch is noticed.
		const attempts = job.attempts + 1;
		const reason = `${job.step} failed: ${statusOf(err).message}`;
		console.error(`bringing ${job.github} ${job.branch} back into ${job.repo}: ${reason}`);
		if (attempts >= STEP_TRIES) return { job: at({ step: "failed", attempts, reason }) };
		return { job: at({ attempts, reason }), next: RETRY_MS * 2 ** (attempts - 1) };
	}
}

type At = (changes: Partial<InboundJob>) => InboundJob;

// The Gate imports GitHub's branch as github/<branch> and the import record notes it, or finds main has it.
async function importStep(ctx: ToolContext, job: InboundJob, at: At): Promise<StepOutcome> {
	const registry = (await recordLog<Registry>(ctx, job.repo, claimsRef(job.repo)).read())?.commit.state;
	if (registry?.github?.repo !== job.github)
		return { job: at({ step: "done", reason: `${job.repo} isn't connected to ${job.github} any more` }) };
	if (!bringsGitHubBack(registry))
		return { job: at({ step: "done", reason: `${job.repo}'s link has no mode set: it only mirrors` }) };
	const branch = projectBranch(registry);
	const link = (await ctx.github?.(job.github)) ?? null;
	if (!link) throw new Error(`GitHive's GitHub app can't reach ${job.github}`);
	const gate = ctx.batchGit?.(job.repo);
	if (!gate?.importBranch) throw new Error("no Gate can import from GitHub here");
	// Main's recent history first, through Artifacts' API: a commit on it needs no container.
	if (await onMain(ctx, job.repo, branch, job.commit))
		return { job: at({ step: "done", reason: ON_MAIN, attempts: 0 }) };
	const base = await ctx.head(job.repo, branch);
	const as = importedBranch(job.branch);
	const imported = await gate.importBranch({ base, branch, from: link.remote, githubBranch: job.branch, as });
	if ("known" in imported) return { job: at({ step: "done", commit: imported.known, reason: ON_MAIN, attempts: 0 }) };
	if ("failed" in imported) throw new Error(imported.failed);
	const { commit, head } = imported;
	const log = recordLog<GitHubImports>(ctx, job.repo, importsRef(job.repo));
	await recordImport(log, { github: job.github, branch: job.branch, ...imported }, await ctx.stamper?.());
	return { job: at({ step: "claim", commit, head, base: imported.base, attempts: 0 }), next: 0 };
}

// Whether `commit` is on main's first-parent history, or merged into it, as Artifacts' API reads main's last 1,000.
async function onMain(ctx: ToolContext, repo: string, branch: string, commit: string) {
	if (!ctx.history) return false;
	const chain = await ctx.history(repo, (source) => source.log(branch, 1000, 0)).catch(() => null);
	return !!chain?.some((entry) => entry.hash === commit || entry.parents.includes(commit));
}

// githive-github claims a merge of github/<branch> into main: what GitHub changed, held while it lands.
async function claimStep(ctx: ToolContext, job: InboundJob, at: At): Promise<StepOutcome> {
	const source = importedBranch(job.branch);
	const change = githubChangeId(job.commit);
	// A change of GitHub's still open from before (it needed a person) gives way to this newer commit.
	const { claims } = await advice(ctx, job.repo);
	for (const older of claims.filter((claim) => claim.agent === GITHUB_AGENT && claim.source === source))
		if (older.change !== change)
			await callTool(
				"release",
				{ repo: job.repo, change: older.change, agent: GITHUB_AGENT, reason: `GitHub's ${job.branch} moved on` },
				ctx,
			);
	const intent = `Bring in GitHub's changes (${job.github} ${job.branch} at ${job.commit.slice(0, 12)})`;
	type Claimed = { ok: boolean; conflicts?: { path: string; change: string; agent: string }[] };
	const outcome = (await callTool("claim", { repo: job.repo, change, agent: GITHUB_AGENT, source, intent }, ctx).catch(
		(err) => {
			// It merged meanwhile, by another job or by hand.
			if (/has nothing .* doesn't have/.test(statusOf(err).message)) return null;
			throw err;
		},
	)) as Claimed | null;
	if (!outcome) return { job: at({ step: "done", change, reason: ON_MAIN, attempts: 0 }) };
	if (!outcome.ok) {
		const held = (outcome.conflicts ?? []).map(
			(conflict) => `${conflict.path} (${conflict.change}, ${conflict.agent})`,
		);
		const reason = `waits for paths others hold: ${[...new Set(held)].join(", ")}`;
		return { job: at({ step: "waiting", resume: "claim", change, reason, attempts: 0 }) };
	}
	return { job: at({ step: "merge", change, attempts: 0 }), next: 0 };
}

// It merges like any change: in a batch, through the checks, sent back if it conflicts or they fail. Within JOB_MERGE's
// bound: a merge still waiting for its turn answers pending, and the next alarm merges again.
async function mergeStep(ctx: ToolContext, job: InboundJob, at: At): Promise<StepOutcome> {
	const change = job.change!;
	const bounded = { ...ctx, mergeLimits: { ...JOB_MERGE, ...ctx.mergeLimits } };
	const outcome = (await callTool("merge", { repo: job.repo, change, agent: GITHUB_AGENT }, bounded)) as MergeOutcome;
	if (outcome.ok)
		return { job: at({ step: "done", merged: outcome.commit, attempts: 0 }), pull: await openPull(ctx, job) };
	const reason = outcome.reasons.join("; ");
	// Still waiting for its turn: merging again goes on waiting.
	if (outcome.pending) return { job: at({ reason: `waits for its turn to land: ${reason}`, attempts: 0 }), next: 0 };
	// Others' merges landed first: a busy repo, so it merges again shortly, however often that happens.
	if (/kept moving/.test(reason)) return { job: at({ reason, attempts: 0 }), next: MOVED_RETRY_MS };
	// Its claim is gone: it landed (a step that merged, then died before the job noted it, asks again), or someone
	// gave it up (see giveUpGitHubChange). Its releases say which.
	if (/holds no claim/.test(reason)) {
		const merged = await mergedAs(ctx, job.repo, change);
		if (merged) return { job: at({ step: "done", merged, attempts: 0 }), pull: await openPull(ctx, job) };
		return { job: at({ step: "given up", reason: `its claim was released: ${reason}` }) };
	}
	// Untrusted, it waits for review like any change, and lands with a batch once approved.
	if (/approvals from reviewers|still needs approval|is vetoed/.test(reason))
		return { job: at({ step: "waiting", resume: "merge", reason: `waits for review: ${reason}`, attempts: 0 }) };
	// Sent back like any change: people see it in their inbox, with the reason.
	const asked =
		`GitHub's changes need a person: ${reason}. Fix it on GitHub (merge ${PR_BRANCH} into ${job.branch} there, ` +
		"resolving it) and GitHive brings the fix back, which also lets this one go.";
	// Asked once: while the question is open (a person hasn't voted on its head since), asking again would only add
	// another to people's inbox, as github_pr's refresh restarting the job did.
	if (!(await askedAlready(ctx, job.repo, change, job.head)))
		await callTool("ask_human", { repo: job.repo, change, agent: GITHUB_AGENT, reason: asked }, ctx);
	return { job: at({ step: "needs a person", reason, attempts: 0 }) };
}

// The merge commit `change` landed as, from its claim's last release, if it merged.
async function mergedAs(ctx: ToolContext, repo: string, change: string) {
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const { released } = await storeFor(ctx, repo, registry).readChange(change);
	return released.at(-1)?.mergedAs;
}

// Whether people were asked about `change` at `head` and haven't answered yet.
async function askedAlready(ctx: ToolContext, repo: string, change: string, head: string | undefined) {
	if (!head) return false;
	const seen = await votesFor(ctx, repo)
		.readFor([head])
		.catch(() => null);
	return !!openFlag(seen, change, head);
}

// The standing pull request after GitHub's commit landed: merged and closed, or still open with more to take. Only a
// repo in pr mode has one, and a GitHub that doesn't answer soon is left for the next time.
async function openPull(ctx: ToolContext, job: InboundJob): Promise<KnownPull | null | undefined> {
	const registered = await recordLog<Registry>(ctx, job.repo, claimsRef(job.repo))
		.read()
		.catch(() => null);
	const registry = registered?.commit.state;
	if (githubSync(registry) !== "pr") return undefined;
	const link = await ctx.github?.(job.github).catch(() => null);
	if (!link) return undefined;
	const read = `${job.github}'s pull request from ${PR_BRANCH}`;
	const pull = await withinMs(NOTICE_WITHIN_MS, read, (signal) => link.openPull(PR_BRANCH, signal)).catch(
		() => undefined,
	);
	if (pull === undefined) return undefined;
	return pull && { number: pull.number, url: pull.url, at: new Date().toISOString() };
}
