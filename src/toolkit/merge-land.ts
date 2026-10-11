import { fail } from "../errors";
import { repoOfUrl } from "../git-http";
import { landedOn } from "./batch-reads";
import { LANDED_FILES_KEPT, LANDED_INTENT_CHARS, type Landing, type Settled } from "./landing";
import { batchChange, putOut } from "./merge-checks";
import { ATTEMPT_LINE_MOST, ATTEMPTS_MOST, type MergeReview } from "./merge-commit";
import { type Holding, STEP_MS } from "./merge-lease";
import { readChange } from "./merge-ready";
import type { Conflict, MergeInput, Ready, Unlanded } from "./merge-types";

const RELEASES_AT_ONCE = 4;
/** How long test-merging a batch's changes one at a time may take, to find the one that didn't merge. */
const FINDING_MS = 2 * 60_000;

// A landed batch: each change's outcome, and the release of their claims for after the lease is handed on.
export interface Landed {
	settled: Settled[];
	release: () => Promise<void>;
}

// Lands `batch` on main in one push, one merge commit per change. Waiting merges hear at once, but claims are
// released later (see Landed) and candidates skips them until then. Null if main moved.
//
// A change that doesn't merge onto the batch is put out, as a change failing its checks is (see putOut), and the rest
// land without it. A batch that was checked was checked with it, so then the rest wait for a batch checked without it.
export async function land(
	input: MergeInput,
	landing: Landing,
	baseHead: string,
	batch: Ready[],
	tested: boolean,
	holding: Holding,
): Promise<Landed | null> {
	const startedAt = Date.now();
	const putOuts: Settled[] = [];
	let part = batch;
	let landed: { commits: string[] } | "moved";
	for (;;) {
		const tried = await input.batchGit.land({
			base: baseHead,
			branch: input.branch,
			merges: await mergesOf(input, baseHead, part, tested),
			// The Gate stamps with GitHive's key as `by`. An in-process implementation (tests) uses the stamper itself.
			...(input.stamper ? { by: input.stamper.by, stamper: input.stamper } : {}),
		});
		if (tried === "moved" || !("failed" in tried)) {
			landed = tried;
			break;
		}
		const found = await conflictIn(input, baseHead, part, tried, holding);
		if (!found) {
			await settleAny(landing, putOuts);
			fail(500, `landing the batch failed: ${tried.failed}`);
		}
		await holding.step(STEP_MS.records);
		const failure = { results: [], conflict: found.conflict };
		putOuts.push(await putOut(input, baseHead, found.ready, failure, `found while landing it on ${input.branch}`));
		part = part.filter((ready) => ready !== found.ready);
		if (tested || !part.length) {
			await settleAny(landing, putOuts);
			return { settled: putOuts, release: async () => undefined };
		}
	}
	if (landed === "moved") {
		await settleAny(landing, putOuts);
		return null;
	}
	const { commits } = landed;
	const pushedAt = Date.now();
	await holding.step(STEP_MS.records);
	const settled = [...putOuts, ...landedOutcomes(input, part, commits)];
	// Record the outcomes now, so a merge retried before its claim is released finds its change landed.
	await landing.settle(settled);
	const plural = part.length === 1 ? "" : "s";
	const how = tested ? "checked together" : "no checks";
	const without = putOuts.length ? `, ${putOuts.length} put out for conflicts` : "";
	console.log(
		`landed ${part.length} change${plural} on ${input.branch} (${how}${without}): merged and pushed ` +
			`${pushedAt - startedAt} ms, told ${Date.now() - pushedAt} ms`,
	);
	return { settled, release: () => releaseLanded(input, part, commits) };
}

// Records the changes put out, if any, so merges waiting on them hear at once.
const settleAny = async (landing: Landing, putOuts: Settled[]) => {
	if (putOuts.length) await landing.settle(putOuts);
};

/**
 * The change in `part` that didn't merge onto the batch, and its files: as the landing said, or else as test-merging
 * each change alone onto the branch finds, for at most FINDING_MS. Null if neither finds one.
 */
