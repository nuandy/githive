import git from "isomorphic-git";
import { BOT, branchHead, type Remote } from "../git";
import { repoOfUrl } from "../git-http";
import { concat } from "../git-fetch";
import { Chunks, fetchPackSince, receivePack } from "../git-pack";
import { MemoryFS } from "../memory-fs";
import { jitteredDelay, sleep } from "../retry";
import { placeBatch, type Placed, type ReadHistory } from "./batch-reads";
import type { TreeEntry } from "./branch-history";
import { mergeMessage } from "./merge-commit";
import { atMost, type BatchChange, type BatchGit } from "./merge";
import { makeStamper, type Stamper } from "./stamp";
import { cachingHistory, changedAlong } from "./tree-reads";

// Lands a batch in the Worker, without a container and without a checkout. Claims keep a batch's changes apart, so
// each merge is main's tree with the change's files put in place: only the trees along those paths are read
// (through the Artifacts API) and written. The objects a change adds come from its fork as the server packs them,
// and land with the merges in one push, with a lease on the base.
// It makes the same commits the Gate's `git merge --no-ff` would. When it can't be sure of that (a change and main
// both touched a file, or a change it can't place on the branch), the batch lands in the Gate instead.

const DIR = "/landing";

/**
 * A batch whose changes add more than this lands in the Gate, which streams it, rather than in the Worker. A landing
 * holds about one copy of what its changes add, and landings for other repos may share the isolate's 128 MB.
 */
const PACKS_MOST = 16 * 1024 * 1024;

const FETCHES_AT_ONCE = 4;
const CHECKS_AT_ONCE = 6;
const PUSH_ATTEMPTS = 6;

/** The packs merges fetched for their changes while they waited, by change head. */
export interface ChangePacks {
	keep(head: string, pack: Uint8Array): Promise<void>;
	read(heads: string[]): Promise<Record<string, Uint8Array>>;
}

/** What a landing reads: the repos, through the Artifacts API and Git, and the packs kept for it. */
export interface TreeReads {
	history: ReadHistory;
	/** The project repo's name for the Artifacts API, and its credentials. */
	project: string;
	remote: (scope: "read" | "write") => Promise<Remote>;
	packs?: ChangePacks;
}

export interface TreeLandingInput extends TreeReads {
	/** GitHive's key, to stamp each merge for whoever asked, as the Gate does. */
	stampKey?: string;
	/** Lands the batch in the Gate, when this can't. */
	fallback: BatchGit["land"];
}

/** A change pack bigger than this isn't kept: its landing fetches it. */
const KEPT_PACK_MOST = 1024 * 1024;

/**
 * Fetches a merge's own change from its fork while the merge waits for its turn, and keeps it for the batch that
 * lands it, so that landing, which holds every other merge up, needn't wait on the fork. Artifacts takes seconds to
 * work out any pack, however small.
 */
export async function prefetchChange(input: TreeReads, branch: string, change: BatchChange) {
	if (!input.packs || !change.source) return;
	const tip = await branchHead(await input.remote("read"), branch);
	if (!tip) return;
	const placing = await placeBatch(input.history, input.project, branch, tip, [change]);
	const placed = placing?.placed[0];
	if (!placed || placed.head.hash !== change.head) return;
	const pack = await fetchPackSince(change.source, [change.head], [placed.base.hash], { bytes: KEPT_PACK_MOST });
	if (pack !== "too big") await input.packs.keep(change.head, concat(pack.parts));
}

type LandInput = Parameters<BatchGit["land"]>[0];
type Merge = LandInput["merges"][number];

/**
 * BatchGit's land, done with trees in the Worker; the Gate's when a batch needs a real merge, or when anything here
 * fails, so a merge is never refused for this. Logs one line per batch: each step's time and how it ended.
 */
