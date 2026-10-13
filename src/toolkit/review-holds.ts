import type { CasLog } from "../record-log";
import type { ToolContext } from "./mcp";
import { appendRecord } from "./records";
import { recordsRepoOf } from "./shards";
import { bucketOf } from "./vote-store";

// Review holds, a record in Git like the claims and votes, written by compare-and-swap. Once a repo has records
// repos the record lives in one of them, because every review handed out writes it and those writes kept the
// project repo too busy to accept landing batches.
//
// A hold says an agent is reviewing a commit in a role until it votes or the hold expires. A review is offered
// only while fewer agents hold it than it needs, and credentials refuses to hand it to more, so agents don't pile
// onto one. A vote counts with or without a hold, and the audit ignores them.
//
// Every review handed out writes a hold and every vote shortens one, so the holds are split by commit into
// buckets, each its own ref: in one record, agents taking different reviews retried each other's writes for
// seconds, and others were offered the review meanwhile. Waits on blocking roles are written rarely and stay in
// the repo's one reviews record.

/** How long a review hold lasts if its agent never votes. */
export const REVIEW_HOLD_MS = 15 * 60_000;
/**
 * How long a hold lasts after its agent votes. A new vote can take a moment to appear in every read, and until
 * then the change would look unreviewed to the next agent asking.
 */
export const VOTED_HOLD_MS = 60_000;

export interface ReviewHolds {
	/** By holdKey (commit#role): each reviewing agent and when its hold expires. */
	holds: Record<string, Record<string, string>>;
	/** Reviews awaited by a role that can block, by holdKey: since when, and whether people were told. */
	waits: Record<string, { since: string; told?: boolean }>;
}

const AUTHOR = "githive";
const empty = (): ReviewHolds => ({ holds: {}, waits: {} });

/** The ref for a repo's review holds, in the project repo or the records repo reviewsRepoOf picks. */
export const reviewsRef = (repo: string) => `refs/notes/githive-reviews/${repo}`;

export const reviewsRepoOf = (count: number) => recordsRepoOf("reviews", count);

/** How many buckets the holds are split into, by the commit under review. */
export const HOLD_BUCKETS = 16;

/** Where one bucket of a repo's holds is kept. */
export const holdsRef = (repo: string, bucket: string) => `refs/notes/githive-review-holds/${repo}/${bucket}`;

/** Which of a repo's `count` records repos holds a bucket of its holds. */
export const holdsRepoOf = (bucket: string, count: number) => recordsRepoOf(`holds:${bucket}`, count);

/** The bucket a hold's key (commit#role) is kept in. */
const holdBucketOf = (key: string) => bucketOf(key.split("#")[0] ?? key, HOLD_BUCKETS);

// Drops expired holds.
function live(holds: ReviewHolds["holds"], now: number): ReviewHolds["holds"] {
	const kept: ReviewHolds["holds"] = {};
	for (const [key, agents] of Object.entries(holds)) {
		const still = Object.entries(agents).filter(([, until]) => Date.parse(until) > now);
		if (still.length) kept[key] = Object.fromEntries(still);
	}
	return kept;
}

/** The agents holding each review, by holdKey. */
export async function heldReviews(log: CasLog<ReviewHolds>, now = Date.now()): Promise<Record<string, string[]>> {
	const holds = live((await log.read())?.commit.state.holds ?? {}, now);
	return Object.fromEntries(Object.entries(holds).map(([key, agents]) => [key, Object.keys(agents)]));
}

/**
 * Holds review `key` for `agent` if fewer than `needed` others hold it. Compare-and-swap keeps two agents
 * asking at once from both taking the last place.
 */
export async function holdReview(
	log: CasLog<ReviewHolds>,
	key: string,
	agent: string,
	needed: number,
	now = () => Date.now(),
	elsewhere: string[] = [],
) {
	const outcome = await appendRecord<ReviewHolds, "taken">(log, AUTHOR, empty, (state) => {
		const holds = live(state.holds, now());
		// Holders in where the holds were kept before (see ReviewLogs.earlier) count too.
		const holders = new Set([...Object.keys(holds[key] ?? {}), ...elsewhere]);
		const others = [...holders].filter((holder) => holder !== agent);
		if (others.length >= needed) return { refused: "taken" };
		holds[key] = { ...holds[key], [agent]: new Date(now() + REVIEW_HOLD_MS).toISOString() };
		return { state: { ...state, holds }, text: `${agent} reviews ${key}` };
	});
	return outcome.ok;
}

/**
 * Shortens a hold after its agent votes, so it lapses once the vote is visible everywhere; or, when the agent gave
 * the review up (`gaveUp`), drops it at once, so another agent can take the review.
 */
