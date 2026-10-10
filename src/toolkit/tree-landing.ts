import git from "isomorphic-git";
import { BOT, branchHead, type Remote } from "../git";
import { repoOfUrl } from "../git-http";
import { fetchPackSince, receivePack, type RefUpdate } from "../git-pack";
import { MemoryFS } from "../memory-fs";
import { jitteredDelay, sleep } from "../retry";
import { placeBatch, type Placed, type ReadHistory } from "./batch-reads";
import { filesBetween, type TreeEntry } from "./branch-history";
import { mergeMessage } from "./merge-commit";
import { atMost, type BatchGit } from "./merge";
import { makeStamper, type Stamper } from "./stamp";

// Lands a batch in the Worker, without a container and without a checkout. Claims keep a batch's changes apart, so
// each merge is main's tree with the change's files put in place: only the trees along those paths are read
// (through the Artifacts API) and written. The objects a change adds come from its fork as the server packs them,
// pushed into the project under a ref of their own, and the merges then land in one push with a lease on the base.
// It makes the same commits the Gate's `git merge --no-ff` would. When it can't be sure of that (a change and main
// both touched a file, or a change it can't place on the branch), the batch lands in the Gate instead.

const DIR = "/landing";

/** Where a change's objects wait in the project repo until its merge lands. */
export const INCOMING = "refs/notes/githive-incoming/";

/** A change adding more than this lands in the Gate, which streams it, rather than in the Worker's memory. */
const PACK_MOST = 16 * 1024 * 1024;

const TRANSFERS_AT_ONCE = 4;
const PUSH_ATTEMPTS = 6;

export interface TreeLandingInput {
	history: ReadHistory;
	/** The project repo's name for the Artifacts API, and its credentials. */
	project: string;
	remote: (scope: "read" | "write") => Promise<Remote>;
	/** GitHive's key, to stamp each merge for whoever asked, as the Gate does. */
	stampKey?: string;
	/** Lands the batch in the Gate, when this can't. */
	fallback: BatchGit["land"];
}

type LandInput = Parameters<BatchGit["land"]>[0];
type Merge = LandInput["merges"][number];

/** BatchGit's land, done with trees in the Worker; the Gate's when a batch needs a real merge. */
export function treeLanding(input: TreeLandingInput): BatchGit["land"] {
	return async (batch) => {
		const plan = await planLanding(input, batch);
		if ("gate" in plan) {
			console.log(`landing ${batch.merges.length} in the Gate: ${plan.gate}`);
			return input.fallback(batch);
		}
		const write = await input.remote("write");
		const staged = await stageChanges(write, batch.merges, plan.placed);
		if ("gate" in staged) {
			console.log(`landing ${batch.merges.length} in the Gate: ${staged.gate}`);
			return input.fallback(batch);
		}
		const stamper =
			batch.stamper ?? (input.stampKey && batch.by ? await makeStamper(input.stampKey, batch.by) : undefined);
		const built = await buildMerges(input, batch, plan, stamper);
		return pushMerges(write, batch, built, staged.refs);
	};
}

type Plan = { gate: string } | { baseTree: string; placed: Placed[] };

/** Places each change on the branch, and checks no change touches a file main or an earlier change touched. */
async function planLanding(input: TreeLandingInput, batch: LandInput): Promise<Plan> {
	const placing = await placeBatch(input.history, input.project, batch.branch, batch.base, batch.merges);
	if (!placing) return { gate: "a change can't be placed on the branch through the Artifacts API" };
	const { tip, placed } = placing;
	const moved = placed.findIndex((each, index) => each.head.hash !== batch.merges[index]?.head);
	if (moved >= 0) return { gate: `${batch.merges[moved]?.change}'s branch moved since it was read` };
	const landedFirst: string[] = [];
	for (const [index, each] of placed.entries()) {
		const sinceLeft =
			each.base.hash === tip.hash
				? []
				: await input.history(input.project, (source) => filesBetween(source, each.base.treeHash, tip.treeHash));
		const both = each.files.filter((file) => [...sinceLeft, ...landedFirst].some((other) => touches(file, other)));
		if (both.length) return { gate: `${batch.merges[index]?.change} and the branch both changed ${both.join(", ")}` };
		landedFirst.push(...each.files);
	}
	return { baseTree: tip.treeHash, placed };
}

