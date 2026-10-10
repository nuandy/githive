import { branchHead, inWorkspaceTurn, type Remote, Workspace } from "../git";
import { inLane } from "../claim-paths";
import { repoOfUrl } from "../git-http";
import { changeAgainst, landedOn, type ReadHistory } from "./batch-reads";
import { skipsChecks } from "./check-scope";
import type { ClaimRecord } from "./claims";
import type { ClaimStore, ClaimsView } from "./claim-store";
import { conflictWords, LANDED_FILES_KEPT, LANDED_INTENT_CHARS, type Landing, lastLandedOn, memoryLanding, type Settled } from "./landing";
import { type MergeClaim, type MergeReview, mergeMessage } from "./merge-commit";
import type { Stamper } from "./stamp";
import type { VoteStore, VotesView } from "./vote-store";
import { type ReviewPolicy, approval, countedVotes, effectivePolicy } from "./votes";

// The toolkit's merge for a cooperative agent. It
// checks the conventions the agent follows (its claim covers every file it
// changed, no one else's claim does, the reviewed commit has the approvals, it
// merges into main without conflicts, and the project's checks pass on main
// plus the change) and refuses to help break them. It decides nothing that
// binds anyone: an agent can merge with plain git instead, and the audit sees
// the same records.
//
// There's no line of merges. Claims keep changes in flight off each other's
// paths, so ready changes merge in any order to the same code: what lands is
// a set, not a sequence. A change is ready once it's approved, which the
// votes already record, so asking to merge writes nothing. The merge that
// takes the branch's lease (see landing.ts) lands every ready change into the
// branch at once: checked together in one run on main, each as its own merge
// commit, pushed in one push, so main is only ever code that was checked.
// The other merges wait for what their change came to, reading the lease (a
// record in Git, see landing-lease.ts) and the outcomes kept beside it. A batch that fails is split and its halves checked side by
// side; one change failing alone is checked once more (a flaky run isn't a
// verdict), then put out with a rejection from the checks on its head.
//
// A batch's git work (fetching each change, the files it changed, the merges,
// the push) runs in the repo's own Gate's container, with real git on a disk
// (see BatchGit): done here, in memory, it took one request past its CPU. The
// Worker only reads the records: claims, votes, approvals.

const ATTEMPTS = 3;

/** One check command's result. */
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
	/** Where its branch lives (its fork); absent, the project repo. */
	source?: Remote;
	agent: string;
}

/**
 * Runs the project's checks on `base` (main) with `changes` merged in, in
 * order: what main becomes with all of them landed. Live, in a Gate's
 * container: the one named `gate` (see checkBatch), else the last change's.
 */
export type CheckRunner = (input: { base: string; branch: string; changes: BatchChange[]; commands: string[]; gate?: string }) => Promise<{ passed: boolean; results: CheckResult[] }>;

/**
 * Where a batch's checks run: a few containers of its own, named for the
 * batch (`search`) and a place in its search for a failure (`slot`), so each
 * round of the search finds its container running, with the batch fetched and
 * its dependencies installed. Only that batch's code ever runs in them, and
 * they stop a minute after its search, as every check container does.
 */
interface Place {
	search: string;
	slot: number;
	/** The next slot free in this search. */
	slots: { next: number };
}

/** A change in a batch, before its head is read: its branch, and where it lives. */
export type BatchSource = Omit<BatchChange, "head">;

/** A change as its branch has it now: its head, and the files it changed since it left main; or why it couldn't be read. */
export type Inspected = { change: string; head: string; files: string[] } | { change: string; error: string };

/**
 * A batch's git work, in the repo's own Gate's container: real git on a disk,
 * in a container that never runs a change's code, so what it reads and pushes
 * can be trusted (see gate.ts). Landed in a Worker's memory instead, batches
 * of 60 ran out of it (run 217), and small ones were slower than the Gate's
 * (agents-6): the copy of the repo was made again in each new isolate, and
 * changes were fetched one at a time.
 */
export interface BatchGit {
	/** Each change's head now and the files it changed since it left `base`. */
	inspect(input: { base: string; branch: string; changes: BatchSource[] }): Promise<Inspected[]>;
	/**
	 * Land `merges` on `base`, in order, each its own merge commit with the
	 * trailers its claim gives (its base, the commit before it, filled in) and
	 * GitHive's stamp as `by`, in one push. Their commits, or "moved" if the
	 * branch isn't at `base` any more.
	 */
	land(input: { base: string; branch: string; merges: (BatchChange & { claimed: Omit<MergeClaim, "base"> })[]; by?: string; stamper?: Stamper }): Promise<{ commits: string[] } | "moved">;
	/**
	 * `changes` merged onto `base` as they'd land, each its own merge, pushed to
	 * `ref` on `to` (a connected GitHub repo, for its Actions): the tip, or why
	 * it couldn't be.
	 */
	checksBranch(input: { base: string; branch: string; changes: BatchChange[]; to: Remote; ref: string }): Promise<{ tip: string } | { failed: string }>;
	/** Push `branch` at `head` to `to` as a fast-forward only (GitHub's copy): refused, it throws. */
	pushBranch(input: { branch: string; head: string; to: Remote }): Promise<void>;
}

