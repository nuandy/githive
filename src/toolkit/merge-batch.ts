import { branchHead } from "../git";
import { isGitHubChange } from "./github-settings";
import type { Landing, Settled } from "./landing";
import { checkAndPutOut, gateName, newPlace, type Place } from "./merge-checks";
import { type Attempts, attemptsOf, land, type Landed, leaveOutLanded } from "./merge-land";
import { type Holding, STEP_MS } from "./merge-lease";
import { conflict, scopedFiles, validated } from "./merge-ready";
import type { BatchSource, Candidate, Inspected, MergeInput, Ready, Refused } from "./merge-types";
import { approval, countedVotes } from "./votes";

const ATTEMPTS = 3;
/** The fewest and most changes checked and landed together (see batchSize). */
export const MIN_BATCH = 4;
export const MAX_BATCH = 64;
// The prior for a branch's failure rate, 1 in 20, so a new branch starts with batches of 20.
const PRIOR_FAILED = 1;
const PRIOR_OUTCOMES = 20;
// A Worker request holds only so many connections open.
const SOURCES_AT_ONCE = 6;

// A change in a batch with the head it was last seen at, before its head is read again.
type SeenSource = BatchSource & { seen: string };

// The part of a batch that landed while its search for a failure went on, null if main moved, and how long it took.
interface PartLanded {
	landed: Landed | null;
	ms: number;
}

// A batch gathered for checking, with when its changes were found and read.
interface Gathered {
	ok: true;
	batch: Ready[];
	size: number;
	foundAt: number;
	readAt: number;
}

const noRelease = async () => undefined;

/**
 * About one check failure per batch: 1/p, where p is the share of the branch's recent changes that failed, kept
 * between MIN_BATCH and MAX_BATCH. Half that would need slightly fewer check runs, but 1/p lands more changes at once
 * (see docs/design.md, "Landing").
 */
export function batchSize(recent: Pick<Settled, "how">[]) {
	const failed = recent.filter((settled) => settled.how === "failed").length;
	const failureRate = (failed + PRIOR_FAILED) / (recent.length + PRIOR_OUTCOMES);
	return Math.max(MIN_BATCH, Math.min(MAX_BATCH, Math.round(1 / failureRate)));
}

