import { branchHead, inWorkspaceTurn, type Remote, Workspace } from "../git";
import { inLane } from "../claim-paths";
import { repoOfUrl } from "../git-http";
import { changeAgainst, landedOn, type ReadHistory } from "./batch-reads";
import { skipsChecks } from "./check-scope";
import type { ClaimRecord } from "./claims";
import type { ClaimStore, ClaimsView } from "./claim-store";
import {
	conflictWords,
	LANDED_FILES_KEPT,
	LANDED_INTENT_CHARS,
	type Landing,
	lastLandedOn,
	memoryLanding,
	type Settled,
} from "./landing";
import { type MergeClaim, type MergeReview, mergeMessage } from "./merge-commit";
import type { Stamper } from "./stamp";
import type { VoteStore, VotesView } from "./vote-store";
import { type ReviewPolicy, approval, countedVotes, effectivePolicy } from "./votes";

// The toolkit's merge for a cooperative agent. It checks the conventions the agent follows (its claim covers what it
// changed, its head has the approvals, it merges cleanly and the checks pass) and refuses to help break them. It binds
// no one: an agent can merge with plain git, and the audit sees the same records.
//
// Claims keep changes off each other's paths, so ready changes land as a set rather than in a line. The merge holding
// the branch's lease (see landing-lease.ts) checks every ready change together on main and lands them in one push, so
// main only ever holds checked code. A failing batch is split until the failing change is found and put out. The git
// work runs in the repo's Gate (see BatchGit). docs/design.md, "Landing", has the details.

const ATTEMPTS = 3;

export interface CheckResult {
	command: string;
	exitCode: number;
	output: string;
}

/** A change in what the checks run on. */
export interface BatchChange {
	change: string;
	head: string;
	ref: string;
	/** The change's fork; absent for a branch in the project repo. */
	source?: Remote;
	agent: string;
}

/**
 * Runs the project's checks on `base` with `changes` merged in order, which is what main becomes once they land.
 * They run in the Gate container named `gate`, or else the last change's.
 */
export type CheckRunner = (input: {
	base: string;
	branch: string;
	changes: BatchChange[];
	commands: string[];
	gate?: string;
}) => Promise<{ passed: boolean; results: CheckResult[] }>;

// Where a batch's checks run: containers of its own, named for the batch (`search`) and a slot in its search for a
// failure. Each round of the search finds its container running with the batch fetched and its dependencies installed.
interface Place {
	search: string;
	slot: number;
	slots: { next: number };
}

/** A change in a batch before its head is read. */
export type BatchSource = Omit<BatchChange, "head">;

/** A change's head and the files it changed since it left main, or why it couldn't be read. */
export type Inspected = { change: string; head: string; files: string[] } | { change: string; error: string };

/**
 * A batch's git work, done with real git in the repo's own Gate. That container never runs a change's code, so what it
 * reads and pushes can be trusted (see gate.ts). Landed in a Worker's memory instead, big batches ran out of it.
 */
export interface BatchGit {
	/** Each change's head now and the files it changed since it left `base`. */
	inspect(input: { base: string; branch: string; changes: BatchSource[] }): Promise<Inspected[]>;
	/**
	 * Lands `merges` on `base` in order and in one push, each as its own merge commit with its claim's trailers and
	 * GitHive's stamp. Returns their commits, or "moved" if the branch is no longer at `base`.
	 */
	land(input: {
		base: string;
		branch: string;
		merges: (BatchChange & { claimed: Omit<MergeClaim, "base"> })[];
		by?: string;
		stamper?: Stamper;
	}): Promise<{ commits: string[] } | "moved">;
	/**
	 * Merges `changes` onto `base` as they would land and pushes the result to `ref` on `to`, a connected GitHub repo,
	 * for its Actions to check. Returns the tip, or why it failed.
	 */
	checksBranch(input: {
		base: string;
		branch: string;
		changes: BatchChange[];
		to: Remote;
		ref: string;
	}): Promise<{ tip: string } | { failed: string }>;
	/** Fast-forwards `branch` on `to` (GitHub's copy) to `head`, and throws if that's refused. */
	pushBranch(input: { branch: string; head: string; to: Remote }): Promise<void>;
}

/** Another change that may land with this one: its claim, its head as last seen, and where its branch lives. */
export interface Candidate {
	claim: ClaimRecord;
	/** Null or absent when nothing had been pushed. */
	head?: string | null;
	source: () => Promise<Remote>;
}

