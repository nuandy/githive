import { inLane, inLaneEntry } from "../claim-paths";
import type { ClaimRecord, Registry } from "./claims";
import { decodeShard } from "./shards";
import { stampPayload, verifyStamp } from "./stamp";
import { approval, type Author, type ReviewPolicy, type VoteRecord, type Votes, effectivePolicy } from "./votes";
import { settingsForBranch } from "./branch-rules";
import { skipsChecks } from "./check-scope";

// The audit (see docs/design.md). Nothing stops an
// agent from breaking a convention, so this replays the records and reports
// every violation, with the commit and the agent responsible. A pure function:
// anyone can run it over the same records and get the same answer.

/** A merge into main, as its commit records it. */
export interface MergeRecord {
	commit: string;
	author: string;
	/** From the merge's GitHive-Change trailer. */
	change?: string;
	/** From its GitHive-Claims trailer: the registry tip the merging agent checked. */
	claimsTip?: string;
	/** The change's commit that was reviewed and merged (the merge's second parent). */
	head?: string;
	/** From its GitHive-Votes trailer: the votes tip the merging agent counted. */
	votesTip?: string;
	/** Main before the merge (its first parent). */
	base?: string;
	/** From its GitHive-Tested trailer: the main the checks passed on. */
	testedOn?: string;
	/** From its GitHive-Tested-After trailer (merges from before batches): the changes (their heads) merged in before it in the check, ahead of it in line. */
	testedAfter?: string[];
	/** From its GitHive-Tested-With trailer: every change (its head) checked together with it, in landing order, itself among them. */
	testedWith?: string[];
	/** From its GitHive-By and GitHive-Stamp trailers: who asked the toolkit to merge, as Access verified them, and GitHive's stamp. */
	by?: string;
	stamp?: string;
	/** From its GitHive-Reverts trailer: the commit this one reverts. */
	reverts?: string;
	/** Files the merge changed. */
	files: string[];
	/** The branch it landed on, when not the project's. */
	branch?: string;
	/** The same files as the claims records name them, for a merge into another branch (see branch-scope.ts); absent, `files`. */
	claimFiles?: string[];
}

export interface Violation {
	commit: string;
	/** The agent the record names: only verified when `by` is set. */
	author: string;
	rule: string;
	detail: string;
	/** Who did it, as Access verified them, when GitHive stamped it. */
	by?: string;
	/** The stamped revert that undid the commit, if one did. */
	resolvedBy?: string;
}

/** What GitHive stamps on a revert: what it reverts, onto which main, and who asked. */
export function revertStampPayload(revert: { base?: string; reverts?: string; author: string; by?: string }) {
	return stampPayload("revert", { base: revert.base, reverts: revert.reverts, agent: revert.author, by: revert.by });
}

/** What GitHive stamps on a merge: everything its trailers claim, and the commits it joins. */
export function mergeStampPayload(
	merge: Pick<
		MergeRecord,
		"base" | "head" | "change" | "author" | "by" | "claimsTip" | "votesTip" | "testedOn" | "testedAfter" | "testedWith"
	>,
) {
	const { base, head, change, author, by, claimsTip, votesTip, testedOn, testedAfter, testedWith } = merge;
	return stampPayload("merge", {
		base,
		head,
		change,
		agent: author,
		by,
		claimsTip,
		votesTip,
		testedOn: testedOn ?? null,
		...(testedAfter?.length ? { testedAfter } : {}),
		...(testedWith?.length ? { testedWith } : {}),
	});
}

/** Claims idle longer than this may be released by anyone. */
export const STALE_AFTER_MS = 30 * 60_000;

export interface AuditRecords {
	/** The claims registry's history, oldest first. */
	registry: { tip: string; state: Registry }[];
	/** Each claims shard's history, oldest first, when claims are sharded (see shards.ts). */
	shards?: Map<string, { tip: string; state: Registry }[]>;
	/** The votes' history, oldest first. */
	votes?: { tip: string; state: Votes }[];
	/** Each vote bucket's history, oldest first, once the votes are sharded (see vote-store.ts). */
	voteBuckets?: Map<string, { tip: string; state: Votes }[]>;
	/** The review policy, for merges that cite no registry state with one (see settingsFor). */
	policy?: ReviewPolicy;
	/** The project's checks, likewise; when set, every merge must record checks passing on the main it merged onto. */
	verify?: string[];
	merges: MergeRecord[];
	staleAfterMs?: number;
}

