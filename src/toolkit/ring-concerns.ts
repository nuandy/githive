import { entriesOverlap } from "../claim-paths";
import type { ToolContext } from "./tools/context";
import { advice, recordLog, workRef } from "./tools/repo";
import type { Work, WorkItem } from "./work";

// Whom a tool's write concerns, so the repo's doorbell wakes only them (see RepoCache.ring). One that may offer work
// (backlog added, settings, a revert) `opens`, for any agent with room for it. A release opens only when it may free a
// backlog piece, the only work it can offer a waiting agent: otherwise every waiting agent would wake to read the repo
// and find nothing, which at hundreds of them is most of the repo's load. One that only takes work (a
// claim, a build) or asks a person concerns no agent waiting: what it changes for them is work gone, which they find
// when they next look. A merge concerns no one either, since its landing rings for itself. A vote concerns its
// change's agent, and its voter; a review given back offers it to others, and concerns the agent that held it. Those
// two name their caller because a hosted agent's reviewer calls them in its name, and the agent waits on them. One
// this can't place says nothing, which is about everything.

const NO_AGENT_WAITING = new Set(["claim", "build", "ask_human", "merge"]);
const OFFERS_WORK = new Set(["add_work", "settings", "revert"]);

/** Whom a tool's write concerns, or undefined when it can't be said. */
export async function concernsOf(
	name: string,
	args: Record<string, unknown>,
	ctx: ToolContext,
	reply?: unknown,
): Promise<{ for?: string[]; opens?: true } | undefined> {
	if (NO_AGENT_WAITING.has(name)) return { for: [] };
	if (name === "release") return releaseConcerns(args, ctx, reply);
	if (OFFERS_WORK.has(name)) return { opens: true };
	if (name === "leave_review") return { for: callerOf(args, "agent", ctx), opens: true };
	if (name !== "vote") return undefined;
	return voteConcerns(args, ctx);
}

const callerOf = (args: Record<string, unknown>, field: string, ctx: ToolContext) => {
	const named = typeof args[field] === "string" ? (args[field] as string) : ctx.agent;
	return named ? [named] : [];
};

async function voteConcerns(args: Record<string, unknown>, ctx: ToolContext) {
	const change = typeof args.change === "string" ? args.change : undefined;
	const repo = typeof args.repo === "string" ? args.repo : undefined;
	if (!change || !repo || !ctx.keptClaims) return undefined;
	const { claims } = await ctx.keptClaims(repo, () => advice(ctx, repo));
	const agent = claims.find((claim) => claim.change === change)?.agent;
	if (!agent) return undefined;
	return { for: [...new Set([agent, ...callerOf(args, "reviewer", ctx)])] };
}

/** What a release's reply says it freed (see the release tool). */
interface Freed {
	freed?: string[];
	merged?: boolean;
}

// A release frees a backlog piece that was its change, or that its paths held back, and once merged, a piece that
// waited on it. One that says nothing of what it freed (a stale claim's) opens, as before.
async function releaseConcerns(args: Record<string, unknown>, ctx: ToolContext, reply: unknown) {
	const { freed, merged } = (reply ?? {}) as Freed;
	const change = typeof args.change === "string" ? args.change : undefined;
	const repo = typeof args.repo === "string" ? args.repo : undefined;
	if (!freed || !change || !repo) return { opens: true as const };
	const work = (await recordLog<Work>(ctx, repo, workRef(repo)).read())?.commit.state.items ?? [];
	const heldBack = (item: WorkItem) =>
		(item.paths ?? []).some((path) => freed.some((held) => entriesOverlap(path, held)));
	const offered = (item: WorkItem) =>
		item.id === change || heldBack(item) || (!!merged && (item.after ?? []).includes(change));
	return work.some(offered) ? { opens: true as const } : { for: [] };
}
