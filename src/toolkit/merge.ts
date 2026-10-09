import git from "isomorphic-git";
import { BOT, branchHead, type Remote, Workspace } from "../git";
import { inLane } from "../claim-paths";
import { skipsChecks } from "./check-scope";
import type { ClaimRecord } from "./claims";
import type { ClaimStore, ClaimsView } from "./claim-store";
import { type Landing, memoryLanding, type Settled } from "./landing";
import { type MergeClaim, mergeMessage } from "./merge-commit";
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
// The other merges wait for what their change came to, reading the lease,
// never Git. A batch that fails is split and its halves checked side by
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
 * order: what main becomes with all of them landed. Live, in the Gate's
 * container (the last change's).
 */
export type CheckRunner = (input: { base: string; branch: string; changes: BatchChange[]; commands: string[] }) => Promise<{ passed: boolean; results: CheckResult[] }>;

/** A change in a batch, before its head is read: its branch, and where it lives. */
export type BatchSource = Omit<BatchChange, "head">;

/** A change as its branch has it now: its head, and the files it changed since it left main; or why it couldn't be read. */
export type Inspected = { change: string; head: string; files: string[] } | { change: string; error: string };

/**
 * A batch's git work. Live, in the repo's own Gate's container: real git on a
 * disk, in a container that never runs a change's code, so what it reads and
 * pushes can be trusted (see gate.ts). Without one, in memory here (see
 * memoryBatchGit).
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
	land(input: { base: string; branch: string; merges: (BatchChange & { claimed: Omit<MergeClaim, "base"> })[]; by?: string }): Promise<{ commits: string[] } | "moved">;
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
 * lease keeps it that long as each step starts: a step stuck past its bound
 * lets the lease run out, and a waiting merge takes over. No clock decides
 * anything else: a merge waits for as long as someone holds the lease.
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
/** How many batches a merge holding the lease checks before handing it on, if its own change hasn't settled. */
const ROUNDS = 4;
/** Who a change's failed checks are recorded as: a rejection of the head they failed on, which sends it back to its agent. */
export const CHECKS_REVIEWER = "githive-checks";
/** How many changes of a batch are checked against their claims and votes at once. */
const VALIDATIONS_AT_ONCE = 4;
/** How many landed changes' claims are released at once. */
const RELEASES_AT_ONCE = 4;
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
	/** Where a batch's git work runs (absent: in memory, here). */
	batchGit?: BatchGit;
	/** How often a merge waiting for its change to land looks (POLL_MS unless set). */
	pollMs?: number;
}

export type MergeOutcome =
	| { ok: true; commit: string; /** Why no checks ran, when they're configured. */ checks?: string }
	| { ok: false; reasons: string[]; conflicts?: string[]; checks?: CheckResult[] };

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
	const mine = await readyNow(input);
	if (!mine.ok) return (await landedAlready(landing, input.change, mine.head)) ?? mine.refused;
	const head = mine.ready.head;
	for (;;) {
		const turn = await landing.turn(holder, input.change, head, started, LEASE_MS);
		if ("settled" in turn) return outcomeOf(turn.settled);
		if (turn.lease) {
			const outcome = await landWhileHeld(input, landing, holder);
			// Refused because it isn't ready any more: another batch may have landed it (its claim's released then).
			if (outcome && !outcome.ok) return (await landedAlready(landing, input.change, head)) ?? outcome;
			if (outcome) return outcome;
		} else await sleep(input.pollMs ?? POLL_MS);
	}
}

/** What the change came to if it landed lately (at `head`, when known): asked again after it landed, its claim is gone. */
async function landedAlready(landing: Landing, change: string, head?: string): Promise<MergeOutcome | null> {
	const landed = (await landing.view()).recent.findLast((s) => s.change === change && s.how === "landed" && (!head || s.head === head));
	return landed ? outcomeOf(landed) : null;
}

/**
 * The batch size that keeps a branch's check runs fewest: about one failure
 * per batch, 1/p, with p the share of its recent changes whose checks failed
 * (counted with a prior of 1 in 20, so a new branch starts at 20). Between
 * MIN_BATCH and MAX_BATCH.
 */
export function batchSize(recent: Pick<Settled, "how">[]) {
	const failed = recent.filter((s) => s.how === "failed").length;
	const p = (failed + PRIOR_FAILED) / (recent.length + PRIOR_OUTCOMES);
	return Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.round(1 / p)));
}