export async function audit(records: AuditRecords): Promise<Violation[]> {
	const violations: Violation[] = [];
	// With a stamp key, only what GitHive stamped is trusted.
	const key = records.registry[0]?.state.stampKey;
	const verified = (kind: string, record: object & { stamp?: string }) =>
		key ? verifyStamp(key, stampPayload(kind, record), record.stamp) : Promise.resolve(true);
	for (const history of [records.registry, ...(records.shards?.values() ?? [])])
		violations.push(...(await unverifiedClaims(history, verified)));
	const { votesAt, forged } = await verifiedVotes(records, verified);
	violations.push(...forged);

	const registryAt = new Map(records.registry.map((r) => [r.tip, r.state]));
	const byCommit = new Map(records.merges.map((m) => [m.commit, m]));
	/** Each merge by the one before it on its branch: what landed next. */
	const byBase = new Map(records.merges.filter((m) => m.base).map((m) => [m.base!, m]));
	/** Stamped reverts: what each undid, settled once every commit has been checked. */
	const reverts: MergeRecord[] = [];
	for (const merge of records.merges) {
		// A revert through the toolkit restores what a reported commit changed; it isn't a change of its own.
		// Without a stamp key nothing is verified, as for every other record.
		if (merge.reverts && (!key || (await verifyStamp(key, revertStampPayload(merge), merge.stamp)))) {
			reverts.push(merge);
			continue;
		}
		let stampedBy: string | undefined;
		const report = (rule: string, detail: string) =>
			violations.push({
				commit: merge.commit,
				author: merge.author,
				rule,
				detail,
				...(stampedBy ? { by: stampedBy } : {}),
			});
		if (!merge.change || !merge.claimsTip) {
			report("undeclared", "the merge names no change or claims it checked (GitHive-Change, GitHive-Claims)");
			continue;
		}
		if (key && merge.by && (await verifyStamp(key, mergeStampPayload(merge), merge.stamp))) stampedBy = merge.by;
		// Unstamped: its maker is unverified. What it changed is still a fact in
		// Git, so the checks below still run against the records it cites.
		if (key && !stampedBy)
			violations.push({
				commit: merge.commit,
				author: merge.author,
				rule: "unverified",
				detail: "the merge has no valid GitHive stamp: whoever made it, and what its trailers say, is unverified",
			});
		const cited = citedClaims(records, registryAt, merge, report);
		if (!cited) continue;
		const ownRecords = cited.claims.filter((c) => c.change === merge.change);
		const own = ownRecords.length ? { ...ownRecords[0], paths: ownRecords.flatMap((c) => c.paths) } : undefined;
		merge.files.forEach((file, i) => {
			const claimed = merge.claimFiles?.[i] ?? file;
			if (cited.uncovered.has(claimed)) return;
			const holder = cited.claims.find((c) => c.change !== merge.change && inLane(claimed, c.paths));
			if (holder)
				report(
					"inside-another-claim",
					`${file} was claimed by ${holder.change} (${holder.agent}) at ${merge.claimsTip}`,
				);
			else if (!own || !inLane(claimed, own.paths))
				report(
					"outside-claim",
					`${file} was not in ${merge.change}'s claim at ${merge.claimsTip}${merge.branch ? ` (on ${merge.branch})` : ""}`,
				);
		});
		// What its claim waited on merged into the same branch first (each branch's merges are read oldest first).
		for (const dep of own?.after ?? []) {
			const at = records.merges.indexOf(merge);
			const before = records.merges.some(
				(m, i) => i < at && m.change === dep && (m.branch ?? "") === (merge.branch ?? ""),
			);
			if (!before)
				report(
					"merged-before-dependency",
					`${merge.change} waits on ${dep}, which hadn't merged into ${merge.branch ?? "the project's branch"} before it`,
				);
		}
		for (const { history, tip } of cited.records) checkReleasedAfter(history, tip, merge, report);
		const settings = settingsFor(records, registryAt, merge);
		checkApproved(records, settings.policy, votesAt, merge, report, own);
		// Checks it needed: none for a change that only touched what they skip, as the settings then said.
		if (settings.verify?.length && !skipsChecks(merge.files, settings.skipChecks)) {
			if (!merge.testedOn) report("untested", "the merge records no checks run (GitHive-Tested)");
			else if (merge.testedWith?.length ? !landedAsBatch(merge, byCommit, byBase) : !testedAsLanded(merge, byCommit)) {
				const after = merge.testedAfter?.length
					? ` after ${merge.testedAfter.map((h) => h.slice(0, 8)).join(", ")}`
					: "";
				const batch = merge.testedWith?.length ? ` with ${merge.testedWith.map((h) => h.slice(0, 8)).join(", ")}` : "";
				report(
					"untested",
					batch
						? `checks ran on ${merge.testedOn}${batch}, but those didn't land on it as checked, in one batch`
						: `checks ran on ${merge.testedOn}${after}, but the merge went onto ${merge.base}`,
				);
			}
		}
	}
	for (const history of [records.registry, ...(records.shards?.values() ?? [])])
		violations.push(...othersClaimsReleased(history, records.staleAfterMs));
	for (const revert of reverts) {
		const undone = violations.filter((v) => v.commit === revert.reverts && !v.resolvedBy);
		for (const v of undone) v.resolvedBy = revert.commit;
		if (!undone.length)
			violations.push({
				commit: revert.commit,
				author: revert.author,
				rule: "unjustified-revert",
				detail: `reverted ${revert.reverts}, which the audit doesn't report`,
				...(revert.by ? { by: revert.by } : {}),
			});
	}
	return violations;
}

