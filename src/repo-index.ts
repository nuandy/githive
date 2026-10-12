import { DurableObject } from "cloudflare:workers";
import { createdAtOf } from "./artifacts";
import { retryTransient } from "./retry";
import type { StretchSummary } from "./toolkit/stretch";

// One instance lists every repo with its counts, so the dashboard's repo list is one read.
// The counts are hints; the records in Git are the source of truth.
//
// It also deletes what a deleted repo leaves in Artifacts, its agents' forks and its claim shards, on its own alarm
// and in batches: a busy repo has thousands, more than one request can delete, and a request cut short would strand
// the rest for good.

export interface RepoSummary {
	/** Changes with claims in force. */
	open?: number;
	/** Changes waiting on a person. */
	needsYou?: number;
	waiting?: { change: string; title: string; reason: string; urgency?: number }[];
	merged?: number;
	abandoned?: number;
	violations?: number;
	lastActivity?: string;
	/** The repo's last stretch of work, for "all landed" on the list (see toolkit/stretch.ts). */
	lastStretch?: StretchSummary;
	/** When the counts were last read from the records. */
	countedAt?: string;
}

/** A repo a deleted one left behind, waiting to be deleted. */
interface Leftover {
	/** When its repo was deleted: a repo by its name made since is a new one's, and stays. */
	since: number;
	tries: number;
}

const LEFTOVER = "leftover:";
/** Deleted per alarm, so one turn stays well inside a Worker's limits. */
const LEFTOVERS_AT_ONCE = 25;
/** A leftover that fails this many times is given up and logged. */
const LEFTOVER_TRIES = 5;
/** Storage writes at most this many keys at once. */
const KEYS_AT_ONCE = 128;

export class RepoIndex extends DurableObject<Env> {
	async addRepo(repo: string) {
		await this.ctx.storage.put(`repo:${repo}`, { repo, since: new Date().toISOString() });
	}

	async listRepos() {
		return [...(await this.ctx.storage.list<{ repo: string; since: string }>({ prefix: "repo:" })).values()].sort(
			(a, b) => a.since.localeCompare(b.since),
		);
	}

	/** Update a repo's summary (`repo:<repo>`). `mergedBy` adds to the merged count. */
	async summarize(key: string, patch: RepoSummary & { mergedBy?: number }) {
		const { mergedBy, ...rest } = patch;
		const current = (await this.ctx.storage.get<RepoSummary>(`summary:${key}`)) ?? {};
		const next: RepoSummary = { ...current, ...rest };
		if (mergedBy) next.merged = (next.merged ?? 0) + mergedBy;
		await this.ctx.storage.put(`summary:${key}`, next);
	}

	async summaries() {
		const [repos, summaries] = await Promise.all([
			this.listRepos(),
			this.ctx.storage.list<RepoSummary>({ prefix: "summary:" }),
		]);
		return { repos: repos.map((repo) => ({ ...repo, summary: summaries.get(`summary:repo:${repo.repo}`) ?? null })) };
	}

	async clear() {
		await this.ctx.storage.deleteAll();
	}

	/** Deletes `names`, which a repo deleted at `since` left behind, on this object's alarm, a batch at a time. */
	async forgetLeftovers(names: string[], since: number) {
		for (let start = 0; start < names.length; start += KEYS_AT_ONCE) {
			const batch = names.slice(start, start + KEYS_AT_ONCE);
			await this.ctx.storage.put(Object.fromEntries(batch.map((name) => [`${LEFTOVER}${name}`, { since, tries: 0 }])));
		}
		if (names.length && (await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
	}

	/** How many leftovers are still to delete. */
	async leftoversToGo() {
		return (await this.ctx.storage.list({ prefix: LEFTOVER })).size;
	}

	async alarm() {
		const batch = await this.ctx.storage.list<Leftover>({ prefix: LEFTOVER, limit: LEFTOVERS_AT_ONCE });
		for (const [key, leftover] of batch) await this.deleteOne(key, leftover);
		const more = (await this.ctx.storage.list({ prefix: LEFTOVER, limit: 1 })).size > 0;
		if (more) await this.ctx.storage.setAlarm(Date.now() + 1_000);
	}

	private async deleteOne(key: string, leftover: Leftover) {
		const name = key.slice(LEFTOVER.length);
		try {
			await this.deleteLeftover(name, leftover.since);
			await this.ctx.storage.delete(key);
		} catch (err) {
			const tries = leftover.tries + 1;
			if (tries < LEFTOVER_TRIES) return this.ctx.storage.put(key, { ...leftover, tries });
			console.error(`gave up deleting ${name}, left by a deleted repo`, String(err));
			await this.ctx.storage.delete(key);
		}
	}

	/** Deletes repo `name` if it's still the one its deleted repo left (tests stand in for Artifacts). */
	protected async deleteLeftover(name: string, since: number) {
		const created = await createdAtOf(this.env.ARTIFACTS, name);
		if (created === null) return;
		if (created >= since) return;
		await retryTransient(() => this.env.ARTIFACTS.delete(name));
	}
}
