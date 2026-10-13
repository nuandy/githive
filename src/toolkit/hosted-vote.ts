import type { Stamper } from "./stamp";
import type { ToolContext } from "./tools/context";
import { votesFor } from "./tools/repo";
import type { VoteStore } from "./vote-store";

// A hosted reviewer's vote, written to the votes directly and stamped as the reviewer rather than through the vote
// tool. So it rings the repo's doorbell itself, as the tool would (see ring-concerns.ts): for the change's agent, and
// for the voter, a hosted agent that waits on its own reviewer.

type Vote = Parameters<VoteStore["vote"]>[0];

/** Writes a hosted reviewer's vote on `author`'s change, and rings for both. */
export async function castHostedVote(ctx: ToolContext, repo: string, vote: Vote, author: string, stamper?: Stamper) {
	await votesFor(ctx, repo).vote(vote, stamper);
	const whom = { for: [...new Set([author, vote.reviewer])] };
	await ctx.ping?.(repo, undefined, "vote", whom).catch(() => undefined);
}
