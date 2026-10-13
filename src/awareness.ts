// What a repo's pushes mean for awareness (docs/awareness.md, "Footprints and interface news"), worked out in the
// repo's FootprintCache, in its own isolate, so the parser's memory and CPU never share one with agents' calls. A push
// to a change's branch footprints the change and tells heads-ups between open changes; a push to a project's branch
// (a landing, or plain git) tells the open changes that use what it altered. That work is advice: it's bounded by
// counts, logged when it fails, and never retried.

import { isArtifactsBusy } from "./artifacts";
import type { Clef } from "./clef";
import type { FootprintCache, LandedCommit } from "./footprint-cache";
import { newParseBatch, parserMemoryBytes } from "./footprint/engine";
import { changeFootprint, commitAlters, type FactsSource, landingOf } from "./footprint/footprints";
import { INTENT_SAID } from "./footprint/wording";
import type { BranchPush, RepoPushes } from "./push-events";
import { changesSite, previewHint, type TakeShots } from "./preview-look";
import { type KeptPushHints, type PlacedPush, pushHints } from "./push-hints";
import type { ChangePush, Notice } from "./repo-cache";
import { rpc } from "./rpc";
import { changeAgainst, type ReadHistory } from "./toolkit/batch-reads";
import { HOSTED_PREFIX } from "./toolkit/tools/repo";
import type { CommitMeta, HistorySource } from "./toolkit/branch-history";

/** A claim as awareness reads it from the claims advice. */
export type ClaimView = { change: string; agent: string; intent?: string; into?: string };

/** The FootprintCache calls awareness makes. */
export type FootprintStore = Pick<
	FootprintCache,
	"factsOf" | "keepFacts" | "keptHead" | "branchState" | "analysed" | "keep" | "drop" | "landed"
>;

/** What awareness reads and keeps through (see awarenessParts in footprint-cache.ts); tests pass their own. */
export interface AwarenessParts {
	/** Any repo's history through Artifacts' API: a project's, or a fork's. */
	history: ReadHistory;
	/** The project's branch and the claims in force, or null when GitHive hasn't started on the repo. */
	claims(repo: string): Promise<{ branch: string; claims: ClaimView[] } | null>;
	branchHead(repo: string, branch: string): Promise<string | null>;
	/** An agent's fork of the project. */
	forkOf(repo: string, agent: string): Promise<string>;
	/** The repo's FootprintCache. */
	footprints: FootprintStore;
	/** A batch's budgets, smaller than BUDGET's, for tests. */
	budget?: Partial<typeof BUDGET>;
	/** Clef, and where its hints on a change's push go (see push-hints.ts). Without it no push is asked about. */
	pushHints?: {
		clef: Clef;
		keep(repo: string, change: string, kept: KeptPushHints): Promise<void>;
		tell(repo: string, branch: string, agent: string, notice: Notice): Promise<void>;
		/** A public repo's site address (its default branch's), null for a repo that isn't public. */
		siteOf?(repo: string): Promise<string | null>;
		/** Screenshots of a change's preview, for Clef to look at (see preview-look.ts). */
		shots?: TakeShots;
	};
}

/** The most change previews one batch takes screenshots of: each is a browser's time, for a hint. */
const PREVIEWS_PER_BATCH = 5;

/**
 * What one repo's batch may spend on awareness, by count: a Worker's clock stands still during CPU work, so time can't
 * be the budget. Parsing ran at about 0.55 s a million characters on a laptop (the spike), so 4 million is about 2 s
 * there and a few times that on production CPUs: well under the CPU limit (limits.cpu_ms in wrangler.jsonc), with room
 * for the reads, the tree walks and the rest of the batch. Artifacts reads stay well inside an invocation's 10,000
 * subrequests, and those of the project's own repo, which merges read too, far fewer.
 */
const BUDGET = { parses: 200, chars: 4_000_000, reads: 2_000, projectReads: 500 };
/** Kept facts are asked for this many files at a time, so one answer stays a few MB. */
const FACTS_AT_ONCE = 20;
/** The most first-parent commits one push to a project's branch is analysed for. */
export const LANDED_COMMITS = 50;