/** The fewest and most changes checked and landed together (see batchSize). */
export const MIN_BATCH = 4;
export const MAX_BATCH = 64;
// The prior for a branch's failure rate, 1 in 20, so a new branch starts with batches of 20.
const PRIOR_FAILED = 1;
const PRIOR_OUTCOMES = 20;
/** How long a newly taken lease lasts, until its holder's first step renews it. */
export const LEASE_MS = 3 * 60_000;
// The longest each step of landing a batch may take. The heartbeat keeps the lease only while the running step is
// within its bound, so a stuck step loses the lease soon after, and a merge that died loses it within LEASE_TTL_MS.
const STEP_MS = {
	// Starting the repo's Gate, then reading or landing a batch there.
	gate: 5 * 60_000,
	records: 2 * 60_000,
	// The Gate stops a check command after 10 minutes (CHECK_TIMEOUT_S in gate.ts).
	checkCommand: 10 * 60_000,
};
const POLL_MS = 3_000;
// How often the lease holder renews the lease, and how far ahead each renewal keeps it.
const HEARTBEAT_MS = 30_000;
export const LEASE_TTL_MS = 2 * 60_000;
/**
 * How long a merge waits before answering "still waiting", and how long a lease holder goes on starting batches.
 * Cloudflare drops a request held open too long, so every answer comes well before that.
 */
export const ANSWER_WITHIN_MS = 10 * 60_000;
// How many batches a lease holder lands before handing the lease on, if its own change hasn't settled.
const ROUNDS = 4;
/** The reviewer failed checks are recorded as. Its rejection of the failing head sends the change back to its agent. */
export const CHECKS_REVIEWER = "githive-checks";
// How many of a batch's changes are checked against their claims at once. Their votes are read once for all of them.
const VALIDATIONS_AT_ONCE = 8;
const RELEASES_AT_ONCE = 4;
// A Worker request holds only so many connections open.
const SOURCES_AT_ONCE = 6;
// How much of a failed check's output is kept in its outcome, and in its rejection.
const OUTCOME_OUTPUT_CHARS = 1_000;
const EVIDENCE_CHARS = 2_000;

export interface MergeInput {
	remote: Remote;
	branch: string;
	/** The change's fork; by default the project repo. */
	source?: Remote;
	/** The repo's claims: checked before merging, cited on the merge, released after. */
	store: ClaimStore;
	/** The repo's votes: counted on the change's head, and cited on the merge. */
	votes: VoteStore;
	policy: ReviewPolicy;
	/** The project's checks; none means the merge isn't tested. */
	verify?: string[];
	/** What the checks skip (see check-scope.ts); the defaults when absent. */
	skipChecks?: string[];
	runChecks?: CheckRunner;
	/** Stamps the merges and the releases with the caller's verified identity. */
	stamper?: Stamper;
	/** The registry's stamp key. When set, only stamped votes count. */
	stampKey?: string;
	change: string;
	agent: string;
	/** Maps a file to its name in the claims records, for a branch other than the project's (see branch-scope.ts). */
	scope?: (file: string) => string;
	/**
	 * The branch's head, cached for all the merges watching it; listed each time when absent. A slightly stale head is
	 * safe because a batch pushes by compare-and-swap and tries again if the branch moved.
	 */
	branchHead?: () => Promise<string | null>;
	/** The other changes into this branch that may land with this one. */
	others?: () => Promise<Candidate[]>;
	/** The branch's lease and recent outcomes. Without it they're kept for this merge only. */
	landing?: Landing;
	batchGit: BatchGit;
	/** Reads history through Artifacts' API, so a change can often be checked without a fetch (see changeAgainst). */
	history?: ReadHistory;
	/** Starts the container for a batch's first check while the batch is read, so the check finds it running. */
	prepareChecks?: (gate: string) => Promise<void>;
	/** Starts the repo's Gate while the batch is read, so landing doesn't wait for its container to start. */
	prepareLanding?: () => Promise<void>;
	/** Caps what batchSize gives. Tests set a small cap so that batches follow each other. */
	maxBatch?: number;
	/** Runs after a batch lands and its claims are released, such as pushing main to GitHub. Failures are logged. */
	afterLanding?: (commit: string) => Promise<void>;
	/** Timings that default to POLL_MS, ANSWER_WITHIN_MS, HEARTBEAT_MS and LEASE_TTL_MS. Tests shorten them. */
	pollMs?: number;
	answerWithinMs?: number;
	heartbeatMs?: number;
	leaseTtlMs?: number;
}

export type MergeOutcome =
	| { ok: true; commit: string; /** Why no checks ran, when they're configured. */ checks?: string }
	| {
			ok: false;
			reasons: string[];
			conflicts?: string[];
			/** The changes that last landed on each conflicted file. */
			causes?: ReturnType<typeof lastLandedOn>;
			checks?: CheckResult[];
			/** Not refused but still waiting; merging again keeps waiting. */ pending?: true;
	  };

type Refused = Extract<MergeOutcome, { ok: false }>;

