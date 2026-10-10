import type { Remote } from "../git";

/** Credentials for the project repo, and for its records repos when a record is spread over them. */
export interface RecordsRemotes {
	remote: () => Promise<Remote>;
	recordsRemote?: (repoIndex: number) => Promise<Remote>;
}

/**
 * The repos holding a sharded record's parts: its records repos, numbered from 0, when it's spread over them,
 * or else the project repo, numbered -1. `count` is read each time, since a record starts spreading only once.
 */
export class RecordsRepos {
	constructor(
		private readonly input: RecordsRemotes,
		private readonly count: () => number,
	) {}

	/** How many records repos the parts are spread over: 0 when they're all in the project repo. */
	get spread() {
		return this.input.recordsRemote ? this.count() : 0;
	}

	remote(repoIndex: number) {
		return repoIndex < 0 ? this.input.remote() : this.input.recordsRemote!(repoIndex);
	}

	/** Every repo that may hold parts. */
	all() {
		if (!this.spread) return [this.input.remote()];
		return Array.from({ length: this.spread }, (_, repoIndex) => this.input.recordsRemote!(repoIndex));
	}

	/** Parts grouped by the repo holding each. */
	group(parts: Iterable<string>, repoOf: (part: string) => number): Map<number, string[]> {
		const groups = new Map<number, string[]>();
		for (const part of parts) groups.set(repoOf(part), [...(groups.get(repoOf(part)) ?? []), part]);
		return groups;
	}
}