const touches = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * Copies the objects each change adds from its fork into the project repo, under a ref of its own, so its merge
 * can name it. A change on a branch of the project repo already has them there.
 */
async function stageChanges(
	write: Remote,
	merges: Merge[],
	placed: Placed[],
): Promise<{ gate: string } | { refs: RefUpdate[] }> {
	const staged = await atMost(TRANSFERS_AT_ONCE, merges, async (merge, index): Promise<RefUpdate | string | null> => {
		if (!merge.source) return null;
		const base = placed[index]!.base.hash;
		const pack = await fetchPackSince(merge.source, merge.head, [base]);
		if (pack.length > PACK_MOST) return `${merge.change} adds ${Math.round(pack.length / 1e6)} MB`;
		const ref = `${INCOMING}${merge.head}`;
		const report = await pushWithRetries(write, [{ ref, from: null, to: merge.head }], pack);
		if ("busy" in report) return `the project repo stayed busy taking ${merge.change}'s objects`;
		const result = report.refs.get(ref);
		// Already there from an earlier attempt: its objects are too.
		if (report.unpack !== "ok" || (result !== true && !/exist/i.test(String(result))))
			return `${merge.change}'s objects weren't taken: ${report.unpack}, ${String(result)}`;
		return { ref, from: merge.head, to: null };
	});
	const failed = staged.find((each): each is string => typeof each === "string");
	if (failed) return { gate: failed };
	return { refs: staged.filter((each): each is RefUpdate => !!each && typeof each !== "string") };
}

type Built = { fs: MemoryFS; objects: string[]; commits: string[]; tip: string };

/** Writes each merge's trees and commit in memory, each on top of the one before. */
async function buildMerges(
	input: TreeLandingInput,
	batch: LandInput,
	plan: { baseTree: string; placed: Placed[] },
	stamper: Stamper | undefined,
): Promise<Built> {
	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR });
	const written = new Map<string, TreeEntry[]>();
	const objects: string[] = [];
	const writeTree = async (entries: TreeEntry[]) => {
		const tree = entries.map((entry) => ({ mode: entry.mode, path: entry.name, oid: entry.hash, type: entry.type }));
		const oid = await git.writeTree({ fs, dir: DIR, tree: tree as Parameters<typeof git.writeTree>[0]["tree"] });
		if (!written.has(oid)) objects.push(oid);
		written.set(oid, entries);
		return oid;
	};
	const reader = (repo: string) => async (hash: string) =>
		written.get(hash) ?? (await input.history(repo, (source) => source.readTree(hash))) ?? [];
	const readMain = reader(input.project);
	const commits: string[] = [];
	let tip = batch.base;
	let tipTree = plan.baseTree;
	for (const [index, merge] of batch.merges.entries()) {
		const placed = plan.placed[index]!;
		const readChange = reader(merge.source ? repoOfUrl(merge.source.url) : input.project);
		const entries = await graft(
			{ main: readMain, change: readChange, write: writeTree },
			await readMain(tipTree),
			await readChange(placed.head.treeHash),
			placed.files.map((file) => file.split("/")),
		);
		tipTree = await writeTree(entries);
		const message = cleanMessage(await mergeMessage({ ...merge.claimed, base: tip }, stamper));
		const signature = { ...BOT, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
		tip = await git.writeCommit({
			fs,
			dir: DIR,
			commit: { tree: tipTree, parent: [tip, merge.head], author: signature, committer: signature, message },
		});
		objects.push(tip);
		commits.push(tip);
	}
	return { fs, objects, commits, tip };
}

interface Trees {
	main: (hash: string) => Promise<TreeEntry[]>;
	change: (hash: string) => Promise<TreeEntry[]>;
	write: (entries: TreeEntry[]) => Promise<string>;
}