async function conflictIn(
	input: MergeInput,
	baseHead: string,
	part: Ready[],
	unlanded: Unlanded,
	holding: Holding,
): Promise<{ ready: Ready; conflict: Conflict } | null> {
	const said = unlanded.conflict;
	const ready = said?.files.length ? part.find((each) => each.change === said.change) : undefined;
	if (ready && said) return { ready, conflict: { files: said.files } };
	await holding.step(STEP_MS.gate);
	const until = Date.now() + FINDING_MS;
	for (const each of part) {
		if (Date.now() > until) break;
		const read = await readChange(input, baseHead, each).catch((err) => {
			console.error(`test-merging ${each.change} to find the change that didn't land failed`, String(err));
			return null;
		});
		// Only the head that was landed counts: a newer one is the next batch's to try.
		if (!read || read.head !== each.head || read.tried.clean) continue;
		const touchedBy = read.touchedBy ? { touchedBy: read.touchedBy } : {};
		return { ready: each, conflict: { files: read.tried.files ?? [], ...touchedBy } };
	}
	console.error(`no change of the ${part.length} that didn't land conflicts alone with ${input.branch}`);
	return null;
}

// Each change's merge with the trailers its commit carries (its claim, its votes and what it was checked on), and
// the story above them.
async function mergesOf(input: MergeInput, baseHead: string, batch: Ready[], tested: boolean) {
	// Every change in the batch, in landing order. A change checked alone needs only testedOn.
	const heads = batch.map((ready) => ready.head);
	const testedOn = tested ? { testedOn: baseHead } : {};
	const testedWith = tested && heads.length > 1 ? { testedWith: heads } : {};
	const attempts = await attemptsOf(input, batch);
	return batch.map((ready) => {
		const tried = (attempts[ready.change] ?? []).slice(-ATTEMPTS_MOST).map((line) => line.slice(0, ATTEMPT_LINE_MOST));
		return {
			...batchChange(ready),
			claimed: {
				head: ready.head,
				change: ready.change,
				author: ready.agent,
				claimsTip: input.store.cite(ready.claims, ready.scoped, ready.own),
				votesTip: input.votes.cite(ready.votes, ready.head),
				...testedOn,
				...testedWith,
				intent: ready.own.intent,
				reviews: approvalsOn(ready),
				...(tried.length ? { attempts: tried } : {}),
			},
		};
	});
}

const ATTEMPTS_WAIT_MS = 2_000;

/**
 * Each change's earlier attempts to land, asked once for the batch. They're only the story, so a call that fails, or
 * takes longer than ATTEMPTS_WAIT_MS, leaves those lines out and never holds the landing up.
 */
async function attemptsOf(input: MergeInput, batch: Ready[]): Promise<Record<string, string[]>> {
	if (!input.attemptsOf) return {};
	let timer: ReturnType<typeof setTimeout> | null = null;
	const slow = new Promise<Record<string, string[]>>((resolve) => {
		timer = setTimeout(() => {
			console.error(`reading earlier attempts took over ${ATTEMPTS_WAIT_MS} ms: landing without them`);
			resolve({});
		}, ATTEMPTS_WAIT_MS);
	});
	try {
		return await Promise.race([input.attemptsOf(batch.map((ready) => ready.change)), slow]);
	} catch (err) {
		console.error("reading earlier attempts failed: landing without them", String(err));
		return {};
	} finally {
		clearTimeout(timer);
	}
}

function approvalsOn(ready: Ready): MergeReview[] {
	const approvals = ready.votes.votes.filter((vote) => vote.commit === ready.head && vote.verdict === "approve");
	return approvals.map((vote) => ({ reviewer: vote.reviewer, role: vote.role, evidence: vote.evidence }));
}

function landedOutcomes(input: MergeInput, batch: Ready[], commits: string[]): Settled[] {
	const at = new Date().toISOString();
	const checksConfigured = !!input.verify?.length;
	return batch.map((ready, index): Settled => ({
		change: ready.change,
		head: ready.head,
		agent: ready.agent,
		how: "landed",
		at,
		commit: commits[index],
		...(ready.skipped && checksConfigured ? { skipped: true } : {}),
		...keptFiles(ready.files),
		...(ready.own.intent ? { intent: ready.own.intent.slice(0, LANDED_INTENT_CHARS) } : {}),
	}));
}

