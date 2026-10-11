import type { Landing, Settled } from "./landing";
import { type Holding, STEP_MS } from "./merge-lease";
import type { BatchChange, CheckResult, MergeInput, Ready } from "./merge-types";
import { fail } from "../errors";

/** The reviewer failed checks are recorded as. Its rejection of the failing head sends the change back to its agent. */
export const CHECKS_REVIEWER = "githive-checks";
/**
 * The check a batch that doesn't merge onto main fails, as the Gate's runner reports it (see env.ts). Its output is
 * the conflict in one line: its files and who changed them.
 */
export const BATCH_MERGE = "(merging the batch onto main)";
// How much of a failed check's output is kept in its outcome, and in its rejection.
const OUTCOME_OUTPUT_CHARS = 1_000;
const EVIDENCE_CHARS = 2_000;

// Where a batch's checks run: containers of its own, named for the batch (`search`) and a slot in its search for a
// failure. Each round of the search finds its container running with the batch fetched and its dependencies installed.
export interface Place {
	search: string;
	slot: number;
	slots: { next: number };
}

export function newPlace(): Place {
	return { search: crypto.randomUUID().slice(0, 12), slot: 0, slots: { next: 1 } };
}

// The name of the Gate container a place's checks run in.
export function gateName(place: Place): string {
	return `${place.search}-${place.slot}`;
}

export function batchChange(ready: Ready): BatchChange {
	return {
		change: ready.change,
		head: ready.head,
		ref: ready.ref,
		...(ready.source ? { source: ready.source } : {}),
		agent: ready.agent,
	};
}

// Checks `batch` on main and puts out each change found failing alone. Each part found passing goes to `found`.
export async function checkAndPutOut(
	input: MergeInput,
	landing: Landing,
	baseHead: string,
	batch: Ready[],
	holding: Holding,
	place: Place,
	found: (part: Ready[]) => void,
): Promise<Settled[]> {
	if (!input.runChecks) fail(500, "checks are configured but nothing can run them");
	await landing.checking({
		base: baseHead,
		since: new Date().toISOString(),
		changes: batch.map((ready) => ({ change: ready.change, head: ready.head, agent: ready.agent })),
	});
	const failed = await checkBatch(input, baseHead, batch, holding, place, found);
	await holding.step(STEP_MS.records);
	const settled: Settled[] = [];
	for (const { ready, results } of failed) settled.push(await putOut(input, ready, results));
	return settled;
}

// Checks `batch` on main in its `place`, passing each part that passes to `found`. A failing batch is split and its
// halves are checked side by side. A change failing alone is checked once more, then returned to be put out.
async function checkBatch(
	input: MergeInput,
	baseHead: string,
	batch: Ready[],
	holding: Holding,
	place: Place,
	found: (part: Ready[]) => void,
): Promise<{ ready: Ready; results: CheckResult[] }[]> {
	const commands = input.verify!;
	// A run is its commands plus an install and setup, each allowed as long as the Gate lets a command run.
	const run = async () => {
		await holding.step((commands.length + 2) * STEP_MS.checkCommand);
		return input.runChecks!({
			base: baseHead,
			branch: input.branch,
			changes: batch.map(batchChange),
			commands,
			gate: gateName(place),
		});
	};
	const first = await run();
	if (first.passed) {
		found(batch);
		return [];
	}
	const [only] = batch;
	if (only && batch.length === 1) {
		const again = await run();
		if (!again.passed) return [{ ready: only, results: again.results }];
		found(batch);
		return [];
	}
	const half = Math.ceil(batch.length / 2);
	// The first half stays in this container, where its changes just ran. The second takes another and keeps it.
	const second = { ...place, slot: place.slots.next++ };
	const [firstFailures, secondFailures] = await Promise.all([
		checkBatch(input, baseHead, batch.slice(0, half), holding, place, found),
		checkBatch(input, baseHead, batch.slice(half), holding, second, found),
	]);
	return [...firstFailures, ...secondFailures];
}

// Puts out a change whose checks failed alone on main. The checks' rejection of its head sends it back to its agent,
// and the failure is noted as an attempt, for its merge commit's story.
async function putOut(input: MergeInput, ready: Ready, results: CheckResult[]): Promise<Settled> {
	const failed = results.find((result) => result.exitCode !== 0);
	const conflict = failed?.command === BATCH_MERGE ? failed.output.split("\n")[0] : undefined;
	const reasons = [
		conflict || (failed ? `checks failed: ${failed.command} exited ${failed.exitCode}` : "checks failed"),
	];
	await input
		.noteAttempt?.(ready.change, reasons[0]!)
		.catch((err) => console.error(`noting ${ready.change}'s failed checks failed`, String(err)));
	const outputTail = failed?.output ? `:\n${failed.output.slice(-EVIDENCE_CHARS)}` : "";
	const evidence = `${reasons[0]} on ${ready.head.slice(0, 8)}, checked alone on the branch, twice${outputTail}`;
	const rejection = { commit: ready.head, reviewer: CHECKS_REVIEWER, role: "checks", verdict: "reject" } as const;
	await input.votes
		.vote({ ...rejection, evidence }, input.stamper)
		.catch((err) => console.error(`recording ${ready.change}'s failed checks failed`, String(err)));
	// The outcome keeps only the failed commands and the end of their output. The rejection has more.
	const checks = results
		.filter((result) => result.exitCode !== 0)
		.map((result) => ({ ...result, output: result.output.slice(-OUTCOME_OUTPUT_CHARS) }));
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