export async function releaseReview(
	log: CasLog<ReviewHolds>,
	key: string,
	agent: string,
	{ now = () => Date.now(), gaveUp = false }: { now?: () => number; gaveUp?: boolean } = {},
) {
	await appendRecord<ReviewHolds, "none">(log, AUTHOR, empty, (state) => {
		const holds = live(state.holds, now());
		const until = holds[key]?.[agent];
		if (!until) return { refused: "none" };
		if (gaveUp) {
			const { [agent]: _, ...others } = holds[key]!;
			if (Object.keys(others).length) holds[key] = others;
			else delete holds[key];
			return { state: { ...state, holds }, text: `${agent} gave up the review of ${key}` };
		}
		const soon = new Date(now() + VOTED_HOLD_MS).toISOString();
		if (until <= soon) return { refused: "none" };
		holds[key] = { ...holds[key], [agent]: soon };
		return { state: { ...state, holds }, text: `${agent} voted on ${key}` };
	});
}

/**
 * When each review in `waiting` was first seen waiting on a role that can block, and whether people were told.
 * Reviews no longer waiting are dropped, so one that waits again starts over.
 */
export async function roleWaits(
	log: CasLog<ReviewHolds>,
	waiting: string[],
	now = () => Date.now(),
): Promise<Record<string, { since: number; told?: boolean }>> {
	let current: ReviewHolds["waits"] = {};
	await appendRecord<ReviewHolds, "unchanged">(log, AUTHOR, empty, (state) => {
		const at = new Date(now()).toISOString();
		current = Object.fromEntries(waiting.map((key) => [key, state.waits[key] ?? { since: at }]));
		if (JSON.stringify(Object.keys(current).sort()) === JSON.stringify(Object.keys(state.waits).sort()))
			return { refused: "unchanged" };
		return {
			state: { holds: live(state.holds, now()), waits: current },
			text: `${waiting.length} review(s) a role that can block awaits`,
		};
	});
	return Object.fromEntries(
		Object.entries(current).map(([key, wait]) => [
			key,
			{ since: Date.parse(wait.since), ...(wait.told ? { told: true } : {}) },
		]),
	);
}

/** Marks a waiting review as reported, so people are told only once. */
export async function roleWaitTold(log: CasLog<ReviewHolds>, key: string) {
	await appendRecord<ReviewHolds, "none">(log, AUTHOR, empty, (state) => {
		if (!state.waits[key] || state.waits[key].told) return { refused: "none" };
		return {
			state: { ...state, waits: { ...state.waits, [key]: { ...state.waits[key], told: true } } },
			text: `people were told ${key} awaits its review`,
		};
	});
}

type HoldsLog = CasLog<ReviewHolds> | Promise<CasLog<ReviewHolds>>;

/** Where a repo's review records are: its one reviews record (the waits), and each bucket of its holds. */
export interface ReviewLogs {
	waits(repo: string): HoldsLog;
	holds(repo: string, bucket: string): HoldsLog;
	/**
	 * Where a bucket's holds were kept before the repo spread its records, while a hold placed there may still be
	 * live; null otherwise. Holds there are read and released alongside, so a review taken just before the switch
	 * isn't handed out again after it.
	 */
	earlier?(repo: string, bucket: string): Promise<CasLog<ReviewHolds> | null>;
}

// Holds read from two places, each review's holders from both.
function joinHeld(now: Record<string, string[]>, before: Record<string, string[]>) {
	const joined = { ...now };
	for (const [key, agents] of Object.entries(before)) joined[key] = [...new Set([...(joined[key] ?? []), ...agents])];
	return joined;
}

/** Review holds for the review tools (ToolContext.reviews). */
export function reviewHolds(logs: ReviewLogs): NonNullable<ToolContext["reviews"]> {
	const holdsFor = (repo: string, key: string) => logs.holds(repo, holdBucketOf(key));
	const earlierFor = async (repo: string, key: string) => (await logs.earlier?.(repo, holdBucketOf(key))) ?? null;
	// A bucket's holds, with those still live where they were kept before.
	const heldIn = async (repo: string, bucket: string) => {
		const [log, earlier] = await Promise.all([logs.holds(repo, bucket), logs.earlier?.(repo, bucket) ?? null]);
		const [now, before] = await Promise.all([heldReviews(await log), earlier ? heldReviews(earlier) : {}]);
		return joinHeld(now, before);
	};
	return {
		// The holds on these heads (every bucket when none are named), read bucket by bucket.
		held: async (repo, heads) => {
			const every = Array.from({ length: HOLD_BUCKETS }, (_, bucket) => String(bucket));
			const buckets = heads ? [...new Set(heads.map((head) => bucketOf(head, HOLD_BUCKETS)))] : every;
			const read = await Promise.all(buckets.map((bucket) => heldIn(repo, bucket)));
			return Object.assign({}, ...read);
		},
		hold: async (repo, key, agent, needed) => {
			const earlier = await earlierFor(repo, key);
			const elsewhere = earlier ? ((await heldReviews(earlier))[key] ?? []) : [];
			return holdReview(await holdsFor(repo, key), key, agent, needed, undefined, elsewhere);
		},
		release: async (repo, key, agent, gaveUp) => {
			const earlier = await earlierFor(repo, key);
			if (earlier) await releaseReview(earlier, key, agent, { gaveUp }).catch(() => undefined);
			await releaseReview(await holdsFor(repo, key), key, agent, { gaveUp });
		},
		waits: async (repo, keys) => roleWaits(await logs.waits(repo), keys),
		told: async (repo, key) => roleWaitTold(await logs.waits(repo), key),
	};
}
