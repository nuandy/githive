import { DurableObject } from "cloudflare:workers";

// One instance lists every repo GitHive works on, with its counts, so the
// dashboard's list of repos is one read. The records in Git are what count;
// this only remembers which repos exist.

/**
 * What the dashboard's list of repos shows for one. Written by the toolkit
 * after claims, releases and merges, and whenever a repo's counts are read,
 * so it is a hint: the records in Git are what count.
 */
export interface RepoSummary {
	/** Changes in progress (claims in force). */
	open?: number;
	/** Changes waiting on a person. */
	needsYou?: number;
	/** Which changes wait on a person, and why, for the inbox. */
	waiting?: { change: string; title: string; reason: string }[];
	merged?: number;
	abandoned?: number;
	/** Open audit violations. */
	violations?: number;
	/** The last record written. */
	lastActivity?: string;
	/** When the counts were last taken from the records themselves. */
	countedAt?: string;
}

export class RepoIndex extends DurableObject<Env> {
	/** Note a repo GitHive works on, for the dashboard. */
	async addRepo(repo: string) {
		await this.ctx.storage.put(`repo:${repo}`, { repo, since: new Date().toISOString() });
	}

	/** Repos GitHive works on, oldest first. */
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

	/** Every repo with its summary if it has one: the dashboard's list of repos. */
	async summaries() {
		const [repos, summaries] = await Promise.all([
			this.listRepos(),
			this.ctx.storage.list<RepoSummary>({ prefix: "summary:" }),
		]);
		return { repos: repos.map((repo) => ({ ...repo, summary: summaries.get(`summary:repo:${repo.repo}`) ?? null })) };
	}

	/** Forget every repo and summary (the bench's wipe). */
	async clear() {
		await this.ctx.storage.deleteAll();
	}
}