/** Another change that may land with this one: its claim, its head as last seen, and where its branch lives. */
export interface Candidate {
	claim: ClaimRecord;
	/** Null or absent: nothing pushed, as last seen. */
	head?: string | null;
	source: () => Promise<Remote>;
}

/** The fewest and most changes checked and landed together (see batchSize). */
export const MIN_BATCH = 4;
export const MAX_BATCH = 64;
/** What a branch's failure rate starts from, before it has outcomes of its own: 1 in 20, so batches of 20. */
const PRIOR_FAILED = 1;
const PRIOR_OUTCOMES = 20;
/** How long the lease is taken for: until the merge holding it starts its first step. */
export const LEASE_MS = 3 * 60_000;
/**
 * The longest each step of landing a batch can take. The merge holding the
 * lease keeps it by a heartbeat only while the step running is within its
 * bound: a step stuck past it lets the lease run out soon after, and a merge
 * that died lets it run out within LEASE_TTL_MS; a waiting merge takes over.
 */
const STEP_MS = {
	/** In the repo's Gate: starting its container, then reading every change of a batch, or landing them. */
	gate: 5 * 60_000,
	/** Reading or writing records: claims, votes, releases, rejections. */
	records: 2 * 60_000,
	/** Each check command (the Gate stops one after 10 minutes, see CHECK_TIMEOUT_S in gate.ts); a run adds an install and setting up. */
	checkCommand: 10 * 60_000,
};
const POLL_MS = 3_000;
/** How often a merge holding the lease shows it's alive, and how far ahead each time keeps the lease. */
const HEARTBEAT_MS = 30_000;
export const LEASE_TTL_MS = 2 * 60_000;
/**
 * How long a merge waits before it answers "still waiting" (merging again
 * waits on), and how long one holding the lease goes on starting batches.
 * Not a limit on landing, which waits as long as the lease is held: Cloudflare
 * drops a request held open past about 20 minutes (a 502, after 21-25 minutes
 * at 200 agents), so every answer comes well before.
 */
export const ANSWER_WITHIN_MS = 10 * 60_000;
/** How many batches a merge holding the lease checks before handing it on, if its own change hasn't settled. */
const ROUNDS = 4;
/** Who a change's failed checks are recorded as: a rejection of the head they failed on, which sends it back to its agent. */
export const CHECKS_REVIEWER = "githive-checks";
/** How many changes of a batch are checked against their claims at once (their votes are read once, for all). 4 at a time, each reading its votes too, took 20 to 28 s for 64. */
const VALIDATIONS_AT_ONCE = 8;
/** How many landed changes' claims are released at once. */
const RELEASES_AT_ONCE = 4;
/** How many forks' read access a batch asks for at once (a Worker request holds only so many connections open). */
const SOURCES_AT_ONCE = 6;
/** How much of a failed check's output its outcome keeps, for the merges waiting on it. */
const OUTCOME_OUTPUT_CHARS = 1_000;
/** How much of a failed check's output its rejection keeps. */
const EVIDENCE_CHARS = 2_000;

export interface MergeInput {
	remote: Remote;
	/** The project's branch the change merges into. */
	branch: string;
	/** Where the change's branch lives (its fork); by default the project repo. */
	source?: Remote;
	/** The repo's claims: checked before merging, cited on the merge, released after. */
	store: ClaimStore;
	/** The repo's votes: counted on the change's head, and cited on the merge. */
	votes: VoteStore;
	policy: ReviewPolicy;
	/** The project's checks; none means the merge isn't tested. */
	verify?: string[];
	/** What the checks skip (see check-scope.ts): absent, the defaults. */
	skipChecks?: string[];
	runChecks?: CheckRunner;
	/** Stamps the merges (and the releases) with the caller's verified identity. */
	stamper?: Stamper;
	/** The registry's stamp key: when set, only stamped votes count. */
	stampKey?: string;
	change: string;
	agent: string;
	/** A file as the claims records name it, for a change into a branch other than the project's (see branch-scope.ts). */
	scope?: (file: string) => string;
	/**
	 * The branch's head, as kept a moment for every merge watching it. Absent:
	 * listed each time. A head a moment old is safe: a batch pushes by
	 * compare-and-swap, and checks again when the branch moved.
	 */
	branchHead?: () => Promise<string | null>;
	/** The other changes into this branch that may land with this one (absent: none). */
	others?: () => Promise<Candidate[]>;
	/** The branch's lease, and what changes came to (absent: kept for this merge only). */
	landing?: Landing;
	/** Where a batch's git work runs: the repo's own Gate (see BatchGit). */
	batchGit: BatchGit;
	/** Reads repos' history through Artifacts' API: the change is checked that way, without a fetch, where it can be (see changeAgainst). */
	history?: ReadHistory;
	/** Start the container of a batch's first check (`gate`, see Place) while the batch is read, so the check finds it running. */
	prepareChecks?: (gate: string) => Promise<void>;
	/**
	 * Start the repo's Gate's container while the batch is read (through
	 * Artifacts, in the Worker), so the landing finds it running: left to the
	 * landing, its restart made landing a batch take 17 to 29 s (agents-8)
	 * where a running one took 2 to 3 (agents-7).
	 */
	prepareLanding?: () => Promise<void>;
	/** The most changes in a batch, below what batchSize says (tests set a few, to make batches follow each other). */
	maxBatch?: number;
	/** Once a batch has landed and its claims are released: with the branch's new head (main pushed back to GitHub, say). Its failure is logged, never the merge's. */
	afterLanding?: (commit: string) => Promise<void>;
	/** How often a merge waiting for its change to land looks (POLL_MS unless set). */
	pollMs?: number;
	/** How long before a merge answers, landed or not (ANSWER_WITHIN_MS unless set, as tests do). */
	answerWithinMs?: number;
	/** The lease's heartbeat and how far ahead each beat keeps it (HEARTBEAT_MS and LEASE_TTL_MS unless set, as tests do). */
	heartbeatMs?: number;
	leaseTtlMs?: number;
}