// A change ready to land: it passed its claim and vote checks and merges cleanly onto main.
interface Ready {
	change: string;
	agent: string;
	head: string;
	ref: string;
	source?: Remote;
	files: string[];
	// The files as the claims records name them.
	scoped: string[];
	claims: ClaimsView;
	own: ClaimRecord;
	votes: VotesView;
	// True when it only touches files the checks skip.
	skipped: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Lands `changes/<change>` together with every other ready change, then releases their claims. Returns once this
 * change has landed, been put out or stopped being ready. Until then it waits while another merge holds the lease.
 */
export async function mergeChange(input: MergeInput): Promise<MergeOutcome> {
	const landing = input.landing ?? memoryLanding();
	const holder = crypto.randomUUID();
	const started = Date.now();
	// Refuse at once if it isn't ready, so the agent can act, unless it has landed already.
	const mine = await readyNow(input, landing);
	if (!mine.ok) return (await landedAlready(input, landing, mine.head)) ?? mine.refused;
	const head = mine.ready.head;
	const answerBy = started + (input.answerWithinMs ?? ANSWER_WITHIN_MS);
	for (;;) {
		const turn = await landing.turn(holder, input.change, head, started, LEASE_MS);
		if ("settled" in turn) return outcomeOf(turn.settled);
		if (turn.lease) {
			const outcome = await landWhileHeld(input, landing, holder, answerBy, head);
			// It may have stopped being ready because another batch landed it and released its claim.
			if (outcome && !outcome.ok) return (await landedAlready(input, landing, head)) ?? outcome;
			if (outcome) return outcome;
		}
		// Answer before Cloudflare drops the request for being held open too long.
		if (Date.now() >= answerBy) return stillWaiting(input.change, head, Date.now() - started);
		if (!turn.lease) await sleep(input.pollMs ?? POLL_MS);
	}
}

// Not a refusal. Merging the same commit again keeps waiting, and answers with the merge commit once it lands.
function stillWaiting(change: string, head: string, waitedMs: number): MergeOutcome {
	return {
		ok: false,
		pending: true,
		reasons: [
			`${change} is ready and waiting to land (${head.slice(0, 8)}): others' batches came first in the ${Math.round(waitedMs / 60_000)} minutes this merge waited. Call merge again to go on waiting; it lands with a coming batch.`,
		],
	};
}

// The outcome if the change already landed at `head`, since its claim is gone by then. The landing's recent outcomes
// answer first; failing that, the branch's history, as a merge commit whose second parent is `head`.
async function landedAlready(input: MergeInput, landing: Landing, head: string): Promise<MergeOutcome | null> {
	const landed = (await landing.view().catch(() => null))?.recent.findLast(
		(s) => s.change === input.change && s.how === "landed" && s.head === head,
	);
	if (landed) return outcomeOf(landed);
	if (!input.history) return null;
	const main = await headOf(input).catch(() => null);
	const commit = main
		? (await landedOn(input.history, repoOfUrl(input.remote.url), input.branch, main, [head]).catch(() => null))?.get(
				head,
			)
		: undefined;
	return commit ? { ok: true, commit } : null;
}

/**
 * About one check failure per batch: 1/p, where p is the share of the branch's recent changes that failed, kept
 * between MIN_BATCH and MAX_BATCH. Half that would need slightly fewer check runs, but 1/p lands more changes at once
 * (see docs/design.md, "Landing").
 */
export function batchSize(recent: Pick<Settled, "how">[]) {
	const failed = recent.filter((s) => s.how === "failed").length;
	const p = (failed + PRIOR_FAILED) / (recent.length + PRIOR_OUTCOMES);
	return Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.round(1 / p)));
}

// This merge's change as it stands now, refused at once if it isn't ready so that the agent can act.
async function readyNow(
	input: MergeInput,
	landing: Landing,
): Promise<{ ok: true; ready: Ready } | { ok: false; refused: Refused; head: string }> {
	const main = (await headOf(input)) ?? fail409(`there's no branch ${input.branch}`);
	const ref = `changes/${input.change}`;
	// Read through Artifacts' API where possible (see changeAgainst). If no file changed on both sides, the change
	// merges cleanly and nothing is fetched. Otherwise git takes its turn in the isolate's workspace (see
	// inWorkspaceTurn), which needs one listing and no clone. The records are read after the workspace is released.
	const read = input.history
		? await changeAgainst(input.history, repoOfUrl(input.remote.url), input.branch, main, {
				ref,
				...(input.source ? { source: input.source } : {}),
			}).catch(() => null)
		: null;
	const { head, files, tried, branch } =
		read && !("error" in read) && !read.both.length
			? {
					head: read.head,
					files: read.files,
					tried: { clean: true } as { clean: boolean; files?: string[] },
					branch: input.branch,
				}
			: await inWorkspaceTurn(async () => {
					const ws = await Workspace.at(input.remote, input.branch, main);
					const head = await ws.fetch("change", input.source ?? input.remote, ref);
					const files = await ws.changedPaths(await ws.mergeBase(main, head), head);
					return { head, files, tried: await ws.tryMerge(main, head), branch: ws.branch };
				});
	const ready = await validated(input, {
		change: input.change,
		agent: input.agent,
		ref,
		...(input.source ? { source: input.source } : {}),
		head,
		files,
		mine: true,
	});
	if (!ready.ok) return { ok: false, refused: ready, head };
	if (!tried.clean) {
		const conflicts = tried.files ?? [];
		// Name who last changed each file, so the agent knows what it's reconciling with and whom to ask.
		const causes = lastLandedOn((await landing.view().catch(() => null))?.recent ?? [], conflicts);
		return {
			ok: false,
			head,
			refused: {
				ok: false,
				conflicts,
				...(causes.length ? { causes } : {}),
				reasons: [
					`changes/${input.change} conflicts with ${branch} in ${conflictWords(conflicts, causes).join(", ")}: merge ${branch} into your branch, resolve inside your claim, push, and get the new commit approved`,
				],
			},
		};
	}
	return ready;
}