export function treeLanding(input: TreeLandingInput): BatchGit["land"] {
	return async (batch) => {
		const steps = stepTimer();
		let gate: string;
		try {
			const landed = await landWithTrees(input, batch, steps.mark);
			if (landed === "moved" || !("gate" in landed)) {
				console.log(`tree landing of ${batch.merges.length}: ${steps.done()}; ${describe(landed)}`);
				return landed;
			}
			gate = landed.gate;
		} catch (err) {
			gate = `it failed: ${err instanceof Error ? err.message : String(err)}`;
		}
		console.log(`tree landing of ${batch.merges.length}: ${steps.done()}; in the Gate, because ${gate}`);
		return input.fallback(batch);
	};
}

type TreeLanded = { commits: string[] } | "moved" | { gate: string };

async function landWithTrees(
	input: TreeLandingInput,
	batch: LandInput,
	mark: (step: string) => void,
): Promise<TreeLanded> {
	// One read cache for the whole landing: placing, checking and building read many of the same trees.
	const reads = { ...input, history: cachingHistory(input.history) };
	const plan = await planLanding(reads, batch);
	mark("planned");
	if ("gate" in plan) return plan;
	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR });
	const fetched = await fetchChanges(input, batch.merges, plan.placed);
	mark("packs" in fetched ? `fetched ${megabytes(fetched.packs)} (${fetched.kept} kept)` : "fetched");
	if ("gate" in fetched) return fetched;
	const built = await buildMerges(fs, reads, batch, plan, await stamperFor(input, batch));
	mark(`built ${built.objects.length} objects`);
	const pushed = await pushMerges(await input.remote("write"), batch, built, fetched.packs);
	mark("pushed");
	return pushed;
}

/** Each step's time since the one before, for the batch's log line. */
function stepTimer() {
	const started = Date.now();
	let last = started;
	const steps: string[] = [];
	return {
		mark: (step: string) => {
			steps.push(`${step} ${Date.now() - last} ms`);
			last = Date.now();
		},
		done: () => `${steps.join(", ")} (${Date.now() - started} ms)`,
	};
}

const megabytes = (packs: Chunks[]) => `${(packs.reduce((total, pack) => total + pack.length, 0) / 1e6).toFixed(2)} MB`;

const describe = (landed: { commits: string[] } | "moved") =>
	landed === "moved" ? "the branch moved" : `landed ${landed.commits.length}`;

type Plan = { gate: string } | { baseTree: string; placed: Placed[] };

/** Places each change on the branch, and checks no change touches a file main or an earlier change touched. */
async function planLanding(input: TreeReads, batch: LandInput): Promise<Plan> {
	const placing = await placeBatch(input.history, input.project, batch.branch, batch.base, batch.merges);
	if (!placing) return { gate: "a change can't be placed on the branch through the Artifacts API" };
	const { tip, placed } = placing;
	const moved = placed.findIndex((each, index) => each.head.hash !== batch.merges[index]?.head);
	if (moved >= 0) return { gate: `${batch.merges[moved]?.change}'s branch moved since it was read` };
	const readTree = (hash: string) => input.history(input.project, (source) => source.readTree(hash));
	// The branch's side, read only along each change's own paths: what main changed elsewhere doesn't matter.
	const changedOnBranch = await atMost(CHECKS_AT_ONCE, placed, (each) =>
		each.base.hash === tip.hash
			? Promise.resolve([])
			: changedAlong(readTree, each.base.treeHash, tip.treeHash, each.files),
	);
	const landedFirst: string[] = [];
	for (const [index, each] of placed.entries()) {
		const byEarlier = each.files.filter((file) => landedFirst.some((other) => touches(file, other)));
		const both = [...changedOnBranch[index]!, ...byEarlier];
		if (both.length) return { gate: `${batch.merges[index]?.change} and the branch both changed ${both.join(", ")}` };
		landedFirst.push(...each.files);
	}
	return { baseTree: tip.treeHash, placed };
}

const touches = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** Who the merges are stamped for: the caller's stamper, or GitHive's key for `by`, as the Gate stamps. */
async function stamperFor(input: TreeLandingInput, batch: LandInput): Promise<Stamper | undefined> {
	if (batch.stamper) return batch.stamper;
	if (!input.stampKey || !batch.by) return undefined;
	return makeStamper(input.stampKey, batch.by);
}

