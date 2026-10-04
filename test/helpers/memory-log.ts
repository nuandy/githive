import type { CasLog, LogCommit } from "../../src/election";

/** An in-memory ref with Git's push semantics: an append lands only on the tip it was built on. */
export class MemoryLog<S> implements CasLog<S> {
	commits: { id: string; parent: string | null; commit: LogCommit<S> }[] = [];
	/** Runs before the next append lands; lets a test interleave another writer. */
	beforeAppend: (() => Promise<void>) | null = null;

	tip() {
		return this.commits.at(-1) ?? null;
	}
	async read() {
		const tip = this.tip();
		return tip ? { tip: tip.id, commit: structuredClone(tip.commit) } : null;
	}
	async append(parent: string | null, commit: LogCommit<S>) {
		const hook = this.beforeAppend;
		this.beforeAppend = null;
		await hook?.();
		if ((this.tip()?.id ?? null) !== parent) return null;
		const id = `c${this.commits.length + 1}`;
		this.commits.push({ id, parent, commit: structuredClone(commit) });
		return id;
	}
}
