import type { ClaimRecord } from "../claims";
import { isHiveAgent } from "../hive-agents";
import { type ChangeSigns, waitingOn } from "../staleness";
import { isPerson, personOf } from "../votes";
import type { HostedStatus } from "./context";

// A change waiting for review that only a person can review: no agent of another person works in its repo, or none
// whose owner lets it review other people's changes, and none of GitHive's reviewers is on it. It's worked out from
// the records each time the dashboard reads them, so it leaves people's inbox once anyone can review it, or does.

/** Where a change stands, as the dashboard has already worked it out. */
export interface ReviewState {
	signs: ChangeSigns;
	approval: { approvals: number; required: number };
	hosted?: HostedStatus;
	trusted?: string;
}

/** An agent that works in the repo, and the identity it writes as when that's verified. */
export interface AgentAtWork {
	agent: string;
	by?: string;
}

/**
 * The agents that work in the repo, once each: those registered with a key, and those whose claims, releases and
 * votes are in its records, since a signed-in agent and GitHive's own never register.
 */
export function agentsAtWork(sources: {
	registered: AgentAtWork[];
	claims: AgentAtWork[];
	released: AgentAtWork[];
	votes: { reviewer: string; by?: string }[];
}): AgentAtWork[] {
	const voters = sources.votes.map(({ reviewer, by }) => (by ? { agent: reviewer, by } : { agent: reviewer }));
	const everyone = new Map<string, AgentAtWork>();
	for (const record of [...sources.registered, ...sources.claims, ...sources.released, ...voters]) {
		if (isPerson(record.agent)) continue;
		const known = everyone.get(record.agent);
		if (!known?.by) everyone.set(record.agent, record.by ? { agent: record.agent, by: record.by } : record);
	}
	return [...everyone.values()];
}

/**
 * The agents in the repo that belong to someone other than the change's author. GitHive's hive agents review each
 * other's changes and count; its other agents (a one-off builder, the GitHub importer) never review.
 */
export function otherPeoplesAgents(agents: AgentAtWork[], claim: ClaimRecord): string[] {
	const reviews = (record: AgentAtWork) => !record.agent.startsWith("githive") || isHiveAgent(record.agent);
	const author = personOf(claim.by);
	const othersOnly = (record: AgentAtWork) => {
		const person = personOf(record.by);
		if (author && person) return person !== author;
		return record.agent !== claim.agent;
	};
	return agents
		.filter(reviews)
		.filter(othersOnly)
		.map((record) => record.agent);
}

/** Why only a person can review the change now, or null when it isn't waiting for review or someone else can. */
export async function onlyAPersonCanReview(
	claim: ClaimRecord,
	state: ReviewState,
	agents: AgentAtWork[],
	notReviewing: (agents: string[]) => Promise<Set<string>>,
): Promise<string | null> {
	if (state.trusted) return null;
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