function outcomeOf(settled: Settled): MergeOutcome {
	if (settled.how === "landed")
		return {
			ok: true,
			commit: settled.commit!,
			...(settled.skipped ? { checks: "skipped: it only touches files the checks skip" } : {}),
		};
	return {
		ok: false,
		reasons: settled.reasons ?? ["it didn't land"],
		...(settled.checks ? { checks: settled.checks } : {}),
	};
}

// The lease while this merge holds it. The heartbeat renews it only while the running step is within its bound.
interface Holding {
	step(ms: number): Promise<void>;
	// False once another merge may hold the lease, because a renewal was refused or came too late.
	readonly held: boolean;
}

// Lands batches until this merge's own change settles, for at most ROUNDS batches and none started after `answerBy`.
// Null if the change hasn't settled by then or the lease was lost.
async function landWhileHeld(
	input: MergeInput,
	landing: Landing,
	holder: string,
	answerBy: number,
	head: string,
): Promise<MergeOutcome | null> {
	let held = true;
	// Until this time the lease is surely this merge's. Past it without a renewal, another merge may have taken it.
	let until = Date.now() + LEASE_MS;
	// The latest the running steps may finish. The heartbeat stops renewing after it.
	let stepUntil = Date.now() + LEASE_MS;
	const keep = async () => {
		if (!held || Date.now() >= stepUntil) return;
		const ttl = input.leaseTtlMs ?? LEASE_TTL_MS;
		const asked = Date.now();
		const renewed = await landing.renew(holder, ttl).catch(() => null);
		// A renewal may be skipped while more than half is left (see gitLanding), so count on half a ttl.
		if (renewed) until = Math.max(until, asked + ttl / 2);
		else if (renewed === false) held = false;
	};
	// The lease is kept a little ahead only while this merge is alive and its step is within bounds. A merge that dies
	// loses it within LEASE_TTL_MS, and a stuck one soon after its step's bound.
	const beat = setInterval(() => void keep(), input.heartbeatMs ?? HEARTBEAT_MS);
	const holding: Holding = {
		get held() {
			return held && Date.now() < until;
		},
		step: async (ms) => {
			stepUntil = Math.max(stepUntil, Date.now() + ms);
			await keep();
		},
	};
	// Claims are released after the lease is handed on, because a write per change would hold up the next batch.
	const releases: (() => Promise<void>)[] = [];
	try {
		// A batch takes minutes, so none starts once this merge should be answering. A waiting merge takes the lease.
		for (let round = 0; round < ROUNDS && holding.held && Date.now() < answerBy; round++) {
			const done = await landBatch(input, landing, holding, head);
			if (!done.ok) return done;
			releases.push(done.release);
			const mine = done.settled.find((s) => s.change === input.change);
			if (mine) return outcomeOf(mine);
		}
		return null;
	} finally {
		clearInterval(beat);
		await landing.drop(holder).catch(() => undefined);
		for (const release of releases) await release();
	}
}

