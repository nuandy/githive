import { branchHead, inWorkspaceTurn, type Remote, Workspace } from "../git";
import { repoOfUrl } from "../git-http";
import { inLane } from "../claim-paths";
import { changeAgainst, type ReadHistory } from "./batch-reads";
import type { ClaimRecord } from "./claims";

// An agent's early check on its own change, before merging: does it still
// merge into the project's branch, and is everything it changed inside its claim. It reports;
// it decides nothing.
//
// It doesn't test-merge other agents' changes. Claims are exclusive and merge refuses files
// outside them, so two changes that can both merge touch disjoint files and
// can't conflict; an overlap means someone is outside their claim, which their
// own check shows them. Checking every other change would cost a fetch each.
//
// Many agents check at once, so a check doesn't clone the project: it reads
// the change through Artifacts' API where it can (see changeAgainst), test-
// merging it in memory only when it and the branch changed the same file; else
// it lists the branch's head and reads the branch from a copy kept while it
// hasn't moved.

export interface CheckInput {
	/** The project repo. */
	project: Remote;
	/** The project's branch the change would merge into. */
	branch: string;
	/** Where the change's branch lives (its fork, or the project repo). */
	source: Remote;
	claims: ClaimRecord[];
	change: string;
	/** The branch's head as kept a moment for every call reading it (see ToolContext.branchHead), if there is one: then no listing. */
	branchHead?: () => Promise<string | null>;
	/** Reads repos' history through Artifacts' API: the change is read that way, without a fetch, where it can be. */
	history?: ReadHistory;
}

export async function checkChange(input: CheckInput) {
	const { change, claims } = input;
	// The branch's head as kept a moment (an early check needn't be on main as of this second), else one ref listing on
	// the project, which made check the busiest reader of a busy project repo; its objects are kept between checks (see
	// Workspace.at).
	const listed = (input.branchHead ? await input.branchHead().catch(() => undefined) : undefined) ?? (await branchHead(input.project, input.branch));
	if (!listed) throw new Error(`[409] ${input.branch} doesn't exist yet`);
	const own = claims.find((c) => c.change === change);
	// Through Artifacts' API: no file changed on both sides, it merges cleanly, with nothing fetched.
	const read = input.history ? await changeAgainst(input.history, repoOfUrl(input.project.url), input.branch, listed, { ref: `changes/${change}`, source: input.source }).catch(() => null) : null;
	if (read && "error" in read) throw new Error(`[409] changes/${change} has nothing pushed to check`);
	if (read && !read.both.length)
		return { change, head: read.head, branch: input.branch, main: { head: listed, clean: true }, outsideClaim: read.files.filter((f) => !own || !inLane(f, own.paths)) };
	// Its Git work in turn with the isolate's other calls (see inWorkspaceTurn).
	return inWorkspaceTurn(async () => {
		const ws = await Workspace.at(input.project, input.branch, listed);
		const main = await ws.head();
		const head = await ws.fetch("change", input.source, `changes/${change}`).catch(() => null);
		if (!head) throw new Error(`[409] changes/${change} has nothing pushed to check`);
		const files = (await ws.changedPaths(await ws.mergeBase(main, head), head)).sort();
		const withMain = await ws.tryMerge(main, head);
		return {
			change,
			head,
			/** The project's branch it was checked against (the result's `main` is that branch, whatever its name). */
			branch: ws.branch,
			main: withMain.clean ? { head: main, clean: true } : { head: main, clean: false, conflicts: withMain.files },
			outsideClaim: files.filter((f) => !own || !inLane(f, own.paths)),
		};
	});
}
