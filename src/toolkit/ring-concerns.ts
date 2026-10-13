import type { ToolContext } from "./tools/context";
import { advice } from "./tools/repo";

// Whom a tool's write concerns, so the repo's doorbell wakes only their `wait` (see RepoCache.ring). A write that may
// offer work (a release, backlog added, settings, a review given back) concerns every agent, as does one this can't
// place. One that only takes work (a claim, a build) or asks a person concerns no agent waiting: what it changes for
// them is work gone, which they find when they next look. A vote concerns its change's agent.

const NO_AGENT_WAITING = new Set(["claim", "build", "ask_human"]);

/** The agents a tool's write concerns, or undefined for every agent. */
export async function concernsOf(
	name: string,
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<{ for: string[] } | undefined> {
	if (NO_AGENT_WAITING.has(name)) return { for: [] };
	if (name !== "vote") return undefined;
	const change = typeof args.change === "string" ? args.change : undefined;
	const repo = typeof args.repo === "string" ? args.repo : undefined;
	if (!change || !repo || !ctx.keptClaims) return undefined;
	const { claims } = await ctx.keptClaims(repo, () => advice(ctx, repo));
	const agent = claims.find((claim) => claim.change === change)?.agent;
	return agent ? { for: [agent] } : undefined;
}
