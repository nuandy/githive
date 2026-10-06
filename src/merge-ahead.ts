import { remoteFor } from "./artifacts";
import { Workspace } from "./git";
import { projectBranch } from "./project-branch";
import { inLane } from "./open-mode";
import type { MergeCheck, Slice, Task } from "./types";

// Merge-ahead: test-merge a slice's pushed work against the project's branch and every
// other slice that has pushed, so conflicts show up while they are cheap to fix.

/** One side of a Merge-ahead check. */
interface Side {
	id: string;
	ref: string;
	head: string;
	touched: string[];
}

/** Test-merge a slice's pushed work. Updates `slice` (a snapshot's copy) and returns the checks. */
export async function mergeAhead(artifacts: Artifacts, task: Task, slice: Slice) {
	const baseCommit = task.baseCommit!;
	// The project's branch, and each fork's branch of the same name.
	const ws = await Workspace.clone(await remoteFor(artifacts, task.baseRepo!), projectBranch(task));
	const baseHead = await ws.head();

	// A slice's own changes start at its merge base with the task base. That is
	// the base commit until the slice merges integrated work; after that, the
	// integrated files don't count as the slice's changes.
	const side = async (s: Slice): Promise<Side & { from: string }> => {
		// Each change's branch in its fork: changes/<id>, or the fork's copy of the project's branch for older changes.
		const branch = s.ref ?? ws.branch;
		const ref = `refs/remotes/${s.id}/${branch}`;
		const head = await ws.fetch(s.id, await remoteFor(artifacts, s.repo!), branch);
		const from = await ws.mergeBase(baseHead, head);
		return { id: s.id, ref, head, from, touched: await ws.changedPaths(from, head) };
	};

	const ours = await side(slice);
	// A planned slice started at the task's base commit; an open change at the project head when it was opened.
	const start = slice.startCommit ?? baseCommit;
	slice.head = ours.head;
	slice.mergeBase = ours.from;
	slice.touched = ours.touched;
	slice.outOfLane = ours.touched.filter((p) => !inLane(p, slice.owns));

	const checks: MergeCheck[] = [];
	// Integrated slices move the base; check against it once it has.
	if (baseHead !== start) {
		const base = { id: "base", ref: ws.branch, head: baseHead, touched: await ws.changedPaths(start, baseHead) };
		checks.push(await check(ws, base, ours));
	}
	for (const other of task.slices) {
		if (other === slice || other.status !== "building") continue;
		// Nothing recorded as pushed means nothing to conflict with: skip it without
		// fetching. If it has pushed but not reported yet, its own report checks
		// it against this change.
		if (!other.head || other.head === (other.startCommit ?? baseCommit)) continue;
		const theirs = await side(other);
		if (theirs.head === (other.startCommit ?? baseCommit)) continue; // nothing pushed yet
		checks.push(await check(ws, theirs, ours));
	}
	// TODO(semantic): run the test suite on each clean merge in a Sandbox to
	// catch changes that merge cleanly but fail together.
	return checks;
}

async function check(ws: Workspace, a: Side, b: Side): Promise<MergeCheck> {
	const [first, second] = a.id < b.id ? [a, b] : [b, a];
	const shared = first.touched.filter((p) => second.touched.includes(p));
	// Git only conflicts on files both sides changed.
	const outcome = shared.length ? await ws.tryMerge(first.ref, second.ref) : null;
	return {
		pair: [first.id, second.id],
		heads: [first.head, second.head],
		status: !outcome ? "disjoint" : outcome.clean ? "clean" : "conflict",
		files: outcome && !outcome.clean ? outcome.files : [],
		checkedAt: new Date().toISOString(),
	};
}
