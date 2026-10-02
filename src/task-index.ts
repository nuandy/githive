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
}
