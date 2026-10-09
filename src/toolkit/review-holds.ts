import type { CasLog } from "../record-log";
import type { ToolContext } from "./mcp";
import { appendRecord } from "./records";
import { recordsRepoOf } from "./shards";

// Review holds, kept as a record in Git like the claims and votes, written by
// compare-and-swap by whichever agent's next is acting. Nobody runs them.
// Once a repo has records repos, the record is in one of them (see
// reviewsRepoOf), not the project repo: every review handed out writes it, and
// at 200 agents those writes kept the project repo busy, which refused the
// batches landing on its branch.
//
// A hold says an agent is reviewing a commit in a role (keyed as work.ts
// holdKey), until it votes or the hold runs out: next hands a review out only
// while fewer agents hold it than it needs, so two agents aren't sent to one
// review that needs one. A hold binds nobody: a review is valid with or
// without one, and the audit never reads them.
//
// Beside the holds: reviews a role that can block has awaited, and when each
// was first seen waiting, so people hear of one that waited too long, once.

/** How long a review hold lasts if its agent never votes. */
export const REVIEW_HOLD_MS = 15 * 60_000;
/**
 * How long a hold lasts once its agent voted: a vote just written can take a
 * moment to show in every read of the votes, and until it does, the change
 * would look unreviewed (and unheld) to the next agent asking.
 */
export const VOTED_HOLD_MS = 60_000;

export interface ReviewHolds {
	/** By holdKey (commit#role): the agents reviewing it, each until when. */
	holds: Record<string, Record<string, string>>;
	/** Reviews a role that can block awaits, by holdKey: since when, and whether people were told. */
	waits: Record<string, { since: string; told?: boolean }>;
}

const AUTHOR = "githive";
const empty = (): ReviewHolds => ({ holds: {}, waits: {} });

/** Where a repo's review holds are kept: this ref, in the project repo or the records repo reviewsRepoOf picks. */
export const reviewsRef = (repo: string) => `refs/notes/githive-reviews/${repo}`;

/** Which of a repo's `count` records repos holds its review holds (the same one always, for that count). */
export const reviewsRepoOf = (count: number) => recordsRepoOf("reviews", count);

/** The holds that haven't run out. */
function live(holds: ReviewHolds["holds"], now: number): ReviewHolds["holds"] {
	const kept: ReviewHolds["holds"] = {};
	for (const [key, agents] of Object.entries(holds)) {
		const still = Object.entries(agents).filter(([, until]) => Date.parse(until) > now);
		if (still.length) kept[key] = Object.fromEntries(still);
	}
	return kept;
}

/** The review holds in force: by holdKey, the agents reviewing it. */
export async function heldReviews(log: CasLog<ReviewHolds>, now = Date.now()): Promise<Record<string, string[]>> {
	const holds = live((await log.read())?.commit.state.holds ?? {}, now);
	return Object.fromEntries(Object.entries(holds).map(([key, agents]) => [key, Object.keys(agents)]));
}

/**
 * Hold the review `key` for `agent`, if fewer than `needed` others hold it.
 * Compare-and-swap: two agents asking at once can't both take the last one.
 */
export async function holdReview(log: CasLog<ReviewHolds>, key: string, agent: string, needed: number, now = () => Date.now()) {
	const outcome = await appendRecord<ReviewHolds, "taken">(log, AUTHOR, empty, (state) => {
		const holds = live(state.holds, now());
		const others = Object.keys(holds[key] ?? {}).filter((a) => a !== agent);
		if (others.length >= needed) return { refused: "taken" };
		holds[key] = { ...holds[key], [agent]: new Date(now() + REVIEW_HOLD_MS).toISOString() };
		return { state: { ...state, holds }, text: `${agent} reviews ${key}` };
	});
	return outcome.ok;
}

/** The agent voted on `key`: its hold goes once the vote has had a moment to show everywhere. */
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
 * When each of `waiting` (reviews a role that can block awaits, by holdKey)
 * was first seen waiting, and whether people were told. Reviews no longer
 * waiting are forgotten, so a review that waits again starts over. Written
 * only when the set of waiting reviews changed.
 */
export async function roleWaits(log: CasLog<ReviewHolds>, waiting: string[], now = () => Date.now()): Promise<Record<string, { since: number; told?: boolean }>> {
	let current: ReviewHolds["waits"] = {};
	await appendRecord<ReviewHolds, "unchanged">(log, AUTHOR, empty, (state) => {
		const at = new Date(now()).toISOString();
		current = Object.fromEntries(waiting.map((key) => [key, state.waits[key] ?? { since: at }]));
		if (JSON.stringify(Object.keys(current).sort()) === JSON.stringify(Object.keys(state.waits).sort())) return { refused: "unchanged" };
		return { state: { holds: live(state.holds, now()), waits: current }, text: `${waiting.length} review(s) a role that can block awaits` };
	});
	return Object.fromEntries(Object.entries(current).map(([key, w]) => [key, { since: Date.parse(w.since), ...(w.told ? { told: true } : {}) }]));
}

/** People were told about a waiting review: once is enough. */
export async function roleWaitTold(log: CasLog<ReviewHolds>, key: string) {
	await appendRecord<ReviewHolds, "none">(log, AUTHOR, empty, (state) => {
		if (!state.waits[key] || state.waits[key].told) return { refused: "none" };
		return { state: { ...state, waits: { ...state.waits, [key]: { ...state.waits[key], told: true } } }, text: `people were told ${key} awaits its review` };
	});
}

/** The review holds as next and vote use them (ToolContext.reviews), kept in the repo's record (`log`: wherever it is). */
export function reviewHolds(log: (repo: string) => CasLog<ReviewHolds> | Promise<CasLog<ReviewHolds>>): NonNullable<ToolContext["reviews"]> {
	return {
		held: async (repo) => heldReviews(await log(repo)),
		hold: async (repo, key, agent, needed) => holdReview(await log(repo), key, agent, needed),
		release: async (repo, key, agent) => releaseReview(await log(repo), key, agent),
		waits: async (repo, keys) => roleWaits(await log(repo), keys),
		told: async (repo, key) => roleWaitTold(await log(repo), key),
	};
}
