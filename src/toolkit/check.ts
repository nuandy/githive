import { branchHead, inWorkspaceTurn, type Remote, Workspace } from "../git";
import { repoOfUrl } from "../git-http";
import { inLane } from "../claim-paths";
import { changeAgainst, type ReadHistory } from "./batch-reads";
import type { ClaimRecord } from "./claims";

// An agent's early check on its own change: does it still merge into the project's branch, and does it stay
// inside its claim. It reports and decides nothing. It doesn't test-merge other agents' changes, because claims
// are exclusive and merge refuses files outside them, so two changes that can both merge can't conflict.
//
// Many agents check at once, so a check avoids cloning. It reads the change through the Artifacts API and falls
// back to a Git workspace only when the change and the branch touched the same file.

export interface CheckInput {
	project: Remote;
	/** The project's branch the change would merge into. */
	branch: string;
	/** Where the change's branch lives (its fork, or the project repo). */
	source: Remote;
	claims: ClaimRecord[];
	change: string;
	/** A briefly cached branch head shared by concurrent calls (see ToolContext.branchHead). */
	branchHead?: () => Promise<string | null>;
	/** Reads history through the Artifacts API, so most changes are checked without a fetch. */
	history?: ReadHistory;
}

export async function checkChange(input: CheckInput) {
	const { change, claims } = input;
	// A slightly stale head is fine for an early check. Listing refs every time made check the busiest reader
	// of the project repo.
	const listed =
		(input.branchHead ? await input.branchHead().catch(() => undefined) : undefined) ??
		(await branchHead(input.project, input.branch));
	if (!listed) throw new Error(`[409] ${input.branch} doesn't exist yet`);
	const own = claims.find((c) => c.change === change);
	// If no file changed on both sides, the change merges cleanly and nothing needs fetching.
	const read = input.history
		? await changeAgainst(input.history, repoOfUrl(input.project.url), input.branch, listed, {
				ref: `changes/${change}`,
				source: input.source,
			}).catch(() => null)
		: null;
	if (read && "error" in read) throw new Error(`[409] changes/${change} has nothing pushed to check`);
	if (read && !read.both.length)
		return {
			change,
			head: read.head,
			branch: input.branch,
			main: { head: listed, clean: true },
			outsideClaim: read.files.filter((f) => !own || !inLane(f, own.paths)),
		};
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
			// `main` in the result means this branch, whatever its name.
			branch: ws.branch,
			main: withMain.clean ? { head: main, clean: true } : { head: main, clean: false, conflicts: withMain.files },
			outsideClaim: files.filter((f) => !own || !inLane(f, own.paths)),
		};
	});
}
