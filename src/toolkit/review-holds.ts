import type { CasLog } from "../record-log";
import type { ToolContext } from "./mcp";
import { appendRecord } from "./records";
import { recordsRepoOf } from "./shards";

// Review holds, a record in Git like the claims and votes, written by compare-and-swap. Once a repo has records
// repos the record lives in one of them, because every review handed out writes it and those writes kept the
// project repo too busy to accept landing batches.
//
// A hold says an agent is reviewing a commit in a role until it votes or the hold expires. A review is offered
// only while fewer agents hold it than it needs, so agents don't pile onto one. Holds bind nobody, and the audit
// ignores them.

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
) {
	const outcome = await appendRecord<ReviewHolds, "taken">(log, AUTHOR, empty, (state) => {
		const holds = live(state.holds, now());
		const others = Object.keys(holds[key] ?? {}).filter((holder) => holder !== agent);
		if (others.length >= needed) return { refused: "taken" };
		holds[key] = { ...holds[key], [agent]: new Date(now() + REVIEW_HOLD_MS).toISOString() };
		return { state: { ...state, holds }, text: `${agent} reviews ${key}` };
	});
	return outcome.ok;
}

/** Shortens a hold after its agent votes, so it lapses once the vote is visible everywhere. */
export async function releaseReview(log: CasLog<ReviewHolds>, key: string, agent: string, now = () => Date.now()) {
	await appendRecord<ReviewHolds, "none">(log, AUTHOR, empty, (state) => {
		const holds = live(state.holds, now());
		const until = holds[key]?.[agent];
		const soon = new Date(now() + VOTED_HOLD_MS).toISOString();
		if (!until || until <= soon) return { refused: "none" };
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

/** Review holds for the review tools (ToolContext.reviews), kept in each repo's record. */
export function reviewHolds(
	log: (repo: string) => CasLog<ReviewHolds> | Promise<CasLog<ReviewHolds>>,
): NonNullable<ToolContext["reviews"]> {
	return {
		held: async (repo) => heldReviews(await log(repo)),
		hold: async (repo, key, agent, needed) => holdReview(await log(repo), key, agent, needed),
		release: async (repo, key, agent) => releaseReview(await log(repo), key, agent),
		waits: async (repo, keys) => roleWaits(await log(repo), keys),
		told: async (repo, key) => roleWaitTold(await log(repo), key),
	};
}