type Verify = (kind: string, record: object & { stamp?: string }) => Promise<boolean>;
type History = { tip: string; state: Registry }[];

/**
 * The claims a merge says it checked (its GitHive-Claims trailer): a tip of
 * the claims registry, or, sharded, `shard=tip` for each shard it read, the
 * registry among them as "" (above every shard). Each file must be covered by
 * a cited shard (its own or one above it).
 */
function citedClaims(
	records: AuditRecords,
	registryAt: Map<string, Registry>,
	merge: MergeRecord,
	report: (rule: string, detail: string) => void,
) {
	const tip = merge.claimsTip!;
	if (!tip.includes("=")) {
		const state = registryAt.get(tip);
		if (!state) return void report("unknown-claims", `${tip} is not in the claims registry's history`);
		return { claims: state.claims, records: [{ history: records.registry, tip }], uncovered: new Set<string>() };
	}
	const claims: ClaimRecord[] = [];
	const cited: { shard: string; history: History; tip: string }[] = [];
	for (const pair of tip.split(/\s+/).filter(Boolean)) {
		const [encoded, at] = pair.split("=");
		const shard = decodeShard(encoded);
		const history = shard === "" ? records.registry : records.shards?.get(shard);
		const entry = history?.find((e) => e.tip === at);
		if (!history || !entry) return void report("unknown-claims", `${shard}@${at} is not in that shard's history`);
		claims.push(...entry.state.claims);
		cited.push({ shard, history, tip: at });
	}
	const uncovered = new Set(
		(merge.claimFiles ?? merge.files).filter(
			(file) => !cited.some(({ shard }) => shard === "" || inLaneEntry(file, shard)),
		),
	);
	for (const file of uncovered) report("unknown-claims", `${file}: the merge cites no claims shard covering it`);
	return { claims, records: cited, uncovered };
}

