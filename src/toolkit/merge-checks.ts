import { changeAgainst, type ReadHistory, type TouchedBy, touchedSince } from "./batch-reads";
import { CONFLICT_FILES_NAMED, CONFLICT_ON, conflictLine, type Landing, type Settled } from "./landing";
import { type Holding, STEP_MS } from "./merge-lease";
import { type FailureHint, failureHints } from "./failure-hints";
import type { BatchChange, CheckResult, Conflict, MergeInput, Ready } from "./merge-types";
import { fail } from "../errors";

/** The reviewer failed checks are recorded as. Its rejection of the failing head sends the change back to its agent. */
export const CHECKS_REVIEWER = "githive-checks";
/**
 * The check a batch that doesn't merge onto main fails, as the Gate's runner reports it (see env.ts). Its output is
 * the conflict in one line: its files and who changed them.
 */
export const BATCH_MERGE = "(merging the batch onto main)";
// How much of a failed check's output is kept in its outcome, and of the whole rejection (its reason, then the end of
// the output). A reason is cut first, so a conflict on many files can't crowd the output out.
const OUTCOME_OUTPUT_CHARS = 1_000;
const EVIDENCE_CHARS = 2_000;
const REASON_CHARS = 1_000;
/** The most conflicted files an outcome keeps, since the branch's recent outcomes are kept together. */
const CONFLICTS_KEPT = 50;
/** How a change failing its checks was found, as its rejection tells it. */
const CHECKED_ALONE = "checked alone on the branch, twice";

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
	// Clef is asked about the first failure while the search goes on, so the search never waits on it.
	let hinting: Promise<FailureHint> | undefined;
	const firstFailed = (results: CheckResult[]) => {
		if (input.clef) hinting = askAboutFailure(input, batch, results);
	};
	const failed = await checkBatch(input, baseHead, batch, holding, place, found, firstFailed);
	const hint = hinting ? await hinting : {};
	if (hint.suspect) noteSuspect(input, batch, hint.suspect, failed);
	await holding.step(STEP_MS.records);
	const settled: Settled[] = [];
	for (const { ready, failure } of failed) settled.push(await putOut(input, ready, failure, CHECKED_ALONE, hint));
	return settled;
}

function askAboutFailure(input: MergeInput, batch: Ready[], results: CheckResult[]) {
	const changes = batch.map((ready) => ({ change: ready.change, intent: ready.own.intent, files: ready.files }));
	const merging = (result: CheckResult) => result.command === BATCH_MERGE;
	return failureHints(input.clef!, changes, results, merging).catch((err) => {
		console.error(`asking Clef about ${input.branch}'s failed batch failed`, String(err));
		return {};
	});
}

// Logged so that how often Clef's suspect is the change put out can be counted from the logs, as well as from the
// outcomes that keep it.
function noteSuspect(
	input: MergeInput,
	batch: Ready[],
	suspect: NonNullable<FailureHint["suspect"]>,
	failed: { ready: Ready }[],
) {
	const putOutChanges = failed.map(({ ready }) => ready.change);
	const right = putOutChanges.includes(suspect.change);
	console.log(
		`clef suspect on ${input.branch}: ${suspect.change} (${suspect.likelihood}) of ${batch.length}; ` +
			`put out ${putOutChanges.join(", ") || "none"}; ${right ? "right" : "wrong"}`,
	);
}

/** Why a change is put out: its checks' results, and what it doesn't merge on when that's why. */
export interface Failure {
	results: CheckResult[];
	conflict?: Conflict;
}

