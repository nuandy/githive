import { branchHead, type Hunk, inWorkspaceTurn, type Remote, Workspace } from "../git";
import { repoOfUrl } from "../git-http";
import { inLane } from "../claim-paths";
import { busyArtifacts, changeAgainst, type ReadHistory, touchedInWorkspace } from "./batch-reads";
import type { ClaimRecord } from "./claims";
import { fail } from "../errors";

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
	const cachedHead = input.branchHead ? await input.branchHead().catch(() => undefined) : undefined;
	const listed = cachedHead ?? (await branchHead(input.project, input.branch));
	if (!listed) fail(409, `${input.branch} doesn't exist yet`);
	const own = claims.find((claim) => claim.change === change);
	const outsideClaim = (files: string[]) => files.filter((file) => !own || !inLane(file, own.paths));
	// If no file changed on both sides, the change merges cleanly and nothing needs fetching.
	const compared = input.history
		? await changeAgainst(input.history, repoOfUrl(input.project.url), input.branch, listed, {
				ref: `changes/${change}`,
				source: input.source,
			}).catch((err) => busyArtifacts(change, err))
		: null;
	if (compared && "error" in compared) fail(409, `changes/${change} has nothing pushed to check`);
	if (compared && !compared.both.length)
		return {
			change,
			head: compared.head,
			branch: input.branch,
			main: { head: listed, clean: true as const },
			outsideClaim: outsideClaim(compared.files),
		};
	return inWorkspaceTurn(async () => {
		const workspace = await Workspace.at(input.project, input.branch, listed);
		const main = await workspace.head();
		const head = await workspace.fetch("change", input.source, `changes/${change}`).catch(() => null);
		if (!head) fail(409, `changes/${change} has nothing pushed to check`);
		const base = await workspace.mergeBase(main, head);
		const files = (await workspace.changedPaths(base, head)).sort();
		// The change's side first, as `git merge origin/<branch>` shows it in the agent's clone.
		const labels = { ours: `ours (changes/${change})`, theirs: `origin/${input.branch}` };
		const withMain = await workspace.tryMerge(head, main, labels);
		return {
			change,
			head,
			// `main` in the result means this branch, whatever its name.
			branch: workspace.branch,
			main: withMain.clean ? { head: main, clean: true as const } : await conflictWith(workspace, main, base, withMain),
			outsideClaim: outsideClaim(files),
		};
	});
}

// A conflict with the branch: its files, their markers, and the branch's commits that changed them since the change
// left it, read from the history the workspace already holds.
async function conflictWith(
	workspace: Workspace,
	main: string,
	base: string,
	tried: { files: string[]; hunks?: Hunk[] },
) {
	const touchedBy = await touchedInWorkspace(workspace, main, base, tried.files).catch((err) => {
		console.error("reading who changed the conflicted files failed", String(err));
		return [];
	});
	return {
		head: main,
		clean: false as const,
		conflicts: tried.files,
		...(touchedBy.length ? { touchedBy } : {}),
		...(tried.hunks?.length ? { hunks: tried.hunks } : {}),
	};
}