/** Claims added without a stamp, and claims that disappeared without a stamped release. */
async function unverifiedClaims(history: History, verified: Verify): Promise<Violation[]> {
	const violations: Violation[] = [];
	const seen = new Set<string>();
	let previous: Registry | null = null;
	for (const { tip, state } of history) {
		for (const held of state.claims) {
			const id = `${held.change}|${held.stamp ?? ""}|${held.active}`;
			if (seen.has(id)) continue;
			seen.add(id);
			if (!(await verified("claim", held)))
				violations.push({
					commit: tip,
					author: held.agent,
					rule: "unverified-record",
					detail: `${held.change}'s claim has no valid GitHive stamp`,
				});
		}
		if (previous) {
			const added = state.released.slice(previous.released.length);
			for (const gone of previous.claims.filter((c) => !state.claims.some((x) => x.change === c.change))) {
				const release = added.find((r) => r.change === gone.change);
				if (!release || !(await verified("release", release)))
					violations.push({
						commit: tip,
						author: gone.agent,
						rule: "unverified-record",
						detail: `${gone.change}'s claim was removed at ${tip} without a stamped release`,
					});
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
	for (const { tip, state } of [...(records.votes ?? []), ...[...(records.voteBuckets?.values() ?? [])].flat()]) {
		const counted: VoteRecord[] = [];
		for (const cast of state.votes) {
			const id = `${cast.reviewer}|${cast.commit}|${cast.at}|${cast.stamp ?? ""}`;
			if (!checked.has(id)) {
				const ok = await verified("vote", cast);
				checked.set(id, ok);
				if (!ok)
					forged.push({
						commit: tip,
						author: cast.reviewer,
						rule: "unverified-record",
						detail: `${cast.reviewer}'s vote on ${cast.commit} has no valid GitHive stamp, so it doesn't count`,
					});
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
function checkReleasedAfter(
	history: History,
	tip: string,
	merge: MergeRecord,
	report: (rule: string, detail: string) => void,
) {
	const from = history.findIndex((r) => r.tip === tip);
	// Only a record that held the change's claim at the cited tip has a release to check.
	if (!history[from]?.state.claims.some((c) => c.change === merge.change)) return;
	for (const later of history.slice(from + 1)) {
		if (later.state.claims.some((c) => c.change === merge.change)) continue;
		const release = later.state.released.findLast((r) => r.change === merge.change);
		if (release?.mergedAs !== merge.commit)
			report(
				"released-before-merge",
				`${merge.change}'s claim was released at ${later.tip} without naming ${merge.commit} as its merge`,
			);
		return;
	}
}

/**
 * The votes a merge says it counted (its GitHive-Votes trailer): a tip of
 * the votes record, or, sharded, `=tip` for the record and `bucket=tip` for
 * the bucket of the merged commit, counted together.
 */
function citedVotes(
	records: AuditRecords,
	votesAt: Map<string, Votes>,
	merge: MergeRecord,
	report: (rule: string, detail: string) => void,
): Votes | undefined {
	const cited = merge.votesTip!;
	if (!cited.includes("=")) {
		const votes = votesAt.get(cited);
		if (!votes) report("unknown-votes", `${cited} is not in the votes' history`);
		return votes;
	}
	const votes: VoteRecord[] = [];
	for (const pair of cited.split(/\s+/).filter(Boolean)) {
		const [bucket, tip] = pair.split("=");
		const history = bucket === "" ? records.votes : records.voteBuckets?.get(bucket);
		const at = history?.some((e) => e.tip === tip) ? votesAt.get(tip) : undefined;
		if (!at)
			return void report(
				"unknown-votes",
				`${bucket ? `bucket ${bucket}` : "the votes record"} at ${tip} is not in its history`,
			);
		votes.push(...at.votes);
	}
	return { votes };
}

/**
 * The settings a merge is held to: the review policy and checks in the
 * registry state it cites (the registry itself, "", among shards), since
 * settings can change; the records' own when it cites none.
 */
function settingsFor(
	records: AuditRecords,
	registryAt: Map<string, Registry>,
	merge: MergeRecord,
): { policy?: ReviewPolicy; verify?: string[]; skipChecks?: string[] } {
	const cited = merge.claimsTip!;
	const tip = cited.includes("=")
		? cited
				.split(/\s+/)
				.map((pair) => pair.split("="))
				.find(([shard]) => decodeShard(shard) === "")?.[1]
		: cited;
	const state = tip ? registryAt.get(tip) : undefined;
	const repo = {
		policy: state?.policy ?? records.policy,
		verify: state?.verify ?? records.verify,
		...(state?.skipChecks ? { skipChecks: state.skipChecks } : {}),
	};
	// A merge into another branch had that branch's settings: the repo's, with what its rule changed then.
	if (!merge.branch || !state?.branchRules?.length || !repo.policy) return repo;
	const settings = settingsForBranch(
		{ policy: repo.policy, verify: repo.verify ?? [], rules: state.branchRules, project: state.branch ?? "main" },
		merge.branch,
	);
	return {
		policy: settings.policy,
		verify: settings.verify,
		...(repo.skipChecks ? { skipChecks: repo.skipChecks } : {}),
	};
}

/** The merged commit must have had the policy's approvals from reviewers other than its author, every veto role's among them, and no veto, in the votes the merge cites. */
function checkApproved(
	records: AuditRecords,
	policy: ReviewPolicy | undefined,
	votesAt: Map<string, Votes>,
	merge: MergeRecord,
	report: (rule: string, detail: string) => void,
	author?: Author,
) {
	if (!policy) return;
	// A policy that needs no approvals and no role's sign-off needs no votes to cite (there may be no votes yet at all).
	const needs = effectivePolicy(policy, merge.files);
	if (merge.head && !merge.votesTip && needs.required === 0 && !needs.vetoes.length) return;
	if (!merge.head || !merge.votesTip)
		return report("undeclared", "the merge names no reviewed commit or votes it counted (GitHive-Votes)");
	const votes = citedVotes(records, votesAt, merge, report);
	if (!votes) return;
	// Distinct verified reviewers, never the change's own author.
	const outcome = approval(votes, merge.head, policy, author, merge.files);
	const { required } = effectivePolicy(policy, merge.files);
	if (outcome.vetoedBy.length)
		report("unapproved", `${merge.head} was vetoed by ${outcome.vetoedBy.join(", ")} at ${merge.votesTip}`);
	else if (outcome.approvals < required)
		report("unapproved", `${merge.head} had ${outcome.approvals} of ${required} approvals at ${merge.votesTip}`);
	else if (outcome.awaiting.length)
		report("unapproved", `${merge.head} had no approval from ${outcome.awaiting.join(", ")} at ${merge.votesTip}`);
}

/**
 * Whether a merge went onto the code its checks ran on: right onto the main
 * they ran on, or, checked in a line after other merges (before batches),
 * onto that main with exactly those merges (and nothing else) landed on it
 * since, in order.
 */
function testedAsLanded(merge: MergeRecord, byCommit: Map<string, MergeRecord>) {
	const after = merge.testedAfter ?? [];
	const landed: string[] = [];
	for (let at = merge.base; at !== merge.testedOn;) {
		const between = at ? byCommit.get(at) : undefined;
		if (!between?.head || landed.length === after.length) return false;
		landed.unshift(between.head);
		at = between.base;
	}
	return landed.length === after.length && landed.every((head, i) => head === after[i]);
}

/**
 * Whether a merge checked together with other changes landed as checked:
 * right on the main the checks ran on, the batch's merges one after another,
 * exactly the changes it names, in its order, and nothing in between. (They
 * land in one push, so main never stops partway through a batch.)
 */
function landedAsBatch(merge: MergeRecord, byCommit: Map<string, MergeRecord>, byBase: Map<string, MergeRecord>) {
	const heads = merge.testedWith!;
	const sameBatch = (m: MergeRecord | undefined): m is MergeRecord =>
		!!m && m.testedOn === merge.testedOn && m.testedWith?.join(" ") === heads.join(" ");
	// Back to the main the checks ran on, through the batch's merges before this one.
	let first = merge;
	for (let steps = 0; first.base !== merge.testedOn; steps++) {
		const before = first.base ? byCommit.get(first.base) : undefined;
		if (steps >= heads.length || !sameBatch(before)) return false;
		first = before;
	}
	// From there, exactly the batch.
	let at: MergeRecord | undefined = first;
	for (const head of heads) {
		if (!sameBatch(at) || at.head !== head) return false;
		at = byBase.get(at.commit);
	}
	return true;
}

/** Releases of another agent's claim that wasn't stale yet. */
function othersClaimsReleased(history: History, staleAfterMs?: number): Violation[] {
	const staleAfter = staleAfterMs ?? STALE_AFTER_MS;
	const violations: Violation[] = [];
	let seen = 0;
	for (const entry of history) {
		for (const release of entry.state.released.slice(seen)) {
			if (release.by === release.agent) continue;
			const idle = Date.parse(release.at) - Date.parse(release.lastActive);
			if (idle <= staleAfter)
				violations.push({
					commit: entry.tip,
					author: release.by,
					rule: "released-others-claim",
					detail: `${release.by} released ${release.change} (${release.agent}), active ${Math.round(idle / 60_000)} minutes before, not stale`,
				});
		}
		seen = entry.state.released.length;
	}
	return violations;
}
