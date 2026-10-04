import { type Remote, Workspace } from "../git";
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

	const overlaps: { change: string; agent: string; head: string; files: string[]; conflicts: string[] }[] = [];
	for (const [i, other] of claims.filter((c) => c.change !== change).entries()) {
		const theirs = await fetchChange(`other-${i}`, other.change);
		if (!theirs) continue;
		const touched = new Set(await changedSinceMain(theirs));
		const shared = files.filter((f) => touched.has(f));
		if (!shared.length) continue;
		const merged = await ws.tryMerge(head, theirs);
		overlaps.push({ change: other.change, agent: other.agent, head: theirs, files: shared, conflicts: merged.clean ? [] : merged.files.filter((f) => shared.includes(f)).sort() });
	}
	return { change, head, main: withMain.clean ? { head: main, clean: true } : { head: main, clean: false, conflicts: withMain.files }, outsideClaim, overlaps };
}