// Lands one batch: every change ready now, including this merge's own at `head`, checked together on main and pushed
// at once. Returns the outcome of each change that settled, or this change's refusal if it's no longer ready.
async function landBatch(
	input: MergeInput,
	landing: Landing,
	holding: Holding,
	head: string,
): Promise<{ ok: true; settled: Settled[]; release: () => Promise<void> } | Refused> {
	for (let attempt = 1; ; attempt++) {
		const from = Date.now();
		// The first check container starts now, while the batch is read.
		const place: Place = { search: crypto.randomUUID().slice(0, 12), slot: 0, slots: { next: 1 } };
		if (input.verify?.length)
			void input
				.prepareChecks?.(`${place.search}-0`)
				.catch((err) => console.error("starting a batch's check container early failed", String(err)));
		void input.prepareLanding?.().catch((err) => console.error("starting the repo's Gate early failed", String(err)));
		await holding.step(STEP_MS.records);
		// Read the head fresh rather than cached (see branchHead). The previous batch may have just landed, and a batch
		// built on an older main is refused at its push and has to be gathered again.
		const main = (await branchHead(input.remote, input.branch)) ?? fail409(`there's no branch ${input.branch}`);
		const batchGit = input.batchGit;
		// Sized for about one failure per batch (see batchSize). Without checks nothing fails a batch, so it takes all
		// that's ready.
		const size = Math.min(
			input.verify?.length ? batchSize((await landing.view()).recent) : MAX_BATCH,
			input.maxBatch ?? MAX_BATCH,
		);
		// This merge's own change, and the others approved as last seen, with the heads they were seen at.
		const mine: BatchSource & { seen: string } = {
			change: input.change,
			ref: `changes/${input.change}`,
			...(input.source ? { source: input.source } : {}),
			agent: input.agent,
			seen: head,
		};
		const sources = [mine, ...(await candidates(input, landing, size - 1))];
		const foundAt = Date.now();
		const read = await readBatch(input, batchGit, main, sources, holding);
		const readAt = Date.now();
		await holding.step(STEP_MS.records);
		const own = read[0];
		if ("error" in own) return { ok: false, reasons: [`${input.change} couldn't be read: ${own.error}`] };
		// Check each against its claim and votes, a few at a time because a Worker request holds only so many
		// connections open. The votes on all their heads are read once.
		const seen = await input.votes.readFor(read.flatMap((r) => ("error" in r ? [] : [r.head])));
		const checked = await atMost(VALIDATIONS_AT_ONCE, read, async (r, i) => {
			if (!("error" in r))
				return validated(input, { ...sources[i], head: r.head, files: r.files, mine: i === 0 }, seen);
			console.error(`${r.change} can't land with the others now: ${r.error}`);
			return null;
		});
		if (checked[0] && !checked[0].ok) return checked[0];
		const ready = checked.flatMap((c) => (c?.ok ? [c.ready] : []));
		// Oldest claims first, this merge's own among them.
		let batch = ready.sort((x, y) => x.own.since.localeCompare(y.own.since));
		// A push answered with a server error may still have applied. Changes already on main are recorded as landed,
		// their claims released, and left out, since merging one again would come to nothing and fail the batch.
		const already = input.history
			? await landedOn(
					input.history,
					repoOfUrl(input.remote.url),
					input.branch,
					main,
					batch.map((r) => r.head),
				).catch(() => new Map<string, string>())
			: new Map<string, string>();
		if (already.size) {
			const settled = await settleLanded(
				input,
				landing,
				batch.filter((r) => already.has(r.head)),
				already,
			);
			batch = batch.filter((r) => !already.has(r.head));
			if (!batch.some((r) => r.change === input.change)) return { ok: true, settled, release: async () => undefined };
		}
		const gathered = Date.now();
		const tested = !!input.verify?.length && batch.some((r) => !r.skipped);
		// The first part found passing lands at once while the search for the failure goes on. Each part was checked on
		// main alone, so only one can land as checked; the rest wait for the next batch.
		let early: Promise<{ part: Ready[]; landed: Landed | null; ms: number }> | undefined;
		const found = (part: Ready[]) => {
			early ??= (async () => {
				const at = Date.now();
				await holding.step(STEP_MS.gate);
				// If the lease was lost meanwhile, its new holder lands what's ready after checking it again.
				if (!holding.held) return { part, landed: { settled: [], release: async () => undefined }, ms: 0 };
				const landed = await land(input, landing, batchGit, main, part, tested, holding);
				return { part, landed, ms: Date.now() - at };
			})();
		};
		const settled: Settled[] = [];
		// If the lease was lost while gathering, nothing is checked or landed, and the merge waits for its turn again.
		if (!holding.held) return { ok: true, settled: [], release: async () => undefined };
		if (tested) {
			if (!input.runChecks) throw new Error("[500] checks are configured but nothing can run them");
			await landing.checking({
				base: main,
				since: new Date().toISOString(),
				changes: batch.map((r) => ({ change: r.change, head: r.head, agent: r.agent })),
			});
			const failed = await checkBatch(input, main, batch, holding, place, found);
			await holding.step(STEP_MS.records);
			for (const { ready, results } of failed) settled.push(await putOut(input, ready, results));
		} else found(batch);
		const checkedAt = Date.now();
		const done = early ? await early : { part: [], landed: { settled: [], release: async () => undefined }, ms: 0 };
		console.log(
			`batch of ${batch.length} (at most ${size}) into ${input.branch}: gathering ${gathered - from} ms (finding ${foundAt - from}, reading ${readAt - foundAt}, validating ${gathered - readAt}), checks ${checkedAt - gathered} ms, landing ${done.landed === null ? "lost the race" : `${done.landed.settled.length}`} ${done.ms} ms`,
		);
		await landing.settle(settled);
		await landing.checking(null);
		if (done.landed === null) {
			// A merge from outside the batch moved the branch, so what passed was checked on another main.
			if (attempt < ATTEMPTS) continue;
			return {
				ok: false,
				reasons: [
					`the project's branch kept moving while ${input.change} merged (other merges landed first): merge again`,
				],
			};
		}
		return { ok: true, settled: [...settled, ...done.landed.settled], release: done.landed.release };
	}
}

