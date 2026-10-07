import { type Remote, Workspace } from "../git";
import { inLane } from "../claim-paths";
import type { ClaimRecord } from "./claims";

// An agent's early check on its own change, before merging: does it still
// merge into the project's branch, and is everything it changed inside its claim. It reports;
// it decides nothing.
//
// It doesn't test-merge other agents' changes. Claims are exclusive and merge refuses files
// outside them, so two changes that can both merge touch disjoint files and
// can't conflict; an overlap means someone is outside their claim, which their
// own check shows them. Checking every other change would cost a fetch each.

export interface CheckInput {
	/** The project repo. */
	project: Remote;
	/** The project's branch the change would merge into. */
	branch: string;
	/** Where the change's branch lives (its fork, or the project repo). */
	source: Remote;
	claims: ClaimRecord[];
	change: string;
}

export async function checkChange(input: CheckInput) {
	const { change, claims } = input;
	const ws = await Workspace.clone(input.project, input.branch);
	const main = await ws.head();
	const head = await ws.fetch("change", input.source, `changes/${change}`).catch(() => null);
	if (!head) throw new Error(`[409] changes/${change} has nothing pushed to check`);
	const files = (await ws.changedPaths(await ws.mergeBase(main, head), head)).sort();
	const own = claims.find((c) => c.change === change);
	const withMain = await ws.tryMerge(main, head);
	return {
		change,
		head,
		/** The project's branch it was checked against (the result's `main` is that branch, whatever its name). */
		branch: ws.branch,
		main: withMain.clean ? { head: main, clean: true } : { head: main, clean: false, conflicts: withMain.files },
		outsideClaim: files.filter((f) => !own || !inLane(f, own.paths)),
	};
}