/** The change, as ready as it is on the branch now: refused at once if not, so the agent can act. Read here: one change's worth. */
async function readyNow(input: MergeInput): Promise<{ ok: true; ready: Ready } | { ok: false; refused: Refused; head: string }> {
	const main = (await headOf(input)) ?? fail409(`there's no branch ${input.branch}`);
	// From the branch as kept for the isolate (see Workspace.at): one listing, no clone.
	const ws = await Workspace.at(input.remote, input.branch, main);
	const ref = `changes/${input.change}`;
	const head = await ws.fetch("change", input.source ?? input.remote, ref);
	const files = await ws.changedPaths(await ws.mergeBase(main, head), head);
	const ready = await validated(input, { change: input.change, agent: input.agent, ref, ...(input.source ? { source: input.source } : {}), head, files, mine: true });
	if (!ready.ok) return { ok: false, refused: ready, head };
	const tried = await ws.tryMerge(main, head);
	if (!tried.clean) {
		const conflicts = tried.files ?? [];
		return {
			ok: false,
			head,
			refused: {
				ok: false,
				conflicts,
				reasons: [`changes/${input.change} conflicts with ${ws.branch} in ${conflicts.join(", ")}: merge ${ws.branch} into your branch, resolve inside your claim, push, and get the new commit approved`],
			},
		};
	}
	return ready;
}

function outcomeOf(settled: Settled): MergeOutcome {
	if (settled.how === "landed") return { ok: true, commit: settled.commit!, ...(settled.skipped ? { checks: "skipped: it only touches files the checks skip" } : {}) };
	return { ok: false, reasons: settled.reasons ?? ["it didn't land"], ...(settled.checks ? { checks: settled.checks } : {}) };
}

/** The branch's lease, held by this merge: kept as each step starts, for as long as that step can take (see STEP_MS). */
interface Holding {
	step(ms: number): Promise<void>;
	/** False once the lease ran out and another merge took it. */
	readonly held: boolean;
}

/**
 * Holding the branch's lease: land batches until this merge's own change has
 * settled (then it hands the lease on), for at most ROUNDS batches. Null if
 * it hasn't settled by then, or the lease ran out.
 */
async function landWhileHeld(input: MergeInput, landing: Landing, holder: string): Promise<MergeOutcome | null> {
	let held = true;
	const holding: Holding = {
		get held() {
			return held;
		},
		step: async (ms) => {
			held &&= await landing.renew(holder, ms).catch(() => held);
		},
	};
	try {
		for (let round = 0; round < ROUNDS && held; round++) {
			const done = await landBatch(input, landing, holding);
			if (!done.ok) return done;
			const mine = done.settled.find((s) => s.change === input.change);
			if (mine) return outcomeOf(mine);
		}
		return null;
	} finally {
		await landing.drop(holder).catch(() => undefined);
	}
}

/**
 * One batch: every change ready to land into the branch now (this merge's
 * own among them), checked together on main, and landed in one push.
 * Returns what each change that settled came to; this change refused if it
 * isn't ready any more.
 */
