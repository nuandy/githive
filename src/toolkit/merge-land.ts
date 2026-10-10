import { repoOfUrl } from "../git-http";
import { landedOn } from "./batch-reads";
import { LANDED_FILES_KEPT, LANDED_INTENT_CHARS, type Landing, type Settled } from "./landing";
import { batchChange } from "./merge-checks";
import type { MergeReview } from "./merge-commit";
import { type Holding, STEP_MS } from "./merge-lease";
import type { MergeInput, Ready } from "./merge-types";

const RELEASES_AT_ONCE = 4;

// A landed batch: each change's outcome, and the release of their claims for after the lease is handed on.
export interface Landed {
	settled: Settled[];
	release: () => Promise<void>;
}

// Lands `batch` on main in one push, one merge commit per change. Waiting merges hear at once, but claims are
// released later (see Landed) and candidates skips them until then. Null if main moved.
export async function land(
	input: MergeInput,
	landing: Landing,
	baseHead: string,
	batch: Ready[],
	tested: boolean,
	holding: Holding,
): Promise<Landed | null> {
	const startedAt = Date.now();
	const landed = await input.batchGit.land({
		base: baseHead,
		branch: input.branch,
		merges: mergesOf(input, baseHead, batch, tested),
		// The Gate stamps with GitHive's key as `by`. An in-process implementation (tests) uses the stamper itself.
		...(input.stamper ? { by: input.stamper.by, stamper: input.stamper } : {}),
	});
	if (landed === "moved") return null;
	const { commits } = landed;
	const pushedAt = Date.now();
	await holding.step(STEP_MS.records);
	const settled = landedOutcomes(input, batch, commits);
	// Record the outcomes now, so a merge retried before its claim is released finds its change landed.
	await landing.settle(settled);
	const plural = batch.length === 1 ? "" : "s";
	const how = tested ? "checked together" : "no checks";
	console.log(
		`landed ${batch.length} change${plural} on ${input.branch} (${how}): merged and pushed ${pushedAt - startedAt} ms, told ${Date.now() - pushedAt} ms`,
	);
	return { settled, release: () => releaseLanded(input, batch, commits) };
}

// Each change's merge with the trailers its commit carries: its claim, its votes and what it was checked on.
function mergesOf(input: MergeInput, baseHead: string, batch: Ready[], tested: boolean) {
	// Every change in the batch, in landing order. A change checked alone needs only testedOn.
	const heads = batch.map((ready) => ready.head);
	const testedOn = tested ? { testedOn: baseHead } : {};
	const testedWith = tested && heads.length > 1 ? { testedWith: heads } : {};
	return batch.map((ready) => ({
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
		},
	}));
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
		`released the claims of ${batch.length} change${plural} landed on ${input.branch}, after the lease was handed on: ${Date.now() - startedAt} ms`,
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
	mergedAs: (ready: Ready, index: number) => string,
	failure: (ready: Ready) => string,
) {
	for (let start = 0; start < changes.length; start += RELEASES_AT_ONCE) {
		const group = changes.slice(start, start + RELEASES_AT_ONCE);
		const releases = group.map((ready, offset) => {
			const release = {
				change: ready.change,
				agent: ready.agent,
				reason: "merged" as const,
				mergedAs: mergedAs(ready, start + offset),
			};
			return input.store.release(release, input.stamper).catch((err) => console.error(failure(ready), String(err)));
		});
		await Promise.all(releases);
	}
}