/**
 * Main's folder with the change's version of each path in `paths` (split into segments) put in place: added,
 * edited, deleted, or turned from a file into a folder or back. Folders left empty are dropped, as in git.
 */
async function graft(trees: Trees, mine: TreeEntry[], theirs: TreeEntry[], paths: string[][]): Promise<TreeEntry[]> {
	const entries = new Map(mine.map((entry) => [entry.name, entry]));
	const theirEntries = new Map(theirs.map((entry) => [entry.name, entry]));
	const byName = new Map<string, string[][]>();
	for (const [name, ...rest] of paths) if (name) byName.set(name, [...(byName.get(name) ?? []), rest]);
	for (const [name, rests] of byName) {
		const their = theirEntries.get(name);
		if (rests.some((rest) => !rest.length)) {
			// The path itself changed. A file takes its place whole; a folder is put together below.
			if (their && their.type !== "tree") {
				entries.set(name, their);
				continue;
			}
			entries.delete(name);
			if (!their) continue;
		}
		const deeper = rests.filter((rest) => rest.length);
		if (!deeper.length) continue;
		const ours = entries.get(name);
		const ourFolder = ours?.type === "tree" ? await trees.main(ours.hash) : [];
		const theirFolder = their?.type === "tree" ? await trees.change(their.hash) : [];
		const folder = await graft(trees, ourFolder, theirFolder, deeper);
		if (!folder.length) entries.delete(name);
		else entries.set(name, { name, mode: "40000", type: "tree", hash: await trees.write(folder) });
	}
	return [...entries.values()];
}

/** As `git commit` tidies a message: no trailing spaces, no blank lines at the ends or twice, a final newline. */
function cleanMessage(message: string) {
	const lines = message.split("\n").map((line) => line.trimEnd());
	const kept = lines.filter((line, index) => line || (index > 0 && lines[index - 1]));
	while (kept.length && !kept[0]) kept.shift();
	while (kept.length && !kept.at(-1)) kept.pop();
	return `${kept.join("\n")}\n`;
}

/**
 * Pushes the merges and moves the branch from the base to the last one, removing the changes' staging refs in the
 * same request. "moved" if the branch is no longer at the base.
 */
async function pushMerges(
	write: Remote,
	batch: LandInput,
	built: Built,
	staged: RefUpdate[],
): Promise<{ commits: string[] } | "moved"> {
	const { packfile } = await git.packObjects({ fs: built.fs, dir: DIR, oids: built.objects });
	const branchRef = `refs/heads/${batch.branch}`;
	const update = { ref: branchRef, from: batch.base, to: built.tip };
	let report;
	try {
		report = await pushWithRetries(write, [update, ...staged], packfile);
	} catch (err) {
		// A server error may come after the push applied: the branch then tells.
		const now = await branchHead(write, batch.branch).catch(() => null);
		if (now === built.tip) return { commits: built.commits };
		if (now !== batch.base) return "moved";
		throw err;
	}
	if ("busy" in report) throw new Error("[503] the project repo stayed busy, so the batch didn't land");
	const result = report.refs.get(branchRef);
	if (report.unpack === "ok" && result === true) return { commits: built.commits };
	// Refused: most likely the lease, because another landing moved the branch. The branch tells.
	const now = await branchHead(write, batch.branch).catch(() => null);
	if (now !== null && now !== batch.base) return "moved";
	throw new Error(`[500] landing the batch failed: unpack ${report.unpack}, ${batch.branch}: ${String(result)}`);
}

/** A receive-pack request sent again while the repo answers that it's busy, which applies nothing. */
async function pushWithRetries(write: Remote, updates: RefUpdate[], pack: Uint8Array | undefined) {
	for (let attempt = 1; ; attempt++) {
		const report = await receivePack(write, updates, pack);
		if (!("busy" in report) || attempt === PUSH_ATTEMPTS) return report;
		await sleep(jitteredDelay(attempt, 100, 2_000));
	}
}