export type MergeOutcome =
	| { ok: true; commit: string; /** Why no checks ran, when they're configured. */ checks?: string }
	| {
			ok: false;
			reasons: string[];
			conflicts?: string[];
			/** For each file in conflict that a change landed on lately: that change, its agent, its intent and commit. */
			causes?: ReturnType<typeof lastLandedOn>;
			checks?: CheckResult[];
			/** Still waiting to land, not refused: merging again waits on. */ pending?: true;
	  };

type Refused = Extract<MergeOutcome, { ok: false }>;

/** A change ready to land: checked against its claim and votes, and merging cleanly onto main. */
interface Ready {
	change: string;
	agent: string;
	head: string;
	ref: string;
	source?: Remote;
	files: string[];
	/** The files as the claims records name them. */
	scoped: string[];
	claims: ClaimsView;
	own: ClaimRecord;
	votes: VotesView;
	/** Whether the checks skip it (it only touches what they skip). */
	skipped: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Merge `changes/<change>` into the branch, with trailers naming the change,
 * the agent, and the claims and votes it checked, together with every other
 * change ready to land; then release the claims. Returns once this change has
 * landed or been put out, or isn't ready any more. Until then it waits for as
 * long as another merge holds the branch's lease, and takes the lease itself
 * once it's free (or ran out): its own batch always takes its own change.
 */
export async function mergeChange(input: MergeInput): Promise<MergeOutcome> {
	const landing = input.landing ?? memoryLanding();
	const holder = crypto.randomUUID();
	const started = Date.now();
	// Whether it's ready now: refused at once if not, so the agent can act (unless it's landed: then its commit).
	const mine = await readyNow(input, landing);
	if (!mine.ok) return (await landedAlready(input, landing, mine.head)) ?? mine.refused;
	const head = mine.ready.head;
	const answerBy = started + (input.answerWithinMs ?? ANSWER_WITHIN_MS);
	for (;;) {
		const turn = await landing.turn(holder, input.change, head, started, LEASE_MS);
		if ("settled" in turn) return outcomeOf(turn.settled);
		if (turn.lease) {
			const outcome = await landWhileHeld(input, landing, holder, answerBy, head);
			// Refused because it isn't ready any more: another batch may have landed it (its claim's released then).
			if (outcome && !outcome.ok) return (await landedAlready(input, landing, head)) ?? outcome;
			if (outcome) return outcome;
		}
		// Not landed yet: say so, before the request is held open long enough for Cloudflare to drop it.
		if (Date.now() >= answerBy) return stillWaiting(input.change, head, Date.now() - started);
		if (!turn.lease) await sleep(input.pollMs ?? POLL_MS);
	}
}

/** A change that's ready and waiting to land, not refused: merging again (with the same commit) waits on, and answers with its commit once it lands. */
function stillWaiting(change: string, head: string, waitedMs: number): MergeOutcome {
	return {
		ok: false,
		pending: true,
		reasons: [`${change} is ready and waiting to land (${head.slice(0, 8)}): others' batches came first in the ${Math.round(waitedMs / 60_000)} minutes this merge waited. Call merge again to go on waiting; it lands with a coming batch.`],
	};
}

/**
 * What the change came to if it landed lately, at `head`: asked again after it
 * landed, its claim is gone. As the landing recalls, else (the RepoCache that
 * recalls it unreachable, or forgetting) from the branch's history in Git:
 * a merge commit whose second parent is `head`.
 */
async function landedAlready(input: MergeInput, landing: Landing, head: string): Promise<MergeOutcome | null> {
	const landed = (await landing.view().catch(() => null))?.recent.findLast((s) => s.change === input.change && s.how === "landed" && s.head === head);
	if (landed) return outcomeOf(landed);
	if (!input.history) return null;
	const main = await headOf(input).catch(() => null);
	const commit = main ? (await landedOn(input.history, repoOfUrl(input.remote.url), input.branch, main, [head]).catch(() => null))?.get(head) : undefined;
	return commit ? { ok: true, commit } : null;
}

/**
 * The batch size: about one failure per batch, 1/p, with p the share of its
 * recent changes whose checks failed. The fewest check runs come at about half
 * that, with a flat curve: 1/p spends a few percent more runs for batches that
 * land more changes at once (see docs/design.md, Landing). p is counted with a
 * prior of 1 in 20, so a new branch starts at 20. Between
 * MIN_BATCH and MAX_BATCH.
 */
export function batchSize(recent: Pick<Settled, "how">[]) {
	const failed = recent.filter((s) => s.how === "failed").length;
	const p = (failed + PRIOR_FAILED) / (recent.length + PRIOR_OUTCOMES);
	return Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.round(1 / p)));
}