// Checks `batch` on main in its `place`, passing each part that passes to `found`. A failing batch is split and its
// halves are checked side by side. A change failing alone is checked once more, then returned to be put out.
async function checkBatch(
	input: MergeInput,
	main: string,
	batch: Ready[],
	holding: Holding,
	place: Place,
	found: (part: Ready[]) => void,
): Promise<{ ready: Ready; results: CheckResult[] }[]> {
	// A run is its commands plus an install and setup, each allowed as long as the Gate lets a command run.
	const run = async () => {
		await holding.step((input.verify!.length + 2) * STEP_MS.checkCommand);
		const checked = await input.runChecks!({
			base: main,
			branch: input.branch,
			changes: batch.map((r) => ({
				change: r.change,
				head: r.head,
				ref: r.ref,
				...(r.source ? { source: r.source } : {}),
				agent: r.agent,
			})),
			commands: input.verify!,
			gate: `${place.search}-${place.slot}`,
		});
		return checked;
	};
	const first = await run();
	if (first.passed) return (found(batch), []);
	if (batch.length === 1) {
		const again = await run();
		return again.passed ? (found(batch), []) : [{ ready: batch[0], results: again.results }];
	}
	const half = Math.ceil(batch.length / 2);
	// The first half stays in this container, where its changes just ran. The second takes another and keeps it.
	const second = { ...place, slot: place.slots.next++ };
	const [a, b] = await Promise.all([
		checkBatch(input, main, batch.slice(0, half), holding, place, found),
		checkBatch(input, main, batch.slice(half), holding, second, found),
	]);
	return [...a, ...b];
}

// Puts out a change whose checks failed alone on main. The checks' rejection of its head sends it back to its agent.
async function putOut(input: MergeInput, ready: Ready, results: CheckResult[]): Promise<Settled> {
	const failed = results.find((r) => r.exitCode !== 0);
	const reasons = [failed ? `checks failed: ${failed.command} exited ${failed.exitCode}` : "checks failed"];
	const evidence = `${reasons[0]} on ${ready.head.slice(0, 8)}, checked alone on the branch, twice${failed?.output ? `:\n${failed.output.slice(-EVIDENCE_CHARS)}` : ""}`;
	await input.votes
		.vote({ commit: ready.head, reviewer: CHECKS_REVIEWER, role: "checks", verdict: "reject", evidence }, input.stamper)
		.catch((err) => console.error(`recording ${ready.change}'s failed checks failed`, String(err)));
	// The outcome keeps only the failed commands and the end of their output. The rejection has more.
	const checks = results
		.filter((r) => r.exitCode !== 0)
		.map((r) => ({ ...r, output: r.output.slice(-OUTCOME_OUTPUT_CHARS) }));
	return {
		change: ready.change,
		head: ready.head,
		agent: ready.agent,
		how: "failed",
		at: new Date().toISOString(),
		reasons,
		checks,
	};
}

// A landed batch: each change's outcome, and the release of their claims for after the lease is handed on.
interface Landed {
	settled: Settled[];
	release: () => Promise<void>;
}

function approvalsOn(ready: Ready): MergeReview[] {
	const approvals = ready.votes.votes.filter((vote) => vote.commit === ready.head && vote.verdict === "approve");
	return approvals.map((vote) => ({ reviewer: vote.reviewer, role: vote.role, evidence: vote.evidence }));
}

