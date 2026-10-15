import type { ClaimRecord } from "../claims";
import { isHiveAgent } from "../hive-agents";
import { type ChangeSigns, waitingOn } from "../staleness";
import { isPerson, latestVotes, ownerOf, type VoteRecord } from "../votes";
import { claimPolicy } from "./repo";
import type { HostedStatus, ToolCall } from "./context";

// Who can review a change other than its own agent. By default a person's agents review each other's changes, and a
// lone agent its own, in a fresh context. Where review must be independent, a change waiting for review that only a
// person can review goes to people's inbox: no agent of another person works in its repo, or none whose owner lets
// it review other people's changes, and none of GitHive's reviewers is on it. It's worked out from the records each
// time the dashboard reads them, so it leaves people's inbox once anyone can review it, or does.

/** Where a change stands, as the dashboard has already worked it out. */
export interface ReviewState {
	signs: ChangeSigns;
	approval: { approvals: number; required: number };
	hosted?: HostedStatus;
	trusted?: string;
	/** The change's policy asks for review independent of its author (see ReviewPolicy). */
	independent?: boolean;
}

/** An agent that works in the repo, and the identity it writes as when that's verified. */
export interface AgentAtWork {
	agent: string;
	by?: string;
}

/** How long an agent counts as at work after it last registered, gave up a claim or voted. */
export const AT_WORK_MS = 2 * 60 * 60_000;

type Dated = AgentAtWork & { at: string };

/**
 * The agents at work in the repo, once each: those holding a claim, and those that registered with a key, gave up a
 * claim or voted lately, since a signed-in agent and GitHive's own never register. One gone quiet long ago doesn't
 * count, or a person's old agent would be taken as reviewing their new one's changes for good.
 */
export function agentsAtWork(
	sources: {
		registered: Dated[];
		claims: AgentAtWork[];
		released: Dated[];
		votes: { reviewer: string; by?: string; at: string }[];
	},
	now = Date.now(),
): AgentAtWork[] {
	const lately = (record: { at: string }) => now - Date.parse(record.at) <= AT_WORK_MS;
	const voters = sources.votes
		.filter(lately)
		.map(({ reviewer, by }) => (by ? { agent: reviewer, by } : { agent: reviewer }));
	const registered = sources.registered.filter(lately);
	const released = sources.released.filter(lately);
	const everyone = new Map<string, AgentAtWork>();
	for (const record of [...sources.claims, ...registered, ...released, ...voters]) {
		if (isPerson(record.agent)) continue;
		const known = everyone.get(record.agent);
		if (!known?.by)
			everyone.set(record.agent, record.by ? { agent: record.agent, by: record.by } : { agent: record.agent });
	}
	return [...everyone.values()];
}

/**
 * The agents in the repo that belong to someone other than the change's author. GitHive's hive agents review each
 * other's changes and count; its other agents (a one-off builder, the GitHub importer) never review.
 */
export function otherPeoplesAgents(agents: AgentAtWork[], claim: ClaimRecord): string[] {
	const reviews = (record: AgentAtWork) => !record.agent.startsWith("githive") || isHiveAgent(record.agent);
	const author = ownerOf(claim.by);
	const othersOnly = (record: AgentAtWork) => {
		const owner = ownerOf(record.by);
		if (author && owner) return owner !== author;
		return record.agent !== claim.agent;
	};
	return agents
		.filter(reviews)
		.filter(othersOnly)
		.map((record) => record.agent);
}

/** The author's other agents among those at work: they review its change, rather than it approving its own. */
export function siblingsOf(agents: AgentAtWork[], claim: Pick<ClaimRecord, "agent" | "by">): string[] {
	// The same owner as otherPeoplesAgents counts: a person, or a service token and the agents registered under it.
	const author = ownerOf(claim.by);
	if (!author) return [];
	const sibling = (record: AgentAtWork) => record.agent !== claim.agent && ownerOf(record.by) === author;
	return agents.filter(sibling).map((record) => record.agent);
}

/** The agents at work in a repo as a tool call reads them: those registered, and those with claims held or given up. */
export async function agentsAtWorkIn(call: Pick<ToolCall, "store" | "registered">): Promise<AgentAtWork[]> {
	const held = await call.store.read();
	const registered = Object.values(call.registered?.agents ?? {});
	return agentsAtWork({ registered, claims: held.claims, released: held.released, votes: [] });
}

/**
 * Whether an agent other than the change's own may give it an approval that counts: GitHive's reviewer on it, one of
 * its owner's other agents (unless review must be independent), or another person's agent its owner lets review.
 */
export async function someoneElseCanReview(
	claim: ClaimRecord,
	state: Pick<ReviewState, "hosted" | "independent">,
	agents: AgentAtWork[],
	notReviewing: (agents: string[]) => Promise<Set<string>>,
): Promise<boolean> {
	const reviewerOnIt = state.hosted?.reviewers.some(({ status }) => status !== "done" && status !== "failed");
	if (reviewerOnIt) return true;
	if (!state.independent && siblingsOf(agents, claim).length) return true;
	const others = otherPeoplesAgents(agents, claim);
	if (!others.length) return false;
	const barred = await notReviewing(others);
	return others.some((agent) => !barred.has(agent));
}

/** Why only a person can review the change now, or null when it isn't waiting for review or someone else can. */
export async function onlyAPersonCanReview(
	claim: ClaimRecord,
	state: ReviewState,
	agents: AgentAtWork[],
	notReviewing: (agents: string[]) => Promise<Set<string>>,
): Promise<string | null> {
	if (state.trusted) return null;
	// Unless review must be independent, the change's own agent can review it in a fresh context.
	if (!state.independent) return null;
	if (waitingOn(state.signs).turn !== "reviewers") return null;
	if (state.approval.approvals >= state.approval.required) return null;
	const reviewerOnIt = state.hosted?.reviewers.some(({ status }) => status !== "done" && status !== "failed");
	if (reviewerOnIt) return null;
	const others = otherPeoplesAgents(agents, claim);
	if (!others.length) return "Waiting for review, and no other person's agent works here to review it";
	const barred = await notReviewing(others);
	if (others.some((agent) => !barred.has(agent))) return null;
	return "Waiting for review, and the other people's agents here aren't allowed to review it";
}

/** Where a change stands as `status` worked it out: what its agent needs to know to review it itself. */
interface StatusSeen {
	head: string | null;
	votes: Pick<VoteRecord, "commit" | "verdict" | "by" | "reviewer">[];
	approval: { approved: boolean; approvals: number; required: number };
	hosted?: HostedStatus;
}

/**
 * Whether the change's own agent is the one to review it: it waits for approvals nobody else may give, and its
 * policy lets the author's own approval count. Its agent then reviews it in a fresh context.
 */
export async function onlyItsAgentCanReview(
	call: Pick<ToolCall, "ctx" | "store" | "registered">,
	claim: ClaimRecord,
	seen: StatusSeen,
): Promise<boolean> {
	if (!seen.head || seen.approval.approved) return false;
	if (seen.approval.approvals >= seen.approval.required) return false;
	const onHead = latestVotes(seen.votes.filter((vote) => vote.commit === seen.head));
	if (onHead.some((vote) => vote.verdict === "reject")) return false;
	if (claimPolicy(call.registered, claim).independent) return false;
	const agents = await agentsAtWorkIn(call);
	const notReviewing = call.ctx.notReviewing ?? (async () => new Set<string>());
	return !(await someoneElseCanReview(claim, seen.hosted ? { hosted: seen.hosted } : {}, agents, notReviewing));
}