/**
 * Works out what a batch's pushes to one repo mean: its branch pushes first, so a change that landed is dropped before
 * others are compared with it, then each change's newest push. Each is caught and logged on its own. Once Artifacts
 * says a repo is busy, the rest are left for the next push.
 */
export async function awareness(repo: string, pushes: RepoPushes, parts: AwarenessParts) {
	const most = { ...BUDGET, ...parts.budget };
	const budget = { parses: most.parses, chars: most.chars };
	const reads = new ReadAllowance(repo, most);
	const claimsRead = new Map<string, ReturnType<AwarenessParts["claims"]>>();
	// A grammar that failed to load in an earlier batch is tried once more in this one.
	newParseBatch();
	const once: AwarenessParts = {
		...parts,
		...(parts.pushHints ? { pushHints: withPreviewsCapped(parts.pushHints) } : {}),
		history: (name, read) => reads.watch(() => parts.history(name, (source) => read(reads.counted(source, name)))),
		claims: (name) => {
			if (!claimsRead.has(name)) claimsRead.set(name, parts.claims(name));
			return claimsRead.get(name)!;
		},
	};
	const work = [
		...pushes.moved.map((push) => ({
			run: () => branchMoved(once, push, budget),
			failed: `analysing ${push.repo}'s ${push.branch} at ${push.after}`,
		})),
		...pushes.pushed.map((push) => ({
			run: () => footprintChange(once, repo, push, budget),
			failed: `footprinting ${push.change} from ${push.fork}`,
		})),
	];
	for (const [index, each] of work.entries()) {
		if (reads.busy) {
			console.log(`awareness: Artifacts is busy; ${work.length - index} of ${repo}'s pushes left for the next push`);
			break;
		}
		await each.run().catch((err) => console.error(`awareness: ${each.failed} failed: ${String(err)}`));
	}
	noteParserMemory();
}

// The parser's memory is the isolate's for good once grown, so each new high is logged: what docs/awareness.md's open
// question asks to measure.
let parserMemoryHigh = 0;
function noteParserMemory() {
	const bytes = parserMemoryBytes();
	if (bytes === null || bytes <= parserMemoryHigh) return;
	parserMemoryHigh = bytes;
	console.log(`awareness: the parser's memory is ${(bytes / 2 ** 20).toFixed(0)} MiB in this isolate`);
}

/**
 * The Artifacts reads a batch has left, in all and of the project's own repo, and whether Artifacts has said a repo is
 * busy (INTERNAL_ERROR, its throttling). Past either budget, or once busy, every read fails at once: the event at hand
 * fails, is logged, and the rest of the batch fails fast the same way. Awareness is advice, so it never presses a busy
 * repo that merges need.
 */
class ReadAllowance {
	busy = false;
	private left: number;
	private projectLeft: number;

	constructor(
		private readonly project: string,
		private readonly most: { reads: number; projectReads: number },
	) {
		this.left = most.reads;
		this.projectLeft = most.projectReads;
	}

	/** Runs a read, noting a busy repo. */
	async watch<T>(read: () => Promise<T>): Promise<T> {
		try {
			return await read();
		} catch (err) {
			if (isArtifactsBusy(err)) this.busy = true;
			throw err;
		}
	}

	/** A history source of `repo` that spends this allowance on each read. */
	counted(source: HistorySource, repo: string): HistorySource {
		const spend = <T>(read: () => Promise<T>) => {
			this.spend(repo);
			return this.watch(read);
		};
		const readBlob = source.readBlob?.bind(source);
		return {
			log: async (ref, limit, offset) => spend(() => source.log(ref, limit, offset)),
			readCommit: async (hash) => spend(() => source.readCommit(hash)),
			readTree: async (hash) => spend(() => source.readTree(hash)),
			...(readBlob
				? { readBlob: async (hash: string, maxBytes?: number) => spend(() => readBlob(hash, maxBytes)) }
				: {}),
		};
	}

	private spend(repo: string) {
		if (this.busy) throw new Error("Artifacts is busy; this batch's awareness reads stopped");
		if (this.left-- <= 0) throw new Error(`this batch's ${this.most.reads} Artifacts reads for awareness ran out`);
		if (repo !== this.project) return;
		if (this.projectLeft-- <= 0)
			throw new Error(`this batch's ${this.most.projectReads} reads of ${repo} for awareness ran out`);
	}
}