// A landed change's first files, and how many more it changed.
function keptFiles(files: string[]): Pick<Settled, "files" | "filesMore"> {
	const kept = files.slice(0, LANDED_FILES_KEPT);
	const more = files.length - LANDED_FILES_KEPT;
	return more > 0 ? { files: kept, filesMore: more } : { files: kept };
}

// Releases a landed batch's claims, then runs afterLanding. It runs after the lease is handed on.
async function releaseLanded(input: MergeInput, batch: Ready[], commits: string[]) {
	const startedAt = Date.now();
	await releaseClaims(
		input,
		batch,
		(_, index) => commits[index],
		(ready) => `releasing ${ready.change}'s claim after it merged failed`,
	);
	const plural = batch.length === 1 ? "" : "s";
	console.log(
		`released the claims of ${batch.length} change${plural} landed on ${input.branch}, after the lease ` +
			`was handed on: ${Date.now() - startedAt} ms`,
	);
	if (!input.afterLanding) return;
	const afterFrom = Date.now();
	await input
		.afterLanding(commits.at(-1)!)
		.then(() =>
			console.log(`after landing on ${input.branch} (main pushed to GitHub, say): ${Date.now() - afterFrom} ms`),
		)
		.catch((err) =>
			console.error(`after landing on ${input.branch} failed (main not pushed to GitHub, say)`, String(err)),
		);
}

// A push answered with a server error may still have applied. Changes already on main are recorded as landed, their
// claims released, and left out, since merging one again would come to nothing and fail the batch.
export async function leaveOutLanded(
	input: MergeInput,
	landing: Landing,
	baseHead: string,
	batch: Ready[],
): Promise<{ batch: Ready[]; settled: Settled[] }> {
	const already = await alreadyOn(input, baseHead, batch);
	if (!already.size) return { batch, settled: [] };
	const landedChanges = batch.filter((ready) => already.has(ready.head));
	const settled = await settleLanded(input, landing, landedChanges, already);
	return { batch: batch.filter((ready) => !already.has(ready.head)), settled };
}

// Maps each head of `batch` that is on main already to its merge commit.
async function alreadyOn(input: MergeInput, baseHead: string, batch: Ready[]): Promise<Map<string, string>> {
	if (!input.history) return new Map<string, string>();
	const repo = repoOfUrl(input.remote.url);
	const heads = batch.map((ready) => ready.head);
	return landedOn(input.history, repo, input.branch, baseHead, heads).catch(() => new Map<string, string>());
}

// Records changes already on main as landed and releases their claims. `commitOf` maps each head to its merge commit.
async function settleLanded(
	input: MergeInput,
	landing: Landing,
	changes: Ready[],
	commitOf: Map<string, string>,
): Promise<Settled[]> {
	const at = new Date().toISOString();
	const settled = changes.map((ready): Settled => ({
		change: ready.change,
		head: ready.head,
		agent: ready.agent,
		how: "landed",
		at,
		commit: commitOf.get(ready.head)!,
		...keptFiles(ready.files),
	}));
	await landing.settle(settled);
	const were = changes.length === 1 ? " was" : "s were";
	const names = changes.map((ready) => ready.change).join(", ");
	console.log(`${changes.length} change${were} on ${input.branch} already, unrecorded: ${names}`);
	await releaseClaims(
		input,
		changes,
		(ready) => commitOf.get(ready.head)!,
		(ready) => `releasing ${ready.change}'s claim, found on ${input.branch} already, failed`,
	);
	return settled;
}

// Releases the claims of `changes` as merged, a few at a time, because a Worker stalls past a handful of open
// connections. A failed release is logged with `failure`.
async function releaseClaims(
	input: MergeInput,
	changes: Ready[],
	mergedAs: (ready: Ready, index: number) => string | undefined,
	failure: (ready: Ready) => string,
) {
	for (let start = 0; start < changes.length; start += RELEASES_AT_ONCE) {
		const group = changes.slice(start, start + RELEASES_AT_ONCE);
		const releases = group.map((ready, offset) => {
			const merged = mergedAs(ready, start + offset);
			const release = {
				change: ready.change,
				agent: ready.agent,
				reason: "merged" as const,
				...(merged ? { mergedAs: merged } : {}),
			};
			return input.store.release(release, input.stamper).catch((err) => console.error(failure(ready), String(err)));
		});
		await Promise.all(releases);
	}
}