// Lands `batch` on main in one push, one merge commit per change. Waiting merges hear at once, but claims are
// released later (see Landed) and candidates skips them until then. Null if main moved.
async function land(
	input: MergeInput,
	landing: Landing,
	batchGit: BatchGit,
	main: string,
	batch: Ready[],
	tested: boolean,
	holding: Holding,
): Promise<Landed | null> {
	const from = Date.now();
	const heads = batch.map((r) => r.head);
	const landed = await batchGit.land({
		base: main,
		branch: input.branch,
		merges: batch.map((r) => ({
			change: r.change,
			head: r.head,
			ref: r.ref,
			...(r.source ? { source: r.source } : {}),
			agent: r.agent,
			claimed: {
				head: r.head,
				change: r.change,
				author: r.agent,
				claimsTip: input.store.cite(r.claims, r.scoped, r.own),
				votesTip: input.votes.cite(r.votes, r.head),
				...(tested ? { testedOn: main } : {}),
				// Every change in the batch, in landing order. A change checked alone needs only testedOn.
				...(tested && heads.length > 1 ? { testedWith: heads } : {}),
				intent: r.own.intent,
				reviews: approvalsOn(r),
			},
		})),
		// The Gate stamps with GitHive's key as `by`. An in-process implementation (tests) uses the stamper itself.
		...(input.stamper ? { by: input.stamper.by, stamper: input.stamper } : {}),
	});
	if (landed === "moved") return null;
	const { commits } = landed;
	const pushedAt = Date.now();
	await holding.step(STEP_MS.records);
	const at = new Date().toISOString();
	const settled: Settled[] = batch.map((r, i) => ({
		change: r.change,
		head: r.head,
		agent: r.agent,
		how: "landed",
		at,
		commit: commits[i],
		...(r.skipped && input.verify?.length ? { skipped: true } : {}),
		files: r.files.slice(0, LANDED_FILES_KEPT),
		...(r.files.length > LANDED_FILES_KEPT ? { filesMore: r.files.length - LANDED_FILES_KEPT } : {}),
		...(r.own.intent ? { intent: r.own.intent.slice(0, LANDED_INTENT_CHARS) } : {}),
	}));
	// Record the outcomes now, so a merge retried before its claim is released finds its change landed.
	await landing.settle(settled);
	console.log(
		`landed ${batch.length} change${batch.length === 1 ? "" : "s"} on ${input.branch} (${tested ? "checked together" : "no checks"}): merged and pushed ${pushedAt - from} ms, told ${Date.now() - pushedAt} ms`,
	);
	const release = async () => {
		const releaseFrom = Date.now();
		// A few at a time, because a Worker stalls past a handful of open connections.
		for (let i = 0; i < batch.length; i += RELEASES_AT_ONCE)
			await Promise.all(
				batch
					.slice(i, i + RELEASES_AT_ONCE)
					.map((r, j) =>
						input.store
							.release({ change: r.change, agent: r.agent, reason: "merged", mergedAs: commits[i + j] }, input.stamper)
							.catch((err) => console.error(`releasing ${r.change}'s claim after it merged failed`, String(err))),
					),
			);
		console.log(
			`released the claims of ${batch.length} change${batch.length === 1 ? "" : "s"} landed on ${input.branch}, after the lease was handed on: ${Date.now() - releaseFrom} ms`,
		);
		if (input.afterLanding) {
			const from = Date.now();
			await input
				.afterLanding(commits.at(-1)!)
				.then(() =>
					console.log(`after landing on ${input.branch} (main pushed to GitHub, say): ${Date.now() - from} ms`),
				)
				.catch((err) =>
					console.error(`after landing on ${input.branch} failed (main not pushed to GitHub, say)`, String(err)),
				);
		}
	};
	return { settled, release };
}

// Records changes already on main as landed and releases their claims. `on` maps each head to its merge commit.
async function settleLanded(
	input: MergeInput,
	landing: Landing,
	changes: Ready[],
	on: Map<string, string>,
): Promise<Settled[]> {
	const at = new Date().toISOString();
	const settled: Settled[] = changes.map((r) => ({
		change: r.change,
		head: r.head,
		agent: r.agent,
		how: "landed",
		at,
		commit: on.get(r.head)!,
		files: r.files.slice(0, LANDED_FILES_KEPT),
		...(r.files.length > LANDED_FILES_KEPT ? { filesMore: r.files.length - LANDED_FILES_KEPT } : {}),
	}));
	await landing.settle(settled);
	console.log(
		`${changes.length} change${changes.length === 1 ? " was" : "s were"} on ${input.branch} already, unrecorded: ${changes.map((r) => r.change).join(", ")}`,
	);
	for (let i = 0; i < changes.length; i += RELEASES_AT_ONCE)
		await Promise.all(
			changes
				.slice(i, i + RELEASES_AT_ONCE)
				.map((r) =>
					input.store
						.release({ change: r.change, agent: r.agent, reason: "merged", mergedAs: on.get(r.head)! }, input.stamper)
						.catch((err) =>
							console.error(`releasing ${r.change}'s claim, found on ${input.branch} already, failed`, String(err)),
						),
				),
		);
	return settled;
}

// Up to `count` other changes that may be ready to land with this one, oldest claims first: those approved as last
// seen and not sent back. Each is read and checked again before it lands.
async function candidates(
	input: MergeInput,
	landing: Landing,
	count: number,
): Promise<(BatchSource & { seen: string })[]> {
	// A change that just landed may keep its claim until the lease is handed on, so skip it.
	const landed = new Set(
		((await landing.view().catch(() => null))?.recent ?? [])
			.filter((s) => s.how === "landed")
			.map((s) => `${s.change} ${s.head}`),
	);
	const others = (
		(await input
			.others?.()
			.catch((err) => (console.error("reading the other changes to land failed", String(err)), []))) ?? []
	).filter(
		(c): c is Candidate & { head: string } =>
			c.claim.change !== input.change && !!c.head && !landed.has(`${c.claim.change} ${c.head}`),
	);
	if (!others.length) return [];
	const seen = await input.votes.readFor(others.map((c) => c.head));
	const counted = await countedVotes(
		seen.votes.filter((v) => others.some((c) => c.head === v.commit)),
		input.stampKey,
	);
	const likely = others
		.filter((c) => {
			const author = { agent: c.claim.agent, ...(c.claim.by ? { by: c.claim.by } : {}) };
			if (counted.some((v) => v.commit === c.head && v.verdict === "reject" && v.reviewer !== author.agent))
				return false;
			return approval({ votes: counted }, c.head, input.policy, author, c.claim.paths).approved;
		})
		.sort((a, b) => a.claim.since.localeCompare(b.claim.since))
		.slice(0, Math.max(0, count));
	// Ask for read access to the forks a few at a time. One after another, gathering grew with the batch's size.
	const sources = await atMost(SOURCES_AT_ONCE, likely, async (c) => {
		const source = await c
			.source()
			.catch((err) => (console.error(`${c.claim.change}'s fork can't be read`, String(err)), null));
		return source
			? { change: c.claim.change, ref: `changes/${c.claim.change}`, source, agent: c.claim.agent, seen: c.head }
			: null;
	});
	return sources.filter((s): s is NonNullable<typeof s> => !!s);
}