/**
 * The packs of objects the changes add beyond their merge bases, kept by the merges that waited for this batch or
 * else fetched, one fetch per fork, as the server sent them, to join into the landing's push. A fork with several
 * changes in the batch is fetched once for all of them, so no object is in the push twice. A change on a branch of
 * the project repo already has its objects there.
 */
async function fetchChanges(
	input: TreeReads,
	merges: Merge[],
	placed: Placed[],
): Promise<{ gate: string } | { packs: Chunks[]; kept: number }> {
	const byFork = new Map<string, { source: Remote; heads: string[]; haves: Set<string> }>();
	for (const [index, merge] of merges.entries()) {
		if (!merge.source) continue;
		const fork = byFork.get(merge.source.url) ?? { source: merge.source, heads: [], haves: new Set() };
		fork.heads.push(merge.head);
		fork.haves.add(placed[index]!.base.hash);
		byFork.set(merge.source.url, fork);
	}
	const forks = [...byFork.values()];
	const alone = forks.filter((fork) => fork.heads.length === 1).map((fork) => fork.heads[0]!);
	const kept: Record<string, Uint8Array> =
		input.packs && alone.length ? await input.packs.read(alone).catch(() => ({})) : {};
	const budget = { bytes: PACKS_MOST };
	const packs = await atMost(FETCHES_AT_ONCE, forks, async (fork) => {
		const stored = fork.heads.length === 1 ? kept[fork.heads[0]!] : undefined;
		if (stored) {
			budget.bytes -= stored.length;
			return budget.bytes < 0 ? "too big" : new Chunks([stored]);
		}
		return fetchPackSince(fork.source, fork.heads, [...fork.haves], budget);
	});
	if (packs.includes("too big")) return { gate: `the changes add over ${PACKS_MOST / 1e6} MB` };
	return { packs: packs as Chunks[], kept: Object.keys(kept).length };
}

type Built = { fs: MemoryFS; objects: string[]; commits: string[]; tip: string };

/** Writes each merge's trees and commit in memory, each on top of the one before. */
async function buildMerges(
	fs: MemoryFS,
	input: TreeLandingInput,
	batch: LandInput,
	plan: { baseTree: string; placed: Placed[] },
	stamper: Stamper | undefined,
): Promise<Built> {
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
 * Pushes the changes' objects and the merges, and moves the branch from the base to the last merge, in one
 * request. A server error may come after the push applied, so the branch decides: at the merges it landed, moved
 * past the base another landing won, and still at the base it's sent again, then left to the Gate.
 */
async function pushMerges(write: Remote, batch: LandInput, built: Built, changePacks: Chunks[]): Promise<TreeLanded> {
	const { packfile } = await git.packObjects({ fs: built.fs, dir: DIR, oids: built.objects });
	const branchRef = `refs/heads/${batch.branch}`;
	const update = { ref: branchRef, from: batch.base, to: built.tip };
	const packs = [...changePacks, new Chunks([packfile!])];
	let failure = "";
	for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
		if (attempt > 1) await sleep(jitteredDelay(attempt, 200, 3_000));
		const report = await receivePack(write, [update], packs).catch((err: Error) => err);
		if (!(report instanceof Error) && "busy" in report) {
			failure = "the project repo was busy";
			continue;
		}
		const result = report instanceof Error ? undefined : report.refs.get(branchRef);
		if (!(report instanceof Error) && report.unpack === "ok" && result === true) return { commits: built.commits };
		failure = report instanceof Error ? report.message : `unpack ${report.unpack}, ${String(result)}`;
		const now = await branchHead(write, batch.branch).catch(() => null);
		if (now === built.tip) return { commits: built.commits };
		if (now !== null && now !== batch.base) return "moved";
	}
	return { gate: `the push failed ${PUSH_ATTEMPTS} times: ${failure}` };
}
