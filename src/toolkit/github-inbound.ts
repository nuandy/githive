import { statusOf } from "../errors";
import { projectBranch } from "../project-branch";
import type { Registry } from "./claims";
import { type GitHubImports, importsRef, recordImport } from "./github-imports";
import {
	GITHUB_AGENT,
	type GitHubSeen,
	importedBranch,
	type InboundJob,
	type KnownPull,
	PR_BRANCH,
} from "./github-settings";
import type { MergeOutcome } from "./merge-types";
import { callTool, type ToolContext } from "./mcp";
import { advice, claimsRef, recordLog } from "./tools/repo";

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

/** A running job not heard from in this long has lost its alarm, and starts again when GitHub's branch is noticed. */
const LOST_AFTER_MS = 30 * 60_000;

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
 * What noticing GitHub's branch at `seen` starts: a new job, or nothing when one is running, the commit is known to
 * be on main, or it was brought back or sent to a person already (unless `again`). A job that waited, or failed,
 * starts again.
 */
export function noticed(
	current: InboundJob | null | undefined,
	known: string | null | undefined,
	seen: GitHubSeen,
	repo: string,
	again = false,
	now = Date.now(),
): InboundJob | null {
	if (current && isRunning(current) && now - Date.parse(current.updatedAt) < LOST_AFTER_MS) return null;
	if (!again && seen.commit === known) return null;
	const ended = current?.step === "done" || current?.step === "needs a person";
	if (!again && ended && current?.commit === seen.commit) return null;
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
export async function inboundStep(ctx: ToolContext, job: InboundJob, now = Date.now()): Promise<StepOutcome> {
	const at = (changes: Partial<InboundJob>): InboundJob => ({
		...job,
		...changes,
		updatedAt: new Date(now).toISOString(),
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
	const change = `github-${job.commit.slice(0, 12)}`;
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
		return { job: at({ step: "waiting", change, reason, attempts: 0 }) };
	}
	return { job: at({ step: "merge", change, attempts: 0 }), next: 0 };
}

// It merges like any change: in a batch, through the checks, sent back if it conflicts or they fail.
async function mergeStep(ctx: ToolContext, job: InboundJob, at: At): Promise<StepOutcome> {
	const change = job.change!;
	const outcome = (await callTool("merge", { repo: job.repo, change, agent: GITHUB_AGENT }, ctx)) as MergeOutcome;
	if (outcome.ok)
		return { job: at({ step: "done", merged: outcome.commit, attempts: 0 }), pull: await openPull(ctx, job) };
	// Still waiting for its batch: merging again goes on waiting.
	if (outcome.pending) return { job: at({}), next: 0 };
	const reason = outcome.reasons.join("; ");
	if (/kept moving/.test(reason) && job.attempts + 1 < STEP_TRIES)
		return { job: at({ attempts: job.attempts + 1, reason }), next: 0 };
	if (/holds no claim/.test(reason)) return { job: at({ step: "failed", reason }) };
	// Untrusted, it waits for review like any change, and lands with a batch once approved.
	if (/approvals from reviewers|still needs approval|is vetoed/.test(reason))
		return { job: at({ step: "waiting", reason: `waits for review: ${reason}`, attempts: 0 }) };
	// Sent back like any change: people see it in their inbox, with the reason.
	const asked =
		`GitHub's changes need a person: ${reason}. Fix it on GitHub (merge ${PR_BRANCH} into ${job.branch} there, ` +
		"resolving it) and GitHive brings the fix back, which also lets this one go.";
	await callTool("ask_human", { repo: job.repo, change, agent: GITHUB_AGENT, reason: asked }, ctx);
	return { job: at({ step: "needs a person", reason, attempts: 0 }) };
}

// The standing pull request after GitHub's commit landed: merged and closed, or still open with more to take.
async function openPull(ctx: ToolContext, job: InboundJob): Promise<KnownPull | null | undefined> {
	const link = await ctx.github?.(job.github).catch(() => null);
	const pull = await link?.openPull(PR_BRANCH).catch(() => undefined);
	if (pull === undefined) return undefined;
	return pull && { number: pull.number, url: pull.url, at: new Date().toISOString() };
}
