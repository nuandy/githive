import type { AgentRecord, ClaimRecord } from "../claims";
import { type ChangeSigns, waitingOn } from "../staleness";
import { personOf } from "../votes";
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

/** The agents in the repo, other than GitHive's own, that belong to someone other than the change's author. */
export function otherPeoplesAgents(agents: AgentRecord[], claim: ClaimRecord): string[] {
	const author = personOf(claim.by);
	const othersOnly = (record: AgentRecord) => {
		const person = personOf(record.by);
		if (author && person) return person !== author;
		return record.agent !== claim.agent;
	};
	return agents
		.filter((record) => !record.agent.startsWith("githive"))
		.filter(othersOnly)
		.map((record) => record.agent);
}

/** Why only a person can review the change now, or null when it isn't waiting for review or someone else can. */
export async function onlyAPersonCanReview(
	claim: ClaimRecord,
	state: ReviewState,
	agents: AgentRecord[],
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
