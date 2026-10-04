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

export class TaskIndex extends DurableObject<Env> {
	async add(ref: TaskRef) {
		// Keys sort by creation time, so a reverse list is newest first.
		await this.ctx.storage.put(`task:${ref.createdAt}:${ref.id}`, ref);
	}

	async list(limit = 50) {
		const entries = await this.ctx.storage.list<TaskRef>({ prefix: "task:", reverse: true, limit });
		return [...entries.values()];
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

	/** Forget a task; returns whether it was listed. */
	async remove(id: string) {
		const keys = [...(await this.ctx.storage.list({ prefix: "task:" })).keys()].filter((key) => key.endsWith(`:${id}`));
		await this.ctx.storage.delete(keys);
		return keys.length > 0;
	}
}