// Checks `batch` on main in its `place`, passing each part that passes to `found`. A failing batch is split and its
// halves are checked side by side. A change failing alone is checked once more, then returned to be put out.
// `firstFailed` hears the results of the batch's own first run if it fails, not its parts'.
async function checkBatch(
	input: MergeInput,
	baseHead: string,
	batch: Ready[],
	holding: Holding,
	place: Place,
	found: (part: Ready[]) => void,
	firstFailed?: (results: CheckResult[]) => void,
): Promise<{ ready: Ready; failure: Failure }[]> {
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
	if (first.setupFailed) return unchecked(batch, first.results);
	firstFailed?.(first.results);
	const [only] = batch;
	if (only && batch.length === 1) {
		const again = await run();
		if (again.setupFailed) return unchecked(batch, again.results);
		if (!again.passed) {
			const conflict = again.conflict ? { conflict: again.conflict } : {};
			return [{ ready: only, failure: { results: again.results, ...conflict } }];
		}
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

// Checks that couldn't run say nothing of the changes, so none is put out: they wait for the next batch.
function unchecked(batch: Ready[], results: CheckResult[]): [] {
	const why = results[0]?.output.split("\n")[0] ?? "";
	console.error(`checks for ${batch.map((ready) => ready.change).join(", ")} couldn't run: ${why}`);
	return [];
}

/**
 * Puts out a change that failed alone on main: its checks failed, or it doesn't merge onto the branch, as the checks
 * or the landing found (`how` says which, for its rejection). The rejection of its head sends it back to its agent,
 * and keeps it out of later batches until it has a new commit. The failure is noted as an attempt, for its merge
 * commit's story. A conflict is told with what the checks or the landing said of it: nothing more is read under the
 * lease, since the change's `status` or `merge` names who changed its files from a test merge of its own.
 */
export async function putOut(
	input: MergeInput,
	ready: Ready,
	failure: Failure,
	how: string,
	hint: FailureHint = {},
): Promise<Settled> {
	const { results } = failure;
	const failed = results.find((result) => result.exitCode !== 0);
	const { conflict } = failure;
	// A runner without `conflict` still tells one as its failed step, whose output is the conflict in one line.
	const told = failed?.command === BATCH_MERGE ? failed.output.split("\n")[0] : undefined;
	const reason =
		(conflict && conflictLine(conflict.files, conflict.touchedBy ?? [])) ||
		told ||
		(failed ? `checks failed: ${failed.command} exited ${failed.exitCode}` : "checks failed");
	const reasons = [cut(reason, REASON_CHARS)];
	await input
		.noteAttempt?.(ready.change, reasons[0]!)
		.catch((err) => console.error(`noting ${ready.change}'s failed checks failed`, String(err)));
	const said = `${reasons[0]} on ${ready.head.slice(0, 8)}, ${how}`;
	// A conflict's failed step is the conflict in one line again, which the reason already says.
	const output = failed?.command === BATCH_MERGE ? "" : (failed?.output ?? "");
	// What room the reason leaves of EVIDENCE_CHARS, for the end of the output (slice(-0) would keep all of it).
	const room = EVIDENCE_CHARS - said.length - 2;
	const outputTail = output && room > 0 ? `:\n${output.slice(-room)}` : "";
	const evidence = `${said}${outputTail}`;
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
		...(results.length || !conflict ? { checks } : {}),
		...(conflict ? kept(conflict) : {}),
		...(hint.environment !== undefined ? { environment: hint.environment } : {}),
		...(hint.suspect ? { suspect: hint.suspect } : {}),
	};
}

/** `text` cut to `most` characters, marked where it was cut. */
const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most - 1)}…` : text);

// A conflict as an outcome keeps it: some of its files, and the newest change to each of the few its words name (the
// branch's recent outcomes are kept together in one value).
function kept(conflict: Conflict): Pick<Settled, "conflicts" | "touchedBy"> {
	const named = new Set(conflict.files.slice(0, CONFLICT_FILES_NAMED));
	const touchedBy = (conflict.touchedBy ?? []).filter(
		(touched, index, all) => named.has(touched.file) && all.findIndex((other) => other.file === touched.file) === index,
	);
	return { conflicts: conflict.files.slice(0, CONFLICTS_KEPT), ...(touchedBy.length ? { touchedBy } : {}) };
}

/** How long naming who changed a conflicted file may take while landing, where it's advice that mustn't hold it up. */
export const NAMING_MS = 10_000;

/**
 * Who changed `files` on the branch since `change` left it, for a conflict found while landing, read Worker-side
 * through Artifacts' API. That's advice: caught, logged and bounded by NAMING_MS, and without it nobody is named.
 */
export async function touchedWhileLanding(
	history: ReadHistory,
	project: string,
	at: { branch: string; main: string; files: string[] },
	change: { change: string; ref: string; source?: { url: string } },
	waitMs = NAMING_MS,
): Promise<TouchedBy[]> {
	const naming = (async () => {
		const placed = await changeAgainst(history, project, at.branch, at.main, change);
		if (!placed || "error" in placed) return [];
		return touchedSince(history, project, at.branch, at.main, placed.base, at.files);
	})().catch((err) => {
		console.error(`reading who changed ${change.change}'s conflicted files failed`, String(err));
		return [] as TouchedBy[];
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<TouchedBy[]>((resolve) => (timer = setTimeout(() => resolve([]), waitMs)));
	try {
		return await Promise.race([naming, late]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * What a rejection by the checks says, read back from its evidence as putOut writes it: that the head doesn't merge
 * onto the branch, or that its checks failed, with the failed command, its exit code and the end of its output when
 * it names them.
 */
export function rejectedFor(evidence: string): { why: "conflict" } | { why: "checks"; check?: CheckResult } {
	const [first = "", ...rest] = evidence.split("\n");
	if (first.startsWith(CONFLICT_ON)) return { why: "conflict" };
	const named = /^checks failed: (.+?) exited (-?\d+) on [0-9a-f]+, /.exec(first);
	if (!named) return { why: "checks" };
	// A rejection written before conflicts had words of their own failed the batch's merge as a check.
	if (named[1] === BATCH_MERGE) return { why: "conflict" };
	const output = rest.join("\n").slice(-OUTCOME_OUTPUT_CHARS);
	return { why: "checks", check: { command: named[1]!, exitCode: Number(named[2]), output } };
}
