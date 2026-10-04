import { type Remote, Workspace } from "../git";
import { inLane } from "../open-mode";
import type { ClaimRecord } from "./claims";

// An agent's early check on its own change, before merging: does it still
// merge into main, and is everything it changed inside its claim. It reports;
// it decides nothing.
//
// It doesn't test-merge other agents' changes (Merge-ahead, as the
// coordinators run it). Claims are exclusive and free_merge refuses files
// outside them, so two changes that can both merge touch disjoint files and
// can't conflict; an overlap means someone is outside their claim, which their
// own check shows them. Checking every other change would cost a fetch each.

export interface CheckInput {
	/** The project repo (main). */
	project: Remote;
	/** Where the change's branch lives (its fork, or the project repo). */
	source: Remote;
	claims: ClaimRecord[];
	change: string;
}

export async function checkChange(input: CheckInput) {
	const { change, claims } = input;
	const ws = await Workspace.clone(input.project);
	const main = await ws.head();
	const head = await ws.fetch("change", input.source, `changes/${change}`).catch(() => null);
	if (!head) throw new Error(`[409] changes/${change} has nothing pushed to check`);
	const files = (await ws.changedPaths(await ws.mergeBase(main, head), head)).sort();
	const own = claims.find((c) => c.change === change);
	const withMain = await ws.tryMerge(main, head);
	return {
		change,
		head,
		main: withMain.clean ? { head: main, clean: true } : { head: main, clean: false, conflicts: withMain.files },
		outsideClaim: files.filter((f) => !own || !inLane(f, own.paths)),
	};
}