// Each source's head and the files it changed since it left `main`, read in one call, in `sources`' order.
async function readBatch(
	input: MergeInput,
	batchGit: BatchGit,
	main: string,
	sources: (BatchSource & { seen: string })[],
	holding: Holding,
): Promise<Inspected[]> {
	await holding.step(STEP_MS.gate);
	return batchGit.inspect({ base: main, branch: input.branch, changes: sources.map(({ seen: _, ...s }) => s) });
}

// Whether a change may land: its claim covers every file and no one else's does, its head has the approvals, and its
// checks haven't failed on that head. Another agent's change is also held back if a reviewer asked for changes.
// Only the records are read here; the batch finds out whether it merges cleanly.
async function validated(
	input: MergeInput,
	c: BatchSource & { head: string; files: string[]; mine: boolean },
	seen?: VotesView,
): Promise<{ ok: true; ready: Ready } | Refused> {
	const { head, files } = c;
	// The files as the claims records name them, which differs for a branch other than the project's.
	const scoped = input.scope ? files.map(input.scope) : files;
	// The claims bearing on these files, and the votes on its head (read once for the whole batch when given).
	const [claims, votes] = await Promise.all([
		input.store.readScope(c.change, scoped),
		seen ?? input.votes.readFor([head]),
	]);

	const reasons: string[] = [];
	const own = claims.claims.find((x) => x.change === c.change);
	if (!own) reasons.push(`${c.change} holds no claim`);
	files.forEach((file, i) => {
		const holder = claims.claims.find((x) => x.change !== c.change && inLane(scoped[i], x.paths));
		if (holder) reasons.push(`${file} is inside ${holder.change}'s claim (${holder.agent})`);
		else if (own && !inLane(scoped[i], own.paths)) reasons.push(`${file} is outside ${c.change}'s claim`);
	});
	const counted = await countedVotes(
		votes.votes.filter((v) => v.commit === head),
		input.stampKey,
	);
	// Approvals count distinct reviewers other than the author, under the policy for the files touched. That policy may
	// be stricter for dependency, CI and deploy files.
	const outcome = approval({ votes: counted }, head, input.policy, own, files);
	const { required } = effectivePolicy(input.policy, files);
	if (outcome.vetoedBy.length) reasons.push(`${head} is vetoed by ${outcome.vetoedBy.join(", ")}`);
	else if (outcome.approvals < required)
		reasons.push(`${head} has ${outcome.approvals} of ${required} approvals from reviewers other than its author`);
	else if (outcome.awaiting.length)
		reasons.push(`${head} still needs approval from ${outcome.awaiting.join(", ")}, which can veto it`);
	// Its checks failed twice on this exact commit, so merging it again would fail. A new commit is checked afresh.
	const failed = counted.find((v) => v.reviewer === CHECKS_REVIEWER && v.verdict === "reject");
	if (failed) reasons.push(`${failed.evidence.split("\n")[0]}: push a fix (a new commit) and get it approved`);
	else if (!c.mine) {
		const sentBack = counted.find((v) => v.verdict === "reject" && v.reviewer !== (own?.agent ?? c.agent));
		if (sentBack) reasons.push(`${sentBack.reviewer} asked for changes on ${head}`);
	}
	if (reasons.length || !own) return { ok: false, reasons };
	// No checks for a change that only touches what they skip, such as documentation (see check-scope.ts).
	const skipped = !!input.verify?.length && skipsChecks(files, input.skipChecks);
	return {
		ok: true,
		ready: {
			change: c.change,
			agent: c.agent,
			head,
			ref: c.ref,
			...(c.source ? { source: c.source } : {}),
			files,
			scoped,
			claims,
			own,
			votes,
			skipped,
		},
	};
}

/** Maps `f` over `items` with at most `n` running at once, keeping the items' order. */
export async function atMost<T, R>(n: number, items: T[], f: (item: T, i: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await f(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	return results;
}

// The branch's head, cached for every merge watching it, or else listed.
const headOf = (input: MergeInput) => (input.branchHead ? input.branchHead() : branchHead(input.remote, input.branch));

const fail409 = (message: string): never => {
	throw new Error(`[409] ${message}`);
};
