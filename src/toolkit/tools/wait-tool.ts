import { sha256Hex } from "../../auth/digest";
import { fail, optionalString } from "../../errors";
import { backlogFor } from "../work";
import { openCall, type ToolCall, type ToolHandlers } from "./context";
import { reviewOptions } from "./work-tools";

// `wait`: the repo's doorbell for agents outside GitHive. It holds the call until something that concerns the caller
// changes: its own changes (a vote, a landing), the reviews it may give, the backlog free to it, or a notice left for
// it (a heads-up, interface news, a hint about its push), which the reply's news then carries. It reads what the
// caller would read itself, and only when the doorbell rings, so nothing is decided for the agent: it is woken, then
// looks and chooses as it always does.

/** The longest hold, and the default: well inside the 60 s that many MCP clients allow one call. */
export const LONGEST_WAIT_SECONDS = 45;

/**
 * What `seen` is made of, in order: one value per part (a digest, or for notices a time), so a reply can say which
 * part changed. `notices` is last, so a `seen` from before it was added still compares part by part.
 */
export const WAIT_PARTS = ["yours", "reviews", "backlog", "notices"] as const;

interface YourChange {
	change: string;
	head: string | null;
	approvals: number;
	rejections: number;
}

interface Look {
	seen: string;
	yours: YourChange[];
	reviews: number;
	backlog: number;
}

export const waitTools: ToolHandlers = {
	async wait(call) {
		const { args, ctx, repo, actAs } = call;
		const agent = actAs("agent");
		const doorbell = ctx.doorbell?.(repo) ?? fail(501, "wait needs the repo's doorbell, which this GitHive lacks");
		const until = Date.now() + holdSeconds(args.seconds) * 1000;
		const given = optionalString(args, "seen");
		const known = given?.split(".")[NOTICES] ?? "";
		// Read the count before looking, so a ring during the look still wakes the hold.
		let mark = await doorbell.rings();
		let looked = Date.now();
		let look = await lookFor(call, agent, known);
		let lookMs = Date.now() - looked;
		const before = given ?? look.seen;
		while (!changedParts(before, look.seen).length) {
			// The whole call keeps within `seconds`: the hold leaves room for one more look, as long as the last.
			const left = until - Date.now() - lookMs;
			const rung = left > 0 ? await doorbell.ringAfter(mark, left) : null;
			if (rung === null) break;
			mark = rung;
			looked = Date.now();
			// A fresh call, since one call reads the claims only once.
			look = await lookFor(await openCall(args, ctx, call.run), agent, known);
			lookMs = Date.now() - looked;
		}
		return answer(look, before);
	},
};

function holdSeconds(value: unknown) {
	if (value === undefined) return LONGEST_WAIT_SECONDS;
	const refused = `seconds is a whole number from 1 to ${LONGEST_WAIT_SECONDS}`;
	if (typeof value !== "number") fail(400, refused);
	if (!Number.isInteger(value)) fail(400, refused);
	if (value < 1) fail(400, refused);
	if (value > LONGEST_WAIT_SECONDS) fail(400, refused);
	return value;
}

const NOTICES = WAIT_PARTS.indexOf("notices");

// What concerns `agent` now, and a digest of it per part. `known` is the notices part of the `seen` the caller brought.
async function lookFor(call: Pick<ToolCall, "ctx" | "repo" | "openWork">, agent: string, known: string): Promise<Look> {
	const { ctx, repo, openWork } = call;
	const state = await openWork(agent);
	const heads = state.open.flatMap((entry) => (entry.head ? [entry.head] : []));
	const held = ctx.reviews ? await ctx.reviews.held(repo, heads).catch(() => ({})) : {};
	const reviews = await reviewOptions(ctx, repo, state, held);
	const free = backlogFor(state).open;
	// Nothing pushed has no votes.
	const votesOn = (head: string | null) => (head ? state.votes.filter((vote) => vote.commit === head) : []);
	const mine = state.open.filter((entry) => entry.claim.agent === agent);
	const yours = mine.map(({ claim, head }) => {
		const votes = votesOn(head);
		const approvals = votes.filter((vote) => vote.verdict === "approve").length;
		return { change: claim.change, head, approvals, rejections: votes.length - approvals };
	});
	const parts = [
		mine.map(({ claim, head }) => [
			claim.change,
			head,
			...votesOn(head).map((vote) => `${vote.reviewer} ${vote.role} ${vote.verdict}`),
		]),
		reviews.map((option) => [option.change, option.head, option.role]),
		free.map((item) => item.id),
	];
	const digests = await Promise.all(parts.map(digestOf));
	const notices = noticesPart(known, await ctx.doorbell?.(repo).newestNotice?.(agent));
	return { seen: [...digests, notices].join("."), yours, reviews: reviews.length, backlog: free.length };
}

/**
 * The newest notice time the caller has known of, in base 36 (a "." would split `seen`). It isn't a digest of the
 * notices waiting: a reply takes the notices it tells, so those would change the part with nothing new. It moves on
 * only when a notice newer than `known` comes.
 */
function noticesPart(known: string, newest: string | null | undefined) {
	const knownAt = parseInt(known, 36) || 0;
	const newestAt = newest ? Date.parse(newest) : 0;
	return Math.max(knownAt, newestAt).toString(36);
}

// The parts that differ. A part `before` doesn't have, from a `seen` made before the part was added, doesn't count.
function changedParts(before: string, now: string) {
	const was = before.split(".");
	const is = now.split(".");
	return WAIT_PARTS.filter((_, index) => index < was.length && was[index] !== is[index]);
}

// Sorted, so the order a list comes in (each agent's own) doesn't count as a change.
async function digestOf(part: unknown[]) {
	const lines = part.map((entry) => JSON.stringify(entry)).sort();
	return (await sha256Hex(lines.join("\n"))).slice(0, 12);
}

function answer(look: Look, before: string) {
	const what = changedParts(before, look.seen);
	return {
		changed: what.length > 0,
		...(what.length ? { what } : {}),
		yours: look.yours,
		reviews: look.reviews,
		backlog: look.backlog,
		seen: look.seen,
	};
}
