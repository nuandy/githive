import { inLane } from "../open-mode";
import type { Registry } from "./claims";
import { approval, type ReviewPolicy, type Votes } from "./votes";

// The coordinator-free audit (see docs/coordinator-free.md). Nothing stops an
// agent from breaking a convention, so this replays the records and reports
// every violation, with the commit and the agent responsible. A pure function:
// anyone can run it over the same records and get the same answer.

/** A merge into main, as its commit records it. */
export interface MergeRecord {
	commit: string;
	author: string;
	/** From the merge's Blueprint-Change trailer. */
	change?: string;
	/** From its Blueprint-Claims trailer: the registry tip the merging agent checked. */
	claimsTip?: string;
	/** The change's commit that was reviewed and merged (the merge's second parent). */
	head?: string;
	/** From its Blueprint-Votes trailer: the votes tip the merging agent counted. */
	votesTip?: string;
	/** Files the merge changed. */
	files: string[];
}

export interface Violation {
	commit: string;
	author: string;
	rule: string;
	detail: string;
}

/** Claims idle longer than this may be released by anyone. */
export const STALE_AFTER_MS = 30 * 60_000;

export interface AuditRecords {
	/** The claims registry's history, oldest first. */
	registry: { tip: string; state: Registry }[];
	/** The votes' history, oldest first. */
	votes?: { tip: string; state: Votes }[];
	policy?: ReviewPolicy;
	merges: MergeRecord[];
	staleAfterMs?: number;
}

export function audit(records: AuditRecords): Violation[] {
	const violations: Violation[] = [];
	const registryAt = new Map(records.registry.map((r) => [r.tip, r.state]));
	const votesAt = new Map((records.votes ?? []).map((v) => [v.tip, v.state]));
	for (const merge of records.merges) {
		const report = (rule: string, detail: string) => violations.push({ commit: merge.commit, author: merge.author, rule, detail });
		if (!merge.change || !merge.claimsTip) {
			report("undeclared", "the merge names no change or claims it checked (Blueprint-Change, Blueprint-Claims)");
			continue;
		}
		const state = registryAt.get(merge.claimsTip);
		if (!state) {
			report("unknown-claims", `${merge.claimsTip} is not in the claims registry's history`);
			continue;
		}
		const own = state.claims.find((c) => c.change === merge.change);
		for (const file of merge.files) {
			const holder = state.claims.find((c) => c.change !== merge.change && inLane(file, c.paths));
			if (holder) report("inside-another-claim", `${file} was claimed by ${holder.change} (${holder.agent}) at ${merge.claimsTip}`);
			else if (!own || !inLane(file, own.paths)) report("outside-claim", `${file} was not in ${merge.change}'s claim at ${merge.claimsTip}`);
		}
		checkReleasedAfter(records, merge, report);
		checkApproved(records, votesAt, merge, report);
	}
	violations.push(...othersClaimsReleased(records));
	return violations;
}

/**
 * The claim a merge cites must still have been held when it merged: the first
 * registry state after the cited tip without the claim must be a release that
 * names this merge. Otherwise the agent merged after giving its claim up.
 */
function checkReleasedAfter(records: AuditRecords, merge: MergeRecord, report: (rule: string, detail: string) => void) {
	const from = records.registry.findIndex((r) => r.tip === merge.claimsTip);
	for (const later of records.registry.slice(from + 1)) {
		if (later.state.claims.some((c) => c.change === merge.change)) continue;
		const release = later.state.released.findLast((r) => r.change === merge.change);
		if (release?.mergedAs !== merge.commit) report("released-before-merge", `${merge.change}'s claim was released at ${later.tip} without naming ${merge.commit} as its merge`);
		return;
	}
}

/** The merged commit must have had the policy's approvals, and no veto, at the votes tip the merge cites. */
function checkApproved(records: AuditRecords, votesAt: Map<string, Votes>, merge: MergeRecord, report: (rule: string, detail: string) => void) {
	if (!records.policy) return;
	if (!merge.head || !merge.votesTip) return report("undeclared", "the merge names no reviewed commit or votes it counted (Blueprint-Votes)");
	const votes = votesAt.get(merge.votesTip);
	if (!votes) return report("unknown-votes", `${merge.votesTip} is not in the votes' history`);
	const outcome = approval(votes, merge.head, records.policy);
	if (outcome.vetoedBy.length) report("unapproved", `${merge.head} was vetoed by ${outcome.vetoedBy.join(", ")} at ${merge.votesTip}`);
	else if (!outcome.approved) report("unapproved", `${merge.head} had ${outcome.approvals} of ${records.policy.required} approvals at ${merge.votesTip}`);
}

/** Releases of another agent's claim that wasn't stale yet. */
function othersClaimsReleased(records: AuditRecords): Violation[] {
	const staleAfter = records.staleAfterMs ?? STALE_AFTER_MS;
	const violations: Violation[] = [];
	let seen = 0;
	for (const entry of records.registry) {
		for (const release of entry.state.released.slice(seen)) {
			if (release.by === release.agent) continue;
			const idle = Date.parse(release.at) - Date.parse(release.lastActive);
			if (idle <= staleAfter)
				violations.push({ commit: entry.tip, author: release.by, rule: "released-others-claim", detail: `${release.by} released ${release.change} (${release.agent}), active ${Math.round(idle / 60_000)} minutes before, not stale` });
		}
		seen = entry.state.released.length;
	}
	return violations;
}