/** The change, as ready as it is on the branch now: refused at once if not, so the agent can act. Read here: one change's worth. */
async function readyNow(input: MergeInput, landing: Landing): Promise<{ ok: true; ready: Ready } | { ok: false; refused: Refused; head: string }> {
	const main = (await headOf(input)) ?? fail409(`there's no branch ${input.branch}`);
	const ref = `changes/${input.change}`;
	// Through Artifacts' API where it can (see changeAgainst): no file changed on both sides, it merges cleanly, nothing
	// fetched. Else its Git work in turn (see inWorkspaceTurn), from the branch as kept for the isolate (see
	// Workspace.at): one listing, no clone. Its records are read after, the workspace let go.
	const read = input.history ? await changeAgainst(input.history, repoOfUrl(input.remote.url), input.branch, main, { ref, ...(input.source ? { source: input.source } : {}) }).catch(() => null) : null;
	const { head, files, tried, branch } =
		read && !("error" in read) && !read.both.length
			? { head: read.head, files: read.files, tried: { clean: true } as { clean: boolean; files?: string[] }, branch: input.branch }
			: await inWorkspaceTurn(async () => {
					const ws = await Workspace.at(input.remote, input.branch, main);
					const head = await ws.fetch("change", input.source ?? input.remote, ref);
					const files = await ws.changedPaths(await ws.mergeBase(main, head), head);
					return { head, files, tried: await ws.tryMerge(main, head), branch: ws.branch };
				});
	const ready = await validated(input, { change: input.change, agent: input.agent, ref, ...(input.source ? { source: input.source } : {}), head, files, mine: true });
	if (!ready.ok) return { ok: false, refused: ready, head };
	if (!tried.clean) {
		const conflicts = tried.files ?? [];
		// Who changed each file last, as the landing recalls: the agent knows what it's reconciling with, and whom to ask.
		const causes = lastLandedOn((await landing.view().catch(() => null))?.recent ?? [], conflicts);
		return {
			ok: false,
			head,
			refused: {
				ok: false,
				conflicts,
				...(causes.length ? { causes } : {}),
				reasons: [`changes/${input.change} conflicts with ${branch} in ${conflictWords(conflicts, causes).join(", ")}: merge ${branch} into your branch, resolve inside your claim, push, and get the new commit approved`],
			},
		};
	}
	return ready;
}

function outcomeOf(settled: Settled): MergeOutcome {
	if (settled.how === "landed") return { ok: true, commit: settled.commit!, ...(settled.skipped ? { checks: "skipped: it only touches files the checks skip" } : {}) };
	return { ok: false, reasons: settled.reasons ?? ["it didn't land"], ...(settled.checks ? { checks: settled.checks } : {}) };
}

/** The branch's lease, held by this merge: kept by its heartbeat while the step running is within its bound (see STEP_MS). */
interface Holding {
	step(ms: number): Promise<void>;
	/** False once the lease may be another merge's: refused at a renewal, or not renewed in time. */
	readonly held: boolean;
}

/**
 * Holding the branch's lease: land batches until this merge's own change has
 * settled (then it hands the lease on), for at most ROUNDS batches, starting
 * none after `answerBy`. Null if it hasn't settled by then, or the lease ran
 * out.
 */