async function landBatch(input: MergeInput, landing: Landing, holding: Holding): Promise<{ ok: true; settled: Settled[] } | Refused> {
	for (let attempt = 1; ; attempt++) {
		const from = Date.now();
		await holding.step(STEP_MS.records);
		const main = (await headOf(input)) ?? fail409(`there's no branch ${input.branch}`);
		const batchGit = input.batchGit ?? memoryBatchGit(input.remote, input.stamper);
		// As many as keeps the branch's check runs fewest, from what its recent changes came to.
		const size = batchSize((await landing.view()).recent);
		// This merge's own change, and the others approved as last seen: their heads and files read in one go.
		const mine: BatchSource = { change: input.change, ref: `changes/${input.change}`, ...(input.source ? { source: input.source } : {}), agent: input.agent };
		const sources = [mine, ...(await candidates(input, size))];
		await holding.step(STEP_MS.gate);
		const read = await batchGit.inspect({ base: main, branch: input.branch, changes: sources });
		await holding.step(STEP_MS.records);
		const own = read[0];
		if ("error" in own) return { ok: false, reasons: [`${input.change} couldn't be read: ${own.error}`] };
		// Each against its claim and votes: a few at once (a Worker request holds only so many connections open).
		const checked = await atMost(VALIDATIONS_AT_ONCE, read, async (r, i) => {
			if (!("error" in r)) return validated(input, { ...sources[i], head: r.head, files: r.files, mine: i === 0 });
			console.error(`${r.change} can't land with the others now: ${r.error}`);
			return null;
		});
		if (checked[0] && !checked[0].ok) return checked[0];
		const ready = checked.flatMap((c) => (c?.ok ? [c.ready] : []));
		// Oldest claims first, this merge's own among them.
		const batch = ready.sort((x, y) => x.own.since.localeCompare(y.own.since));
		const gathered = Date.now();
		const tested = !!input.verify?.length && batch.some((r) => !r.skipped);
		let pass = batch;
		const settled: Settled[] = [];
		if (tested) {
			if (!input.runChecks) throw new Error("[500] checks are configured but nothing can run them");
			await landing.checking({ base: main, since: new Date().toISOString(), changes: batch.map((r) => ({ change: r.change, head: r.head, agent: r.agent })) });
			const checked = await checkBatch(input, main, batch, holding);
			pass = checked.pass;
			await holding.step(STEP_MS.records);
			for (const { ready, results } of checked.failed) settled.push(await putOut(input, ready, results));
		}
		const checkedAt = Date.now();
		await holding.step(STEP_MS.gate);
		const landed = pass.length ? await land(input, batchGit, main, pass, tested, holding) : [];
		console.log(`batch of ${batch.length} (at most ${size}) into ${input.branch}: gathering ${gathered - from} ms, checks ${checkedAt - gathered} ms, landing ${landed === null ? "lost the race" : `${landed.length}`} ${Date.now() - checkedAt} ms`);
		if (landed === null) {
			// The branch moved under the batch (a merge outside it): what passed was checked on another main.
			await landing.settle(settled);
			await landing.checking(null);
			if (attempt < ATTEMPTS) continue;
			return { ok: false, reasons: [`the project's branch kept moving while ${input.change} merged (other merges landed first): merge again`] };
		}
		settled.push(...landed);
		await landing.settle(settled);
		await landing.checking(null);
		return { ok: true, settled };
	}
}

/**
 * Check `batch` on main. Passing, it lands whole. Failing, its halves are
 * checked side by side; each was checked on main alone, so only one passing
 * part can land as checked (the bigger), and the rest wait for the next
 * batch. One change failing alone is checked once more, then put out.
 */
async function checkBatch(input: MergeInput, main: string, batch: Ready[], holding: Holding): Promise<{ pass: Ready[]; failed: { ready: Ready; results: Awaited<ReturnType<CheckRunner>>["results"] }[] }> {
	// A check run is its commands, an install the Gate may add, and setting up: each as long as the Gate lets a command run.
	const run = async () => (await holding.step((input.verify!.length + 2) * STEP_MS.checkCommand), input.runChecks!({ base: main, branch: input.branch, changes: batch.map((r) => ({ change: r.change, head: r.head, ref: r.ref, ...(r.source ? { source: r.source } : {}), agent: r.agent })), commands: input.verify! }));
	const first = await run();
	if (first.passed) return { pass: batch, failed: [] };
	if (batch.length === 1) {
		const again = await run();
		return again.passed ? { pass: batch, failed: [] } : { pass: [], failed: [{ ready: batch[0], results: again.results }] };
	}
	const half = Math.ceil(batch.length / 2);
	const [a, b] = await Promise.all([checkBatch(input, main, batch.slice(0, half), holding), checkBatch(input, main, batch.slice(half), holding)]);
	return { pass: a.pass.length >= b.pass.length ? a.pass : b.pass, failed: [...a.failed, ...b.failed] };
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

/**
 * Land `batch` on main: each change as its own merge commit, one after
 * another, pushed in one push. Tested, each records the main the checks ran
 * on and every change checked with it. Null if main moved meanwhile.
 */
async function land(input: MergeInput, batchGit: BatchGit, main: string, batch: Ready[], tested: boolean, holding: Holding): Promise<Settled[] | null> {
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
			},
		})),
		...(input.stamper ? { by: input.stamper.by } : {}),
	});
	if (landed === "moved") return null;
	const { commits } = landed;
	await holding.step(STEP_MS.records);
	const at = new Date().toISOString();
	const releaseFrom = Date.now();
	// A few at a time: a Worker holds only so many connections open, and stalls past that.
	for (let i = 0; i < batch.length; i += RELEASES_AT_ONCE)
		await Promise.all(
			batch.slice(i, i + RELEASES_AT_ONCE).map((r, j) =>
				input.store.release({ change: r.change, agent: r.agent, reason: "merged", mergedAs: commits[i + j] }, input.stamper).catch((err) => console.error(`releasing ${r.change}'s claim after it merged failed`, String(err))),
			),
		);
	console.log(`landed ${batch.length} change${batch.length === 1 ? "" : "s"} on ${input.branch} (${tested ? "checked together" : "no checks"}), releasing their claims ${Date.now() - releaseFrom} ms`);
	return batch.map((r, i) => ({ change: r.change, head: r.head, agent: r.agent, how: "landed", at, commit: commits[i], ...(r.skipped && input.verify?.length ? { skipped: true } : {}) }));
}