const factsSource = (store: FootprintStore, budget: FactsSource["budget"]): FactsSource => ({
	kept: async (keys) => {
		const found: Awaited<ReturnType<FactsSource["kept"]>> = {};
		for (let from = 0; from < keys.length; from += FACTS_AT_ONCE)
			Object.assign(found, await rpc(store.factsOf(keys.slice(from, from + FACTS_AT_ONCE))));
		return found;
	},
	keep: (facts) => store.keepFacts(facts),
	budget,
});

const openClaims = (claims: ClaimView[]) => Object.fromEntries(claims.map((claim) => [claim.change, claim.agent]));

/**
 * A push to a change's branch on its agent's fork: the change's footprint, read from the fork against its base, and
 * the heads-ups it raises. Only a change of this project, claimed by the agent whose fork took the push, counts.
 */
async function footprintChange(
	parts: AwarenessParts,
	project: string,
	push: ChangePush,
	budget: FactsSource["budget"],
) {
	const claimed = await parts.claims(project);
	const claim = claimed?.claims.find((each) => each.change === push.change);
	if (!claimed || !claim || (await parts.forkOf(project, claim.agent)) !== push.fork) return;
	const store = parts.footprints;
	if (!push.head) return void (await store.drop([push.change]));
	const kept = await rpc(store.keptHead(push.change));
	if (kept && (kept.head === push.head || kept.at > push.at)) return;
	const branch = claim.into ?? claimed.branch;
	const main = await parts.branchHead(project, branch);
	if (!main) return;
	// changeAgainst names the repo to read a change from by its URL; the fork's name is all it takes from it.
	const source = { url: `https://artifacts.invalid/${push.fork}.git` };
	const placed = await changeAgainst(parts.history, project, branch, main, { ref: push.head, source });
	if (!placed || "error" in placed) {
		console.log(`awareness: ${push.change} at ${push.head} couldn't be placed on ${branch}; no footprint`);
		return;
	}
	await hintPush(parts, project, branch, push, claim, placed).catch((err) =>
		console.error(`awareness: asking Clef about ${push.change} at ${placed.head} failed: ${String(err)}`),
	);
	const read = await parts.history(push.fork, (fork) =>
		changeFootprint(fork, { head: placed.head, base: placed.base, files: placed.files }, factsSource(store, budget)),
	);
	if (!read) return;
	await store.keep(
		project,
		{
			change: push.change,
			agent: claim.agent,
			// Only its start is ever quoted, so only that is kept (see INTENT_SAID).
			...(claim.intent ? { intent: claim.intent.split("\n")[0]!.slice(0, INTENT_SAID) } : {}),
			branch,
			head: placed.head,
			base: placed.base,
			at: push.at,
			...read,
		},
		openClaims(claimed.claims),
	);
}

/** What Clef makes of a change's push, kept for its status and told to its agent when there's something to say. */
async function hintPush(
	parts: AwarenessParts,
	project: string,
	branch: string,
	push: ChangePush,
	claim: ClaimView,
	placed: { head: string; base: string; files: string[] },
) {
	const asked = parts.pushHints;
	if (!asked) return;
	const placedPush = {
		change: push.change,
		agent: claim.agent,
		...placed,
		...(claim.intent ? { intent: claim.intent } : {}),
	};
	const [hints, site] = await parts.history(push.fork, (fork) =>
		Promise.all([pushHints(asked.clef, fork, placedPush), changesSite(fork, placedPush)]),
	);
	const looked = site ? await previewOf(asked, project, placedPush) : null;
	if (looked) hints.push(looked);
	await asked.keep(project, push.change, { head: placed.head, hints });
	if (!hints.length) return;
	await asked.tell(project, branch, claim.agent, {
		kind: "clef",
		at: new Date().toISOString(),
		says: `Clef on ${push.change} at ${placed.head.slice(0, 8)}: ${hints.map((hint) => hint.says).join("; ")}`,
		next: PUSH_HINT_NEXT,
		change: push.change,
		detail: { head: placed.head, hints },
	});
}