async function landWhileHeld(input: MergeInput, landing: Landing, holder: string, answerBy: number, head: string): Promise<MergeOutcome | null> {
	let held = true;
	// Until when the lease is known to be this merge's: as taken, then as last renewed. Past it, unrenewed (the record
	// unreachable, or a step past its bound), another merge may have taken it over.
	let until = Date.now() + LEASE_MS;
	// Until when the step running now may take (the longest, with steps side by side): the heartbeat stops past it.
	let stepUntil = Date.now() + LEASE_MS;
	const keep = async () => {
		if (!held || Date.now() >= stepUntil) return;
		const ttl = input.leaseTtlMs ?? LEASE_TTL_MS;
		const asked = Date.now();
		const renewed = await landing.renew(holder, ttl).catch(() => null);
		// Renewed (or with more than half of it left: see gitLanding's renew), it's this merge's for at least half a ttl more.
		if (renewed) until = Math.max(until, asked + ttl / 2);
		else if (renewed === false) held = false;
	};
	// While this merge is alive and its step within its bound, the lease is kept a little ahead: a merge that died (its
	// request dropped, say) lets it run out within LEASE_TTL_MS, and one stuck in a step that soon after the step's bound.
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
	// The claims of what landed, released once the lease is handed on: a write per change, they'd hold up the next batch.
	const releases: (() => Promise<void>)[] = [];
	try {
		// No new batch once this merge should be answering (a batch takes minutes): the lease goes to a waiting merge.
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

/**
 * One batch: every change ready to land into the branch now (this merge's
 * own among them, asked for at `head`), checked together on main, and landed
 * in one push. Returns what each change that settled came to; this change
 * refused if it isn't ready any more.
 */
async function landBatch(input: MergeInput, landing: Landing, holding: Holding, head: string): Promise<{ ok: true; settled: Settled[]; release: () => Promise<void> } | Refused> {
	for (let attempt = 1; ; attempt++) {
		const from = Date.now();
		// Where its checks will run: the first container starts now, while the batch is read.
		const place: Place = { search: crypto.randomUUID().slice(0, 12), slot: 0, slots: { next: 1 } };
		if (input.verify?.length) void input.prepareChecks?.(`${place.search}-0`).catch((err) => console.error("starting a batch's check container early failed", String(err)));
		void input.prepareLanding?.().catch((err) => console.error("starting the repo's Gate early failed", String(err)));
		await holding.step(STEP_MS.records);
		// Read now, not as kept a moment for the crowd asking (see branchHead): the batch before may have landed a second ago,
		// and a batch built on the main before it is refused at its push, its gathering lost (47 s of 200 agents' run).
		const main = (await branchHead(input.remote, input.branch)) ?? fail409(`there's no branch ${input.branch}`);
		const batchGit = input.batchGit;
		// About one failure per batch, from what the branch's recent changes came to (see batchSize). Without checks nothing
		// fails a batch, so it takes all that's ready: in 200 agents' run, batches of 24 and 52 left 130 ready changes waiting.
		const size = Math.min(input.verify?.length ? batchSize((await landing.view()).recent) : MAX_BATCH, input.maxBatch ?? MAX_BATCH);
		// This merge's own change, and the others approved as last seen, with the heads they were seen at.
		const mine: BatchSource & { seen: string } = { change: input.change, ref: `changes/${input.change}`, ...(input.source ? { source: input.source } : {}), agent: input.agent, seen: head };
		const sources = [mine, ...(await candidates(input, landing, size - 1))];
		const foundAt = Date.now();
		// Their heads and files, read now, in one go.
		const read = await readBatch(input, batchGit, main, sources, holding);
		const readAt = Date.now();
		await holding.step(STEP_MS.records);
		const own = read[0];
		if ("error" in own) return { ok: false, reasons: [`${input.change} couldn't be read: ${own.error}`] };
		// Each against its claim and votes: a few at once (a Worker request holds only so many connections open), the votes
		// on all their heads read once.
		const seen = await input.votes.readFor(read.flatMap((r) => ("error" in r ? [] : [r.head])));
		const checked = await atMost(VALIDATIONS_AT_ONCE, read, async (r, i) => {
			if (!("error" in r)) return validated(input, { ...sources[i], head: r.head, files: r.files, mine: i === 0 }, seen);
			console.error(`${r.change} can't land with the others now: ${r.error}`);
			return null;
		});
		if (checked[0] && !checked[0].ok) return checked[0];
		const ready = checked.flatMap((c) => (c?.ok ? [c.ready] : []));
		// Oldest claims first, this merge's own among them.
		let batch = ready.sort((x, y) => x.own.since.localeCompare(y.own.since));
		// Any main has merged already (a push answered with a server error though it applied): recorded as landed by the
		// merge that did, its claim released, and left out; merged again, it came to nothing, and the batch failed.
		const already = input.history ? await landedOn(input.history, repoOfUrl(input.remote.url), input.branch, main, batch.map((r) => r.head)).catch(() => new Map<string, string>()) : new Map<string, string>();
		if (already.size) {
			const settled = await settleLanded(input, landing, batch.filter((r) => already.has(r.head)), already);
			batch = batch.filter((r) => !already.has(r.head));
			if (!batch.some((r) => r.change === input.change)) return { ok: true, settled, release: async () => undefined };
		}
		const gathered = Date.now();
		const tested = !!input.verify?.length && batch.some((r) => !r.skipped);
		// The first part found passing lands at once, while the search goes on for what failed: its changes don't wait for
		// someone else's. Each part was checked on main alone, so only one can land as checked; the rest wait for the next batch.
		let early: Promise<{ part: Ready[]; landed: Landed | null; ms: number }> | undefined;
		const found = (part: Ready[]) => {
			early ??= (async () => {
				const at = Date.now();
				await holding.step(STEP_MS.gate);
				// The lease lost meanwhile: the merge holding it now lands what's ready, checking it itself.
				if (!holding.held) return { part, landed: { settled: [], release: async () => undefined }, ms: 0 };
				const landed = await land(input, landing, batchGit, main, part, tested, holding);
				return { part, landed, ms: Date.now() - at };
			})();
		};
		const settled: Settled[] = [];
		// The lease lost while the batch was gathered: nothing checked, nothing landed; the merge waits its turn again.
		if (!holding.held) return { ok: true, settled: [], release: async () => undefined };
		if (tested) {
			if (!input.runChecks) throw new Error("[500] checks are configured but nothing can run them");
			await landing.checking({ base: main, since: new Date().toISOString(), changes: batch.map((r) => ({ change: r.change, head: r.head, agent: r.agent })) });
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
			// The branch moved under the batch (a merge outside it): what passed was checked on another main.
			if (attempt < ATTEMPTS) continue;
			return { ok: false, reasons: [`the project's branch kept moving while ${input.change} merged (other merges landed first): merge again`] };
		}
		return { ok: true, settled: [...settled, ...done.landed.settled], release: done.landed.release };
	}
}

/**
 * Check `batch` on main, in its `place`: each part found passing is `found`
 * (the batch, if it passes whole). Failing, its halves are checked side by
 * side. One change failing alone is checked once more, then is one of those
 * returned, to be put out.
 */
async function checkBatch(input: MergeInput, main: string, batch: Ready[], holding: Holding, place: Place, found: (part: Ready[]) => void): Promise<{ ready: Ready; results: CheckResult[] }[]> {
	// A check run is its commands, an install the Gate may add, and setting up: each as long as the Gate lets a command run.
	const run = async () => {
		await holding.step((input.verify!.length + 2) * STEP_MS.checkCommand);
		const checked = await input.runChecks!({
			base: main,
			branch: input.branch,
			changes: batch.map((r) => ({ change: r.change, head: r.head, ref: r.ref, ...(r.source ? { source: r.source } : {}), agent: r.agent })),
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
	// The first half stays in this container, where its changes ran just now; the second takes another, and keeps it for its own halves.
	const second = { ...place, slot: place.slots.next++ };
	const [a, b] = await Promise.all([checkBatch(input, main, batch.slice(0, half), holding, place, found), checkBatch(input, main, batch.slice(half), holding, second, found)]);
	return [...a, ...b];
}

/** Put a change out: its checks failed on its head, alone on main. Recorded as the checks' rejection of that head, which sends it back to its agent. */
async function putOut(input: MergeInput, ready: Ready, results: CheckResult[]): Promise<Settled> {
	const failed = results.find((r) => r.exitCode !== 0);
	const reasons = [failed ? `checks failed: ${failed.command} exited ${failed.exitCode}` : "checks failed"];
	const evidence = `${reasons[0]} on ${ready.head.slice(0, 8)}, checked alone on the branch, twice${failed?.output ? `:\n${failed.output.slice(-EVIDENCE_CHARS)}` : ""}`;
	await input.votes.vote({ commit: ready.head, reviewer: CHECKS_REVIEWER, role: "checks", verdict: "reject", evidence }, input.stamper).catch((err) => console.error(`recording ${ready.change}'s failed checks failed`, String(err)));
	// Kept with the lease's recent outcomes: only the command that failed, and the end of what it printed (the rejection has more).
	const checks = results.filter((r) => r.exitCode !== 0).map((r) => ({ ...r, output: r.output.slice(-OUTCOME_OUTPUT_CHARS) }));
	return { change: ready.change, head: ready.head, agent: ready.agent, how: "failed", at: new Date().toISOString(), reasons, checks };
}

/** A batch that landed: what each change came to, and the release of their claims, for once the lease is handed on. */
interface Landed {
	settled: Settled[];
	release: () => Promise<void>;
}

/** The approvals a change's head lands with, each reviewer's evidence for the merge commit to tell. */
function approvalsOn(ready: Ready): MergeReview[] {
	const approvals = ready.votes.votes.filter((vote) => vote.commit === ready.head && vote.verdict === "approve");
	return approvals.map((vote) => ({ reviewer: vote.reviewer, role: vote.role, evidence: vote.evidence }));
}

/**
 * Land `batch` on main: each change as its own merge commit, one after
 * another, pushed in one push. Tested, each records the main the checks ran
 * on and every change checked with it. Their merges, waiting, hear as soon as
 * it's pushed; their claims are released later (see Landed), and until then
 * no batch takes them up (see candidates). Null if main moved meanwhile.
 */
async function land(input: MergeInput, landing: Landing, batchGit: BatchGit, main: string, batch: Ready[], tested: boolean, holding: Holding): Promise<Landed | null> {
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
				// Checked with others: every change in the batch, in landing order (alone, the main it ran on says it all).
				...(tested && heads.length > 1 ? { testedWith: heads } : {}),
				intent: r.own.intent,
				reviews: approvalsOn(r),
			},
		})),
		// The Gate stamps with GitHive's key as `by`; an implementation in this process (a test's) with the stamper itself.
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
	// Told at once: a merge asked again before its claim is released finds its change landed (see landedAlready).
	await landing.settle(settled);
	console.log(`landed ${batch.length} change${batch.length === 1 ? "" : "s"} on ${input.branch} (${tested ? "checked together" : "no checks"}): merged and pushed ${pushedAt - from} ms, told ${Date.now() - pushedAt} ms`);
	const release = async () => {
		const releaseFrom = Date.now();
		// A few at a time: a Worker holds only so many connections open, and stalls past that.
		for (let i = 0; i < batch.length; i += RELEASES_AT_ONCE)
			await Promise.all(
				batch.slice(i, i + RELEASES_AT_ONCE).map((r, j) =>
					input.store.release({ change: r.change, agent: r.agent, reason: "merged", mergedAs: commits[i + j] }, input.stamper).catch((err) => console.error(`releasing ${r.change}'s claim after it merged failed`, String(err))),
				),
			);
		console.log(`released the claims of ${batch.length} change${batch.length === 1 ? "" : "s"} landed on ${input.branch}, after the lease was handed on: ${Date.now() - releaseFrom} ms`);
		if (input.afterLanding) {
			const from = Date.now();
			await input
				.afterLanding(commits.at(-1)!)
				.then(() => console.log(`after landing on ${input.branch} (main pushed to GitHub, say): ${Date.now() - from} ms`))
				.catch((err) => console.error(`after landing on ${input.branch} failed (main not pushed to GitHub, say)`, String(err)));
		}
	};
	return { settled, release };
}

/** Changes `on` main already (by the merge that merged each head): recorded as landed, and their claims released. */
async function settleLanded(input: MergeInput, landing: Landing, changes: Ready[], on: Map<string, string>): Promise<Settled[]> {
	const at = new Date().toISOString();
	const settled: Settled[] = changes.map((r) => ({ change: r.change, head: r.head, agent: r.agent, how: "landed", at, commit: on.get(r.head)!, files: r.files.slice(0, LANDED_FILES_KEPT), ...(r.files.length > LANDED_FILES_KEPT ? { filesMore: r.files.length - LANDED_FILES_KEPT } : {}) }));
	await landing.settle(settled);
	console.log(`${changes.length} change${changes.length === 1 ? " was" : "s were"} on ${input.branch} already, unrecorded: ${changes.map((r) => r.change).join(", ")}`);
	for (let i = 0; i < changes.length; i += RELEASES_AT_ONCE)
		await Promise.all(
			changes.slice(i, i + RELEASES_AT_ONCE).map((r) => input.store.release({ change: r.change, agent: r.agent, reason: "merged", mergedAs: on.get(r.head)! }, input.stamper).catch((err) => console.error(`releasing ${r.change}'s claim, found on ${input.branch} already, failed`, String(err)))),
		);
	return settled;
}

/**
 * The other changes that may be ready to land with this one: approved as last
 * seen and not sent back (the rest aren't worth reading), and not in
 * `leaving`. Oldest claims first, `count` at most, each with the head it was
 * seen at. Each is read and checked again before it lands.
 */
async function candidates(input: MergeInput, landing: Landing, count: number): Promise<(BatchSource & { seen: string })[]> {
	// Landed lately at the head seen: its claim may not be released yet (that waits for the lease to be handed on).
	const landed = new Set(((await landing.view().catch(() => null))?.recent ?? []).filter((s) => s.how === "landed").map((s) => `${s.change} ${s.head}`));
	const others = ((await input.others?.().catch((err) => (console.error("reading the other changes to land failed", String(err)), []))) ?? []).filter(
		(c): c is Candidate & { head: string } => c.claim.change !== input.change && !!c.head && !landed.has(`${c.claim.change} ${c.head}`),
	);
	if (!others.length) return [];
	const seen = await input.votes.readFor(others.map((c) => c.head));
	const counted = await countedVotes(seen.votes.filter((v) => others.some((c) => c.head === v.commit)), input.stampKey);
	const likely = others
		.filter((c) => {
			const author = { agent: c.claim.agent, ...(c.claim.by ? { by: c.claim.by } : {}) };
			if (counted.some((v) => v.commit === c.head && v.verdict === "reject" && v.reviewer !== author.agent)) return false;
			return approval({ votes: counted }, c.head, input.policy, author, c.claim.paths).approved;
		})
		.sort((a, b) => a.claim.since.localeCompare(b.claim.since))
		.slice(0, Math.max(0, count));
	// Read access to each one's fork, a few at a time: asked for one after another, a batch's gathering grew with its size.
	const sources = await atMost(SOURCES_AT_ONCE, likely, async (c) => {
		const source = await c.source().catch((err) => (console.error(`${c.claim.change}'s fork can't be read`, String(err)), null));
		return source ? { change: c.claim.change, ref: `changes/${c.claim.change}`, source, agent: c.claim.agent, seen: c.head } : null;
	});
	return sources.filter((s): s is NonNullable<typeof s> => !!s);
}

/** Each of `sources`' head and the files it changed since it left `main`, read in one go. In `sources`' order. */
async function readBatch(input: MergeInput, batchGit: BatchGit, main: string, sources: (BatchSource & { seen: string })[], holding: Holding): Promise<Inspected[]> {
	await holding.step(STEP_MS.gate);
	return batchGit.inspect({ base: main, branch: input.branch, changes: sources.map(({ seen: _, ...s }) => s) });
}

/**
 * Whether a change at `head`, changing `files`, may land: its claim covers
 * every file and no one else's does, its head has the approvals, and its
 * checks haven't failed on that head. Another agent's change lands only as its
 * own agent would merge it: not over a reviewer who asked for changes. Reads only the
 * records; whether it merges cleanly is the batch's to find.
 */
async function validated(input: MergeInput, c: BatchSource & { head: string; files: string[]; mine: boolean }, seen?: VotesView): Promise<{ ok: true; ready: Ready } | Refused> {
	const { head, files } = c;
	// The same files as the claims records name them: in the branch's own part, for a branch other than the project's.
	const scoped = input.scope ? files.map(input.scope) : files;
	// The claims that bear on these files (the change's own, and any covering them), and the votes on its head (as read
	// for its whole batch, if they were).
	const [claims, votes] = await Promise.all([input.store.readScope(c.change, scoped), seen ?? input.votes.readFor([head])]);

	const reasons: string[] = [];
	const own = claims.claims.find((x) => x.change === c.change);
	if (!own) reasons.push(`${c.change} holds no claim`);
	files.forEach((file, i) => {
		const holder = claims.claims.find((x) => x.change !== c.change && inLane(scoped[i], x.paths));
		if (holder) reasons.push(`${file} is inside ${holder.change}'s claim (${holder.agent})`);
		else if (own && !inLane(scoped[i], own.paths)) reasons.push(`${file} is outside ${c.change}'s claim`);
	});
	const counted = await countedVotes(votes.votes.filter((v) => v.commit === head), input.stampKey);
	// Distinct reviewers, never the change's author: its claim's agent, and who made the claim.
	// The policy for what it touches: stricter for dependency, CI and deploy files, say.
	const outcome = approval({ votes: counted }, head, input.policy, own, files);
	const { required } = effectivePolicy(input.policy, files);
	if (outcome.vetoedBy.length) reasons.push(`${head} is vetoed by ${outcome.vetoedBy.join(", ")}`);
	else if (outcome.approvals < required) reasons.push(`${head} has ${outcome.approvals} of ${required} approvals from reviewers other than its author`);
	else if (outcome.awaiting.length) reasons.push(`${head} still needs approval from ${outcome.awaiting.join(", ")}, which can veto it`);
	// Its checks failed on this very commit, checked alone, twice: merging it again would only fail again. A new commit is checked afresh.
	const failed = counted.find((v) => v.reviewer === CHECKS_REVIEWER && v.verdict === "reject");
	if (failed) reasons.push(`${failed.evidence.split("\n")[0]}: push a fix (a new commit) and get it approved`);
	else if (!c.mine) {
		const sentBack = counted.find((v) => v.verdict === "reject" && v.reviewer !== (own?.agent ?? c.agent));
		if (sentBack) reasons.push(`${sentBack.reviewer} asked for changes on ${head}`);
	}
	if (reasons.length || !own) return { ok: false, reasons };
	// None for a change that only touches what the checks skip (documentation and the like: see check-scope.ts).
	const skipped = !!input.verify?.length && skipsChecks(files, input.skipChecks);
	return { ok: true, ready: { change: c.change, agent: c.agent, head, ref: c.ref, ...(c.source ? { source: c.source } : {}), files, scoped, claims, own, votes, skipped } };
}

/** `f` over `items`, at most `n` at once; the results in the items' order. */
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

/** The branch's head: as kept for every merge watching it, or listed. */
const headOf = (input: MergeInput) => (input.branchHead ? input.branchHead() : branchHead(input.remote, input.branch));

const fail409 = (message: string): never => {
	throw new Error(`[409] ${message}`);
};