/** Maps `run` over `items` with at most `limit` running at once, keeping the items' order. */
export async function atMost<T, R>(
	limit: number,
	items: T[],
	run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	// One iterator shared by every worker: each takes the next item as it finishes one.
	const queue = items.entries();
	const worker = async () => {
		for (const [index, item] of queue) results[index] = await run(item, index);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// Lands one batch: every change ready now, including this merge's own at `head`, checked together on main and pushed
// at once. Returns the outcome of each change that settled, or this change's refusal if it's no longer ready.
export async function landBatch(
	input: MergeInput,
	landing: Landing,
	holding: Holding,
	head: string,
): Promise<({ ok: true } & Landed) | Refused> {
	for (let attempt = 1; ; attempt++) {
		const startedAt = Date.now();
		const place = newPlace();
		prepareEarly(input, place);
		await holding.step(STEP_MS.records);
		// Read the head fresh rather than cached (see branchHead). The previous batch may have just landed, and a batch
		// built on an older main is refused at its push and has to be gathered again.
		const baseHead = (await branchHead(input.remote, input.branch)) ?? conflict(`there's no branch ${input.branch}`);
		const gathered = await gatherBatch(input, landing, holding, head, baseHead);
		if (!gathered.ok) return gathered;
		const { batch, settled: foundLanded } = await leaveOutLanded(input, landing, baseHead, gathered.batch);
		if (foundLanded.length && !batch.some((ready) => ready.change === input.change))
			return { ok: true, settled: foundLanded, release: noRelease };
		const gatheredAt = Date.now();
		// If the lease was lost while gathering, nothing is checked or landed, and the merge waits for its turn again.
		if (!holding.held) return { ok: true, settled: [], release: noRelease };
		const tested = !!input.verify?.length && batch.some((ready) => !ready.skipped);
		const attempts = attemptsOf(input, batch);
		const firstPassing = landFirstPassing(input, landing, holding, baseHead, tested, attempts);
		let failures: Settled[] = [];
		if (tested) failures = await checkAndPutOut(input, landing, baseHead, batch, holding, place, firstPassing.found);
		else firstPassing.found(batch);
		const checkedAt = Date.now();
		const done = await firstPassing.outcome();
		const landedCount =
			done.landed === null
				? "lost the race"
				: `${done.landed.settled.filter((settled) => settled.how === "landed").length}`;
		const { size, foundAt, readAt } = gathered;
		console.log(
			`batch of ${batch.length} (at most ${size}) into ${input.branch}: gathering ${gatheredAt - startedAt} ` +
				`ms (finding ${foundAt - startedAt}, reading ${readAt - foundAt}, validating ${gatheredAt - readAt}), ` +
				`checks ${checkedAt - gatheredAt} ms, landing ${landedCount} ${done.ms} ms`,
		);
		await landing.settle(failures);
		await landing.checking(null);
		if (done.landed === null) {
			// A merge from outside the batch moved the branch, so what passed was checked on another main.
			if (attempt < ATTEMPTS) continue;
			return {
				ok: false,
				reasons: [
					`the project's branch kept moving while ${input.change} merged (other merges landed ` + "first): merge again",
				],
				why: ["moved"],
			};
		}
		return { ok: true, settled: [...failures, ...done.landed.settled], release: done.landed.release };
	}
}

// Starts the batch's first check container and the repo's Gate now, while the batch is read.
function prepareEarly(input: MergeInput, place: Place) {
	if (input.verify?.length)
		void input
			.prepareChecks?.(gateName(place))
			.catch((err) => console.error("starting a batch's check container early failed", String(err)));
	void input.prepareLanding?.().catch((err) => console.error("starting the repo's Gate early failed", String(err)));
}

// The first part found passing lands at once while the search for the failure goes on. Each part was checked on main
// alone, so only one can land as checked; the rest wait for the next batch.
function landFirstPassing(
	input: MergeInput,
	landing: Landing,
	holding: Holding,
	baseHead: string,
	tested: boolean,
	attempts: Promise<Attempts>,
) {
	let landingPart: Promise<PartLanded> | undefined;
	const found = (part: Ready[]) => {
		landingPart ??= landPart(input, landing, holding, baseHead, part, tested, attempts);
	};
	const nothingLanded: PartLanded = { landed: { settled: [], release: noRelease }, ms: 0 };
	const outcome = async () => (landingPart ? await landingPart : nothingLanded);
	return { found, outcome };
}

async function landPart(
	input: MergeInput,
	landing: Landing,
	holding: Holding,
	baseHead: string,
	part: Ready[],
	tested: boolean,
	attempts: Promise<Attempts>,
): Promise<PartLanded> {
	const startedAt = Date.now();
	await holding.step(STEP_MS.gate);
	// If the lease was lost meanwhile, its new holder lands what's ready after checking it again.
	if (!holding.held) return { landed: { settled: [], release: noRelease }, ms: 0 };
	const landed = await land(input, landing, baseHead, part, tested, holding, attempts);
	return { landed, ms: Date.now() - startedAt };
}

// Every change ready to land with this merge's own, oldest claims first, or this change's refusal.
async function gatherBatch(
	input: MergeInput,
	landing: Landing,
	holding: Holding,
	head: string,
	baseHead: string,
): Promise<Gathered | Refused> {
	const size = await sizeLimit(input, landing);
	// This merge's own change, and the others approved as last seen, with the heads they were seen at.
	const mine: SeenSource = {
		change: input.change,
		ref: `changes/${input.change}`,
		...(input.source ? { source: input.source } : {}),
		agent: input.agent,
		seen: head,
	};
	const sources = [mine, ...(await candidates(input, landing, size - 1))];
	const foundAt = Date.now();
	const read = await readBatch(input, baseHead, sources, holding);
	const readAt = Date.now();
	await holding.step(STEP_MS.records);
	const own = read[0];
	if (!own) return { ok: false, reasons: [`${input.change} couldn't be read`], why: ["unread"] };
	if ("error" in own)
		return { ok: false, reasons: [`${input.change} couldn't be read: ${own.error}`], why: ["unread"] };
	const checked = await validateAll(input, sources, read);
	if (checked[0] && !checked[0].ok) return checked[0];
	const ready = checked.flatMap((result) => (result?.ok ? [result.ready] : []));
	// Oldest claims first, this merge's own among them.
	const batch = ready.sort((first, second) => first.own.since.localeCompare(second.own.since));
	return { ok: true, batch, size, foundAt, readAt };
}

// Sized for about one failure per batch (see batchSize). Without checks nothing fails a batch, so it takes all that's
// ready.
async function sizeLimit(input: MergeInput, landing: Landing) {
	const sized = input.verify?.length ? batchSize((await landing.view()).recent) : MAX_BATCH;
	return Math.min(sized, input.maxBatch ?? MAX_BATCH);
}

// Checks each change against its claim and votes. The votes on all their heads, and the claims bearing on all
// their files, are read once for the batch.
async function validateAll(input: MergeInput, sources: SeenSource[], read: Inspected[]) {
	const readable = read.flatMap((inspected) => ("error" in inspected ? [] : [inspected]));
	const [votes, claims] = await Promise.all([
		input.votes.readFor(readable.map((inspected) => inspected.head)),
		input.store.readScopes(
			readable.map((inspected) => ({ change: inspected.change, files: scopedFiles(input, inspected.files) })),
		),
	]);
	const claimsOf = new Map(readable.map((inspected, index) => [inspected, claims[index]!]));
	return Promise.all(
		read.map(async (inspected, index) => {
			if ("error" in inspected) {
				console.error(`${inspected.change} can't land with the others now: ${inspected.error}`);
				return null;
			}
			const source = sources[index];
			if (!source) return null;
			const proposed = { ...source, head: inspected.head, files: inspected.files, mine: index === 0 };
			return validated(input, proposed, { votes, claims: claimsOf.get(inspected)! });
		}),
	);
}

// Up to `count` other changes that may be ready to land with this one, oldest claims first: those approved as last
// seen and not sent back. Each is read and checked again before it lands.
async function candidates(input: MergeInput, landing: Landing, count: number): Promise<SeenSource[]> {
	// A change that just landed may keep its claim until the lease is handed on, so skip it.
	const recent = (await landing.view().catch(() => null))?.recent ?? [];
	const landed = new Set(
		recent.filter((settled) => settled.how === "landed").map((settled) => `${settled.change} ${settled.head}`),
	);
	const others = (await otherChanges(input)).filter(
		(candidate): candidate is Candidate & { head: string } =>
			candidate.claim.change !== input.change &&
			!!candidate.head &&
			!landed.has(`${candidate.claim.change} ${candidate.head}`),
	);
	if (!others.length) return [];
	const approved = await approvedAsSeen(input, others);
	const likely = approved
		.sort((first, second) => first.claim.since.localeCompare(second.claim.since))
		.slice(0, Math.max(0, count));
	// Ask for read access to the forks a few at a time. One after another, gathering grew with the batch's size.
	const sources = await atMost(SOURCES_AT_ONCE, likely, (candidate) => readableSource(candidate));
	return sources.filter((source): source is SeenSource => !!source);
}

async function otherChanges(input: MergeInput): Promise<Candidate[]> {
	if (!input.others) return [];
	return input.others().catch((err) => {
		console.error("reading the other changes to land failed", String(err));
		return [];
	});
}

// The candidates approved at the head they were last seen at, and not sent back by a reviewer other than their author.
// GitHub's changes are left to their own merge (githive-github's job, or a person's), which test-merges them first: a
// conflict sends one to a person with no vote to show it, and in another's batch it would break every landing.
async function approvedAsSeen<C extends Candidate & { head: string }>(input: MergeInput, others: C[]): Promise<C[]> {
	const seen = await input.votes.readFor(others.map((candidate) => candidate.head));
	const onTheirHeads = seen.votes.filter((vote) => others.some((candidate) => candidate.head === vote.commit));
	const counted = await countedVotes(onTheirHeads, input.stampKey);
	return others.filter((candidate) => {
		const { claim, head } = candidate;
		if (isGitHubChange(claim)) return false;
		const author = { agent: claim.agent, ...(claim.by ? { by: claim.by } : {}) };
		const sentBack = counted.some(
			(vote) => vote.commit === head && vote.verdict === "reject" && vote.reviewer !== author.agent,
		);
		if (sentBack) return false;
		return approval({ votes: counted }, head, input.policy, author, claim.paths).approved;
	});
}

async function readableSource(candidate: Candidate & { head: string }): Promise<SeenSource | null> {
	const { change, agent } = candidate.claim;
	const source = await candidate.source().catch((err) => {
		console.error(`${change}'s fork can't be read`, String(err));
		return null;
	});
	if (!source) return null;
	return { change, ref: `changes/${change}`, source, agent, seen: candidate.head };
}

// Each source's head and the files it changed since it left main, read in one call, in `sources`' order.
async function readBatch(
	input: MergeInput,
	baseHead: string,
	sources: SeenSource[],
	holding: Holding,
): Promise<Inspected[]> {
	await holding.step(STEP_MS.gate);
	return input.batchGit.inspect({ base: baseHead, branch: input.branch, changes: sources });
}