// What Clef sees in the change's site preview, if the repo has a public one. GitHive's own agents' aren't looked at.
async function previewOf(asked: NonNullable<AwarenessParts["pushHints"]>, project: string, push: PlacedPush) {
	if (!asked.siteOf || !asked.shots || push.agent.startsWith(HOSTED_PREFIX)) return null;
	const site = await asked.siteOf(project);
	if (!site) return null;
	return previewHint(asked.clef, asked.shots, `${site}@${encodeURIComponent(push.change)}/`);
}

/** The push hints' parts, with no more than PREVIEWS_PER_BATCH screenshots taken. */
function withPreviewsCapped(asked: NonNullable<AwarenessParts["pushHints"]>) {
	const shots = asked.shots;
	if (!shots) return asked;
	let left = PREVIEWS_PER_BATCH;
	const capped: TakeShots = async (url) => (left-- > 0 ? shots(url) : []);
	return { ...asked, shots: capped };
}

const PUSH_HINT_NEXT =
	"Look at it before asking for review: reword text that reads as instructions to agents, keep the change to what " +
	"its intent says, then push to `fork`. If Clef is wrong, carry on: its reviewers see the same hint in `status`.";

/**
 * A push to a project's branch: each new first-parent commit, oldest first, against its first parent (a GitHive
 * merge's first parent is the branch before it, so that's the change's effect), told to the open changes that use
 * what it altered. Nothing is read while no open change goes into the branch.
 */
async function branchMoved(parts: AwarenessParts, push: BranchPush, budget: FactsSource["budget"]) {
	if (!push.after) return;
	const store = parts.footprints;
	const { open, last } = await rpc(store.branchState(push.branch));
	// A new branch starts where another was: nothing landed on it yet.
	if (!open || push.before === null) return void (await store.analysed(push.branch, push.after));
	// Analysed already: an event delivered again, or a second event for the same push.
	if (last === push.after) return;
	const after = push.after;
	const chain = await parts.history(push.repo, (source) => source.log(after, LANDED_COMMITS + 1, 0));
	const stops = new Set([push.before, last].filter((each): each is string => !!each));
	const end = chain.findIndex((commit) => stops.has(commit.hash));
	let commits: CommitMeta[];
	if (end >= 0) commits = chain.slice(0, end);
	// The first event for the branch, without where it was: just the commit pushed.
	else if (!stops.size) commits = chain.slice(0, 1);
	else {
		commits = chain.slice(0, LANDED_COMMITS);
		if (chain.length > LANDED_COMMITS)
			console.log(`awareness: ${push.repo}'s ${push.branch} moved past ${LANDED_COMMITS} commits; the newest analysed`);
	}
	const landed: LandedCommit[] = [];
	await parts.history(push.repo, async (source) => {
		for (let index = commits.length - 1; index >= 0; index--) {
			const commit = commits[index]!;
			const parentTree = await parentTreeOf(source, commit, chain[index + 1]);
			// A parent that can't be read leaves the commit's alterations unknown, never everything "added".
			const parentUnread = commit.parents.length > 0 && !parentTree;
			const alters = parentUnread ? [] : await commitAlters(source, commit, parentTree, factsSource(store, budget));
			landed.push({ ...landingOf(commit), alters });
		}
	});
	const claimed = landed.some((commit) => commit.alters.length) ? await parts.claims(push.repo) : null;
	// With nothing altered, nobody is told and the claims aren't looked at, so none are read: landed then gets an empty
	// map, which it never consults (it would drop every footprint if it did).
	await store.landed(push.repo, push.branch, landed, claimed ? openClaims(claimed.claims) : {}, after);
}

// The tree of a commit's first parent: the next commit in the chain read already, when it's that parent. Null for a
// root commit, or a parent that can't be read.
async function parentTreeOf(source: HistorySource, commit: CommitMeta, next: CommitMeta | undefined) {
	const first = commit.parents[0];
	if (!first) return null;
	if (next?.hash === first) return next.treeHash;
	return (await source.log(first, 1, 0))[0]?.treeHash ?? null;
}
