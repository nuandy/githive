import { branchHead, type Remote, Workspace } from "../git";
import { inLane } from "../open-mode";
import type { ClaimRecord } from "./claims";

// Merge-ahead without a coordinator: an agent checks its own change early,
// against main and against every other active change's branch, instead of
// waiting for its merge to find out. It reports; it decides nothing.

export interface CheckInput {
	/** The project repo (main). */
	project: Remote;
	/** Where a change's branch lives (its fork, or the project repo). */
	source: (change: string) => Promise<Remote>;
	claims: ClaimRecord[];
	change: string;
}

export async function checkChange(input: CheckInput) {
	const { change, claims } = input;
	const ws = await Workspace.clone(input.project);
	const main = await ws.head();
	const fetchChange = async (name: string, id: string) => ws.fetch(name, await input.source(id), `changes/${id}`).catch(() => null);
	const head = await fetchChange("change", change);
	if (!head) throw new Error(`[409] changes/${change} has nothing pushed to check`);
	const changedSinceMain = async (commit: string) => (await ws.changedPaths(await ws.mergeBase(main, commit), commit)).sort();
	const files = await changedSinceMain(head);

	const own = claims.find((c) => c.change === change);
	const outsideClaim = files.filter((f) => !own || !inLane(f, own.paths));
	const withMain = await ws.tryMerge(main, head);

	// Which other changes have pushed anything: cheap ref lookups, all at once, so
	// only real branches are fetched (one at a time, into this one workspace).
	const pushed = await Promise.all(
		claims
			.filter((c) => c.change !== change)
			.map(async (other) => {
				const remote = await input.source(other.change).catch(() => null);
				const tip = remote ? await branchHead(remote, `changes/${other.change}`).catch(() => null) : null;
				return remote && tip ? { other, remote } : null;
			}),
	);
	const overlaps: { change: string; agent: string; head: string; files: string[]; conflicts: string[] }[] = [];
	for (const [i, found] of pushed.filter((p) => p !== null).entries()) {
		const { other, remote } = found;
		const theirs = await ws.fetch(`other-${i}`, remote, `changes/${other.change}`).catch(() => null);
		if (!theirs) continue;
		const touched = new Set(await changedSinceMain(theirs));
		const shared = files.filter((f) => touched.has(f));
		if (!shared.length) continue;
		const merged = await ws.tryMerge(head, theirs);
		overlaps.push({ change: other.change, agent: other.agent, head: theirs, files: shared, conflicts: merged.clean ? [] : merged.files.filter((f) => shared.includes(f)).sort() });
	}
	return { change, head, main: withMain.clean ? { head: main, clean: true } : { head: main, clean: false, conflicts: withMain.files }, outsideClaim, overlaps };
}
