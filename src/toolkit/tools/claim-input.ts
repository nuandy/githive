import { claimCovering, normalizeClaim } from "../../claim-paths";
import { fail, optionalString, requiredPaths, requiredString } from "../../errors";
import { branchHead, type Remote, Workspace } from "../../git";
import { projectBranch } from "../../project-branch";
import { GitCasLog } from "../../record-log";
import { recordBranch, type Registry } from "../claims";
import type { Stamper } from "../stamp";
import { workId } from "../work";
import type { ToolContext } from "./context";

// Parsing a claim's input: the branch it goes into, a branch it merges, its dependencies, and backlog items.

/**
 * A change that merges branch `source` into `into` whole. Its claim is the files `source` changed since
 * it left `into`, and its tip becomes the change's branch, so it's reviewed, checked and merged as usual.
 */
export async function branchMerge(ctx: ToolContext, repo: string, source: string, into: string) {
	if (source === into) fail(400, `a change can't merge ${into} into itself`);
	const project = await ctx.remote(repo, "read");
	const workspace = await Workspace.clone(project, into).catch(() => fail(409, `there's no branch ${into}`));
	const tip = await workspace.fetch("source", project, source).catch(() => fail(409, `there's no branch ${source}`));
	const files = await workspace.changedPaths(await workspace.mergeBase(await workspace.head(), tip), tip);
	if (!files.length) fail(409, `${source} has nothing ${into} doesn't have`);
	const paths =
		claimCovering(files) ?? fail(409, `${source} changes too much of ${into} to claim at once: merge it in parts`);
	return {
		tip,
		paths,
		// Push from the shallow workspace, or with the source's full history if the fork lacks what it leaves out.
		push: async (fork: Remote, change: string) => {
			const to = `refs/heads/changes/${change}`;
			const pushWithHistory = async () => {
				const full = await Workspace.clone(project, source, { depth: 1 << 20 });
				await full.pushAs(`refs/heads/${source}`, to, fork);
			};
			await workspace.pushAs(`refs/remotes/source/${source}`, to, fork).catch(pushWithHistory);
		},
	};
}

/** Parses a work item for add_work, given alone or as one of its items. */
export function workItemFrom(args: Record<string, unknown>) {
	const title = requiredString(args, "title");
	const id = optionalString(args, "id") ?? workId(title);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) fail(400, "a work id is letters, digits, dots, dashes and underscores");
	const paths = args.paths === undefined ? undefined : normalizeClaim(requiredPaths(args, "paths"));
	const after = changeList(args.after, "after");
	return {
		id,
		title,
		intent: requiredString(args, "intent"),
		...(paths ? { paths } : {}),
		...(after.length ? { after } : {}),
	};
}

export function changeList(value: unknown, field: string): string[] {
	if (value === undefined) return [];
	const isChangeId = (item: unknown) => typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item);
	if (!Array.isArray(value) || !value.every(isChangeId)) fail(400, `${field} is a list of change ids`);
	return [...new Set(value as string[])];
}

/** The loop `change` would close by waiting on `after` (searching up to 50 changes), or undefined. */
export async function dependencyLoop(
	change: string,
	after: string[],
	afterOf: (change: string) => Promise<string[]>,
): Promise<string[] | undefined> {
	const paths: string[][] = after.map((dependency) => [change, dependency]);
	const seen = new Set<string>();
	while (paths.length && seen.size < 50) {
		const path = paths.shift()!;
		const last = path.at(-1)!;
		if (last === change) return path;
		if (seen.has(last)) continue;
		seen.add(last);
		for (const next of await afterOf(last)) paths.push([...path, next]);
	}
	return undefined;
}

/** Branch names changes may land on: a safe subset of what Git allows. */
const BRANCH_NAME = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)(?!.*[/.]$)[A-Za-z0-9._/-]+$/;

/**
 * Makes sure a branch other than the project's can take changes: already recorded, adopted as it is, or made
 * from `from`. A missing branch is never made without `from`, so a misspelt name is refused. The branch is
 * made before it's recorded, so a failed record is repaired on the next claim. Returns what it did, if anything.
 */
export async function targetBranch(
	ctx: ToolContext,
	repo: string,
	input: {
		into: string;
		from?: string;
		registered: Registry | null | undefined;
		claims: GitCasLog<Registry>;
		agent: string;
		stamper?: Stamper;
	},
): Promise<string | undefined> {
	const { into, from, registered, claims, agent, stamper } = input;
	if (!BRANCH_NAME.test(into)) fail(400, `${into} isn't a branch name changes can land on`);
	if (registered?.branches?.[into]) return undefined;
	const found = await branchHead(await ctx.remote(repo, "read"), into);
	if (found) {
		await recordBranch(claims, { name: into, base: found, agent }, stamper);
		return `changes land on ${into} from now on, as it is at ${found.slice(0, 8)}`;
	}
	if (!from)
		fail(
			409,
			`${into} doesn't exist: claim again with from (the branch to make it from, ${projectBranch(registered)} say)`,
		);
	const workspace = await Workspace.clone(await ctx.remote(repo, "write"), from, { depth: 1 }).catch(() =>
		fail(409, `can't make ${into} from ${from}: there's no branch ${from}`),
	);
	await workspace.pushNewBranch(into);
	const base = await workspace.head();
	await recordBranch(claims, { name: into, base, from, agent }, stamper);
	return `made ${into} from ${from} at ${base.slice(0, 8)}`;
}
