import { DurableObject } from "cloudflare:workers";

// One instance lists every task, so the dashboard can show them. Coordinators
// hold each task's state; this only remembers which tasks exist.

export interface TaskRef {
	id: string;
	repo: string;
	goal: string;
	createdAt: string;
	/** Run by the elected coordinator: its state is in the task's log, not a Coordinator object. */
	elected?: boolean;
	/**
	 * For an elected task, who leads as of `term` (null: nobody, it resigned), as
	 * the leader reported it. Only a hint, so the Worker can call the leader in
	 * one hop; the log and lease in Git are what count.
	 */
	leader?: { name: string | null; term: number };
}

/**
 * What the dashboard's list of repos shows for one, kept here so the list is
 * one read rather than every task's state. Written by whoever decides (an
 * elected task's leader after each commit; the coordinator-free toolkit after
 * claims, releases and merges, and whenever a repo's counts are read), so it
 * is a hint: the log and records in Git are what count.
 */
export interface RepoSummary {
	/** Changes in progress (claims in force, coordinator-free). */
	open?: number;
	/** Changes waiting on a person. */
	needsYou?: number;
	merged?: number;
	abandoned?: number;
	/** Open audit violations (coordinator-free). */
	violations?: number;
	/** The last decision or record written. */
	lastActivity?: string;
	/** When the counts were last taken from the state itself. */
	countedAt?: string;
}

export class TaskIndex extends DurableObject<Env> {
	async add(ref: TaskRef) {
		// Keys sort by creation time, so a reverse list is newest first.
		await this.ctx.storage.put(`task:${ref.createdAt}:${ref.id}`, ref);
	}

	async list(limit = 50) {
		const entries = await this.ctx.storage.list<TaskRef>({ prefix: "task:", reverse: true, limit });
		return [...entries.values()];
	}

	/** Note a repo in coordinator-free mode, for the dashboard. */
	async addFree(repo: string) {
		await this.ctx.storage.put(`free:${repo}`, { repo, since: new Date().toISOString() });
	}

	/** Repos in coordinator-free mode, oldest first. */
	async listFree() {
		return [...(await this.ctx.storage.list<{ repo: string; since: string }>({ prefix: "free:" })).values()].sort((a, b) => a.since.localeCompare(b.since));
	}

	/** The task with this id, if it is listed. */
	async get(id: string) {
		const entries = await this.ctx.storage.list<TaskRef>({ prefix: "task:" });
		return [...entries.values()].find((ref) => ref.id === id) ?? null;
	}

	/** Note who leads a task as of `term`. A report from an older term than the one noted is ignored. */
	async hintLeader(id: string, name: string | null, term: number) {
		const entries = await this.ctx.storage.list<TaskRef>({ prefix: "task:" });
		for (const [key, ref] of entries) {
			if (ref.id !== id) continue;
			if (ref.leader && ref.leader.term > term) return;
			await this.ctx.storage.put(key, { ...ref, leader: { name, term } });
		}
	}

	/** Every task on a repo. */
	async onRepo(repo: string) {
		const entries = await this.ctx.storage.list<TaskRef>({ prefix: "task:" });
		return [...entries.values()].filter((ref) => ref.repo === repo);
	}

	/** Update the summary of a task (`task:<id>`) or coordinator-free repo (`free:<repo>`). `mergedBy` adds to the merged count. */
	async summarize(key: string, patch: RepoSummary & { mergedBy?: number }) {
		const { mergedBy, ...rest } = patch;
		const current = (await this.ctx.storage.get<RepoSummary>(`summary:${key}`)) ?? {};
		const next: RepoSummary = { ...current, ...rest };
		if (mergedBy) next.merged = (next.merged ?? 0) + mergedBy;
		await this.ctx.storage.put(`summary:${key}`, next);
	}

	/** Every listed task and coordinator-free repo, with its summary if it has one: the dashboard's list of repos. */
	async summaries(limit = 200) {
		const [tasks, free, summaries] = await Promise.all([
			this.ctx.storage.list<TaskRef>({ prefix: "task:", reverse: true, limit }),
			this.listFree(),
			this.ctx.storage.list<RepoSummary>({ prefix: "summary:" }),
		]);
		return {
			tasks: [...tasks.values()].map(({ leader: _leader, ...ref }) => ({ ...ref, summary: summaries.get(`summary:task:${ref.id}`) ?? null })),
			free: free.map((repo) => ({ ...repo, summary: summaries.get(`summary:free:${repo.repo}`) ?? null })),
		};
	}

	/** Forget every task, coordinator-free repo and summary (the bench's wipe). */
	async clear() {
		await this.ctx.storage.deleteAll();
	}

	/** Forget a task; returns whether it was listed. */
	async remove(id: string) {
		const keys = [...(await this.ctx.storage.list({ prefix: "task:" })).keys()].filter((key) => key.endsWith(`:${id}`));
		await this.ctx.storage.delete([...keys, `summary:task:${id}`]);
		return keys.length > 0;
	}
}
