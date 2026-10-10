import { DurableObject } from "cloudflare:workers";

// One instance lists every repo with its counts, so the dashboard's repo list is one read.
// The counts are hints; the records in Git are the source of truth.

export interface RepoSummary {
	/** Changes with claims in force. */
	open?: number;
	/** Changes waiting on a person. */
	needsYou?: number;
	waiting?: { change: string; title: string; reason: string }[];
	merged?: number;
	abandoned?: number;
	violations?: number;
	lastActivity?: string;
	/** When the counts were last read from the records. */
	countedAt?: string;
}

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
}
