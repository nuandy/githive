import { DurableObject } from "cloudflare:workers";

// One instance lists every task, so the dashboard can show them. Coordinators
// hold each task's state; this only remembers which tasks exist.

export interface TaskRef {
	id: string;
	repo: string;
	goal: string;
	createdAt: string;
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

	/** Every task on a repo. */
	async onRepo(repo: string) {
		const entries = await this.ctx.storage.list<TaskRef>({ prefix: "task:" });
		return [...entries.values()].filter((ref) => ref.repo === repo);
	}

	/** Forget a task; returns whether it was listed. */
	async remove(id: string) {
		const keys = [...(await this.ctx.storage.list({ prefix: "task:" })).keys()].filter((key) => key.endsWith(`:${id}`));
		await this.ctx.storage.delete(keys);
		return keys.length > 0;
	}
}
