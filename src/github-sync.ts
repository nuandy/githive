import { DurableObject } from "cloudflare:workers";
import { toolContextFor } from "./toolkit/env";
import { inboundStep, isRunning, noticed, ON_MAIN } from "./toolkit/github-inbound";
import {
	type AskedAgain,
	GITHUB_IDENTITY,
	type GitHubSeen,
	type GitHubSyncState,
	type InboundJob,
	type KnownPull,
} from "./toolkit/github-settings";
import type { ToolContext } from "./toolkit/mcp";

// A connected repo's GitHub side, one object per repo (repo:<repo>): the job bringing GitHub's changes back, one step
// per alarm like the hosted builder's (see toolkit/github-inbound.ts), and the standing pull request as last seen.
// What it keeps are hints: the import record and the claims in Git decide, and losing all of it costs a step done again.
// It runs only when a landing, github_pr or the dashboard notices GitHub's branch: no timers of its own.

export class GitHubSync extends DurableObject<Env> {
	/** GitHub's branch is at `seen.commit`: starts bringing it back unless a job runs, or it's known. Returns at once. */
	async notice(seen: GitHubSeen & { repo: string }, asked?: AskedAgain): Promise<GitHubSyncState> {
		const { repo, ...at } = seen;
		const [job, known] = await Promise.all([
			this.ctx.storage.get<InboundJob>("job"),
			this.ctx.storage.get<string>("known"),
		]);
		const next = noticed(job, known, at, repo, asked);
		if (next) {
			await this.ctx.storage.put("job", next);
			await this.ctx.storage.setAlarm(Date.now());
		}
		return this.state();
	}

	async notePull(pull: KnownPull | null) {
		if (pull) await this.ctx.storage.put("pull", pull);
		else await this.ctx.storage.delete("pull");
	}

	/** Someone gave up GitHub's change `change`: its job ends, waiting for GitHub's branch to move or to be asked. */
	async gaveUp(change: string, reason: string) {
		const job = await this.ctx.storage.get<InboundJob>("job");
		if (!job || job.change !== change || job.step === "done") return;
		// A step running now finds its job replaced, and drops its outcome (see alarm).
		const { resume: _, ...ended } = job;
		await this.ctx.storage.put("job", { ...ended, step: "given up", reason, updatedAt: new Date().toISOString() });
	}

	async state(): Promise<GitHubSyncState> {
		const [job, pull] = await Promise.all([
			this.ctx.storage.get<InboundJob>("job"),
			this.ctx.storage.get<KnownPull>("pull"),
		]);
		return { job: job ?? null, pull: pull ?? null };
	}

	/** Runs the job's next step, and sets the alarm for the one after. */
	async alarm() {
		const job = await this.ctx.storage.get<InboundJob>("job");
		if (!isRunning(job)) return;
		const outcome = await inboundStep(this.toolContext(), job!);
		// A job noticed again meanwhile (this one's alarm thought lost) has replaced it: that one goes on.
		const current = await this.ctx.storage.get<InboundJob>("job");
		if (JSON.stringify(current) !== JSON.stringify(job)) return;
		await this.ctx.storage.put("job", outcome.job);
		// GitHub's commit is on main now, found there or merged: noticed again, it needs nothing.
		if (outcome.job.step === "done" && (outcome.job.merged || outcome.job.reason === ON_MAIN))
			await this.ctx.storage.put("known", outcome.job.commit);
		if (outcome.pull !== undefined) await this.notePull(outcome.pull);
		if (outcome.next !== undefined) await this.ctx.storage.setAlarm(Date.now() + outcome.next);
	}

	/**
	 * The toolkit as githive-github, a hosted agent stamped service:githive-github. Its merges push to GitHub as any
	 * landing does, but don't notice GitHub's branch: that would call this object back while its step runs.
	 */
	protected toolContext(): ToolContext {
		const { githubSync: _, ...ctx } = toolContextFor(this.env, GITHUB_IDENTITY, { hosted: true });
		return ctx;
	}
}