/**
 * The other changes that may be ready to land with this one: approved as last
 * seen and not sent back (the rest aren't worth reading). Oldest claims
 * first, up to a batch of `size` with this one. Each is read and checked
 * again before it lands.
 */
async function candidates(input: MergeInput, size: number): Promise<BatchSource[]> {
	const others = ((await input.others?.().catch((err) => (console.error("reading the other changes to land failed", String(err)), []))) ?? []).filter(
		(c): c is Candidate & { head: string } => c.claim.change !== input.change && !!c.head,
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
		.slice(0, size - 1);
	const sources: BatchSource[] = [];
	for (const c of likely) {
		const source = await c.source().catch((err) => (console.error(`${c.claim.change}'s fork can't be read`, String(err)), null));
		if (source) sources.push({ change: c.claim.change, ref: `changes/${c.claim.change}`, source, agent: c.claim.agent });
	}
	return sources;
}

/**
 * Whether a change at `head`, changing `files`, may land: its claim covers
 * every file and no one else's does, its head has the approvals, and its
 * checks haven't failed on that head. Another agent's change lands only as its
 * own agent would merge it: not over a reviewer who asked for changes. Reads only the
 * records; whether it merges cleanly is the batch's to find.
 */
async function validated(input: MergeInput, c: BatchSource & { head: string; files: string[]; mine: boolean }): Promise<{ ok: true; ready: Ready } | Refused> {
	const { head, files } = c;
	// The same files as the claims records name them: in the branch's own part, for a branch other than the project's.
	const scoped = input.scope ? files.map(input.scope) : files;
	// The claims that bear on these files (the change's own, and any covering them), and the votes on its head.
	const [claims, votes] = await Promise.all([input.store.readScope(c.change, scoped), input.votes.readFor([head])]);

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

/**
 * A batch's git work in memory, here: for tests, and wherever no Gate does it.
 * One request does every change's share, so it's only for small batches.
 */
export function memoryBatchGit(remote: Remote, stamper?: Stamper): BatchGit {
	return {
		inspect: async ({ base, branch, changes }) => {
			const ws = await Workspace.at(remote, branch, base);
			const read: Inspected[] = [];
			// One at a time: they fetch into one workspace.
			for (const c of changes) {
				try {
					const head = await ws.fetch(`change-${c.change}`, c.source ?? remote, c.ref);
					read.push({ change: c.change, head, files: await ws.changedPaths(await ws.mergeBase(base, head), head) });
				} catch (err) {
					read.push({ change: c.change, error: String(err) });
				}
			}
			return read;
		},
		land: async ({ base, branch, merges }) => {
			const ws = await Workspace.at(remote, branch, base);
			if ((await ws.head()) !== base) return "moved";
			const commits: string[] = [];
			for (const m of merges) {
				await ws.fetch(`change-${m.change}`, m.source ?? remote, m.ref);
				const message = await mergeMessage({ ...m.claimed, base: await ws.head() }, stamper);
				// Always a merge commit, never a fast-forward: the merge's trailers are what the audit reads.
				const { oid } = await git.merge({ fs: ws.fs, dir: "/repo", ours: ws.branch, theirs: m.head, message, author: BOT, fastForward: false, abortOnConflict: true });
				if (!oid) throw new Error(`merging ${m.change} made no commit`);
				commits.push(oid);
			}
			// Only onto the base: a push alone refuses only what isn't a fast-forward, and a change branched from a newer main
			// would make this one a fast-forward of it. isomorphic-git can't push with a lease, so it looks just before (the
			// Gate's push is exact; this is for tests, and wherever no Gate lands).
			if ((await branchHead(remote, branch)) !== base) return "moved";
			try {
				await ws.push();
			} catch (err) {
				if (err instanceof git.Errors.PushRejectedError || err instanceof git.Errors.GitPushError) return "moved";
				throw err;
			}
			return { commits };
		},
	};
}

/** `f` over `items`, at most `n` at once; the results in the items' order. */
async function atMost<T, R>(n: number, items: T[], f: (item: T, i: number) => Promise<R>): Promise<R[]> {
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
