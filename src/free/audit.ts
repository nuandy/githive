import { inLane } from "../open-mode";
import type { Registry } from "./claims";
import { stampPayload, verifyStamp } from "./stamp";
import { approval, type ReviewPolicy, type VoteRecord, type Votes } from "./votes";

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
	/** Main before the merge (its first parent). */
	base?: string;
	/** From its Blueprint-Tested trailer: the main the checks passed on. */
	testedOn?: string;
	/** From its Blueprint-By and Blueprint-Stamp trailers: who asked the toolkit to merge, as Access verified them, and Blueprint's stamp. */
	by?: string;
	stamp?: string;
	/** Files the merge changed. */
	files: string[];
}

export interface Violation {
	commit: string;
	/** The agent the record names: only verified when `by` is set. */
	author: string;
	rule: string;
	detail: string;
	/** Who did it, as Access verified them, when Blueprint stamped it. */
	by?: string;
}

/** What Blueprint stamps on a merge: everything its trailers claim, and the commits it joins. */
export function mergeStampPayload(merge: Pick<MergeRecord, "base" | "head" | "change" | "author" | "by" | "claimsTip" | "votesTip" | "testedOn">) {
	const { base, head, change, author, by, claimsTip, votesTip, testedOn } = merge;
	return stampPayload("merge", { base, head, change, agent: author, by, claimsTip, votesTip, testedOn: testedOn ?? null });
}

/** Claims idle longer than this may be released by anyone. */
export const STALE_AFTER_MS = 30 * 60_000;

export interface AuditRecords {
	/** The claims registry's history, oldest first. */
	registry: { tip: string; state: Registry }[];
	/** The votes' history, oldest first. */
	votes?: { tip: string; state: Votes }[];
	policy?: ReviewPolicy;
	/** The project's checks; when set, every merge must record checks passing on the main it merged onto. */
	verify?: string[];
	merges: MergeRecord[];
	staleAfterMs?: number;
}

export async function audit(records: AuditRecords): Promise<Violation[]> {
	const violations: Violation[] = [];
	// With a stamp key, only what Blueprint stamped is trusted.
	const key = records.registry[0]?.state.stampKey;
	const verified = (kind: string, record: object & { stamp?: string }) => (key ? verifyStamp(key, stampPayload(kind, record), record.stamp) : Promise.resolve(true));
	violations.push(...(await unverifiedClaims(records, verified)));
	const { votesAt, forged } = await verifiedVotes(records, verified);
	violations.push(...forged);

	const registryAt = new Map(records.registry.map((r) => [r.tip, r.state]));
	for (const merge of records.merges) {
		let stampedBy: string | undefined;
		const report = (rule: string, detail: string) => violations.push({ commit: merge.commit, author: merge.author, rule, detail, ...(stampedBy ? { by: stampedBy } : {}) });
		if (!merge.change || !merge.claimsTip) {
			report("undeclared", "the merge names no change or claims it checked (Blueprint-Change, Blueprint-Claims)");
			continue;
		}
		if (key && merge.by && (await verifyStamp(key, mergeStampPayload(merge), merge.stamp))) stampedBy = merge.by;
		// Unstamped: its maker is unverified. What it changed is still a fact in
		// Git, so the checks below still run against the records it cites.
		if (key && !stampedBy)
			violations.push({ commit: merge.commit, author: merge.author, rule: "unverified", detail: "the merge has no valid Blueprint stamp: whoever made it, and what its trailers say, is unverified" });
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
		if (records.verify?.length) {
			if (!merge.testedOn) report("untested", "the merge records no checks run (Blueprint-Tested)");
			else if (merge.testedOn !== merge.base) report("untested", `checks ran on ${merge.testedOn}, but the merge went onto ${merge.base}`);
		}
	}
	violations.push(...othersClaimsReleased(records));
	return violations;
}

type Verify = (kind: string, record: object & { stamp?: string }) => Promise<boolean>;

/** Claims added without a stamp, and claims that disappeared without a stamped release. */
async function unverifiedClaims(records: AuditRecords, verified: Verify): Promise<Violation[]> {
	const violations: Violation[] = [];
	const seen = new Set<string>();
	let previous: Registry | null = null;
	for (const { tip, state } of records.registry) {
		for (const held of state.claims) {
			const id = `${held.change}|${held.stamp ?? ""}|${held.active}`;
			if (seen.has(id)) continue;
			seen.add(id);
			if (!(await verified("claim", held))) violations.push({ commit: tip, author: held.agent, rule: "unverified-record", detail: `${held.change}'s claim has no valid Blueprint stamp` });
		}
		if (previous) {
			const added = state.released.slice(previous.released.length);
			for (const gone of previous.claims.filter((c) => !state.claims.some((x) => x.change === c.change))) {
				const release = added.find((r) => r.change === gone.change);
				if (!release || !(await verified("release", release))) violations.push({ commit: tip, author: gone.agent, rule: "unverified-record", detail: `${gone.change}'s claim was removed at ${tip} without a stamped release` });
			}
		}
		previous = state;
	}
	return violations;
}

/** The votes at each tip that count (stamped), and a report for each one that doesn't. */
async function verifiedVotes(records: AuditRecords, verified: Verify) {
	const votesAt = new Map<string, Votes>();
	const forged: Violation[] = [];
	const checked = new Map<string, boolean>();
	for (const { tip, state } of records.votes ?? []) {
		const counted: VoteRecord[] = [];
		for (const cast of state.votes) {
			const id = `${cast.reviewer}|${cast.commit}|${cast.at}|${cast.stamp ?? ""}`;
			if (!checked.has(id)) {
				const ok = await verified("vote", cast);
				checked.set(id, ok);
				if (!ok) forged.push({ commit: tip, author: cast.reviewer, rule: "unverified-record", detail: `${cast.reviewer}'s vote on ${cast.commit} has no valid Blueprint stamp, so it doesn't count` });
			}
			if (checked.get(id)) counted.push(cast);
		}
		votesAt.set(tip, { votes: counted });
	}
	return { votesAt, forged };
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
