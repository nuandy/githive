import { sha256Hex } from "../../auth/digest";
import { fail, optionalString } from "../../errors";
import { backlogFor } from "../work";
import { openCall, type ToolCall, type ToolHandlers } from "./context";
import { reviewOptions } from "./work-tools";

// `wait`: the repo's doorbell for agents outside GitHive. It holds the call until something that concerns the caller
// changes: its own changes (a vote, a landing), the reviews it may give, or the backlog free to it. It reads what
// the caller would read itself, and only when the doorbell rings, so nothing is decided for the agent: it is woken,
// then looks and chooses as it always does.

/** The longest hold, and the default: well inside the 60 s that many MCP clients allow one call. */
export const LONGEST_WAIT_SECONDS = 45;

/** What `seen` is made of, in order: one digest per part, so a reply can say which part changed. */
export const WAIT_PARTS = ["yours", "reviews", "backlog"] as const;

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
		// Read the count before looking, so a ring during the look still wakes the hold.
		let mark = await doorbell.rings();
		let look = await lookFor(call, agent);
		const before = optionalString(args, "seen") ?? look.seen;
		while (look.seen === before) {
			const left = until - Date.now();
			const rung = left > 0 ? await doorbell.ringAfter(mark, left) : null;
			if (rung === null) break;
			mark = rung;
			// A fresh call, since one call reads the claims only once.
			look = await lookFor(await openCall(args, ctx, call.run), agent);
		}
		return answer(look, before);
	},
};

function holdSeconds(value: unknown) {
	if (value === undefined) return LONGEST_WAIT_SECONDS;
	const valid = typeof value === "number" && Number.isInteger(value) && value >= 1;
	if (!valid || value > LONGEST_WAIT_SECONDS) fail(400, `seconds is a whole number from 1 to ${LONGEST_WAIT_SECONDS}`);
	return value;
}

// What concerns `agent` now, and a digest of it per part.
async function lookFor(call: Pick<ToolCall, "ctx" | "repo" | "openWork">, agent: string): Promise<Look> {
	const { ctx, repo, openWork } = call;
	const state = await openWork(agent);
	const heads = state.open.flatMap((entry) => (entry.head ? [entry.head] : []));
	const held = ctx.reviews ? await ctx.reviews.held(repo, heads).catch(() => ({})) : {};
	const reviews = await reviewOptions(ctx, repo, state, held);
	const free = backlogFor(state).open;
	const votesOn = (head: string | null) => state.votes.filter((vote) => head && vote.commit === head);
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
	return { seen: digests.join("."), yours, reviews: reviews.length, backlog: free.length };
}

// Sorted, so the order a list comes in (each agent's own) doesn't count as a change.
async function digestOf(part: unknown[]) {
	const lines = part.map((entry) => JSON.stringify(entry)).sort();
	return (await sha256Hex(lines.join("\n"))).slice(0, 12);
}

function answer(look: Look, before: string) {
	const was = before.split(".");
	const now = look.seen.split(".");
	const what = WAIT_PARTS.filter((_, index) => was[index] !== now[index]);
	return {
		changed: what.length > 0,
		...(what.length ? { what } : {}),
		yours: look.yours,
		reviews: look.reviews,
		backlog: look.backlog,
		seen: look.seen,
	};
}
