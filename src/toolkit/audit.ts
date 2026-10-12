import { inLane, inLaneEntry } from "../claim-paths";
import type { ClaimRecord, Registry } from "./claims";
import { decodeShard } from "./shards";
import { stampPayload, verifyStamp } from "./stamp";
import { approval, type Author, type ReviewPolicy, type VoteRecord, type Votes, effectivePolicy } from "./votes";
import { settingsForBranch } from "./branch-rules";
import { skipsChecks } from "./check-scope";
import { type GitHubImport, trustedGitHubChange } from "./github-imports";
import { GITHUB_AGENT } from "./github-settings";

// The audit (see docs/design.md). Nothing stops an agent from breaking a convention, so this replays the records
// and reports every violation with the commit and agent responsible. It's a pure function, so anyone can rerun it
// over the same records and get the same answer.

/** A merge into main, as its commit records it. */
export interface MergeRecord {
	commit: string;
	author: string;
	/** GitHive-Change trailer. */
	change?: string;
	/** GitHive-Claims trailer: the claims state the merging agent checked. */
	claimsTip?: string;
	/** The reviewed commit, the merge's second parent. */
	head?: string;
	/** GitHive-Votes trailer: the votes state the merging agent counted. */
	votesTip?: string;
	/** Main before the merge, its first parent. */
	base?: string;
	/** GitHive-Tested trailer: the main the checks passed on. */
	testedOn?: string;
	/** GitHive-Tested-After trailer, on merges from before batches: heads merged ahead of it in the check. */
	testedAfter?: string[];
	/** GitHive-Tested-With trailer: every head checked together with it, in landing order, itself included. */
	testedWith?: string[];
	/** GitHive-By and GitHive-Stamp trailers: the verified identity that asked for the merge, and the stamp. */
	by?: string;
	stamp?: string;
	/** GitHive-Reverts trailer. */
	reverts?: string;
	files: string[];
	/** The branch it landed on, when not the project's. */
	branch?: string;
	/** `files` as the claims records name them, for a merge into another branch (see branch-scope.ts). */
	claimFiles?: string[];
}

export interface Violation {
	commit: string;
	/** The agent the record names, verified only when `by` is set. */
	author: string;
	rule: string;
	detail: string;
	/** The verified identity, when GitHive stamped the commit. */
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
	/** Each claims shard's history, oldest first, when claims are sharded. */
	shards?: Map<string, { tip: string; state: Registry }[]>;
	/** The votes' history, oldest first. */
	votes?: { tip: string; state: Votes }[];
	/** Each vote bucket's history, oldest first, once votes are sharded. */
	voteBuckets?: Map<string, { tip: string; state: Votes }[]>;
	/** The review policy for merges whose cited registry state has none (see settingsFor). */
	policy?: ReviewPolicy;
	/** The checks, likewise. When set, every merge must record checks passing on the main it merged onto. */
	verify?: string[];
	merges: MergeRecord[];
	staleAfterMs?: number;
	/** The commits of GitHub's GitHive brought in (the import record): what a trusted GitHub change may merge. */
	imports?: GitHubImport[];
}

export async function audit(records: AuditRecords): Promise<Violation[]> {
	const violations: Violation[] = [];
	// With a stamp key, only what GitHive stamped is trusted.
	const key = records.registry[0]?.state.stampKey;
	const verified = (kind: string, record: object & { stamp?: string }) =>
		key ? verifyStamp(key, stampPayload(kind, record), record.stamp) : Promise.resolve(true);
	for (const history of claimHistories(records)) violations.push(...(await unverifiedClaims(history, verified)));
	const { votesAt, forged } = await verifiedVotes(records, verified);
	violations.push(...forged);

	const indexed: IndexedRecords = {
		records,
		registryAt: new Map(records.registry.map((r) => [r.tip, r.state])),
		votesAt,
		byCommit: new Map(records.merges.map((m) => [m.commit, m])),
		// Each merge keyed by its base, to find what landed next.
		byBase: new Map(records.merges.filter((m) => m.base).map((m) => [m.base!, m])),
	};
	const reverts: MergeRecord[] = [];
	for (const merge of records.merges) {
		// A stamped revert restores what a reported commit changed, so it isn't checked as a change of its own.
		if (merge.reverts && (!key || (await verifyStamp(key, revertStampPayload(merge), merge.stamp)))) {
			reverts.push(merge);
			continue;
		}
		violations.push(...(await auditMerge(merge, key, indexed)));
	}
	for (const history of claimHistories(records))
		violations.push(...(await othersClaimsReleased(history, records.staleAfterMs, verified)));
	resolveReverts(violations, reverts);
	return violations;
}

type Verify = (kind: string, record: object & { stamp?: string }) => Promise<boolean>;
type History = { tip: string; state: Registry }[];
type Report = (rule: string, detail: string) => void;

// The records indexed for checking each merge.
interface IndexedRecords {
	records: AuditRecords;
	registryAt: Map<string, Registry>;
	votesAt: Map<string, Votes>;
	byCommit: Map<string, MergeRecord>;
	byBase: Map<string, MergeRecord>;
}

const claimHistories = (records: AuditRecords) => [records.registry, ...(records.shards?.values() ?? [])];

async function auditMerge(merge: MergeRecord, key: string | undefined, indexed: IndexedRecords): Promise<Violation[]> {
	const { records, registryAt, votesAt } = indexed;
	const violations: Violation[] = [];
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
		return violations;
	}
	if (key && merge.by && (await verifyStamp(key, mergeStampPayload(merge), merge.stamp))) stampedBy = merge.by;
	// An unstamped merge's maker is unverified, but what it changed is still in Git, so the checks still run.
	if (key && !stampedBy)
		violations.push({
			commit: merge.commit,
			author: merge.author,
			rule: "unverified",
			detail: "the merge has no valid GitHive stamp: whoever made it, and what its trailers say, is unverified",
		});
	const cited = citedClaims(records, registryAt, merge, report);
	if (!cited) return violations;
	const ownRecords = cited.claims.filter((claim) => claim.change === merge.change);
	const [firstRecord] = ownRecords;
	const own = firstRecord ? { ...firstRecord, paths: ownRecords.flatMap((claim) => claim.paths) } : undefined;
	checkFilesClaimed(merge, cited, own, report);
	checkDependencies(records.merges, merge, own, report);
	for (const { history, tip } of cited.records) checkReleasedAfter(history, tip, merge, report);
	const settings = settingsFor(records, registryAt, merge);
	// GitHub's change, while the repo trusted GitHub's changes, needed no votes.
	if (!(await trustedImport(records, registryAt, merge, ownRecords, key)))
		checkApproved(records, settings.policy, votesAt, merge, report, own);
	// A change that only touched files the settings said to skip needs no checks.
	if (settings.verify?.length && !skipsChecks(merge.files, settings.skipChecks)) checkTested(merge, indexed, report);
	return violations;
}

// Each file must be in the merge's own claim and in no other change's.
function checkFilesClaimed(
	merge: MergeRecord,
	cited: { claims: ClaimRecord[]; uncovered: Set<string> },
	own: ClaimRecord | undefined,
	report: Report,
) {
	merge.files.forEach((file, index) => {
		const claimed = merge.claimFiles?.[index] ?? file;
		if (cited.uncovered.has(claimed)) return;
		const holder = cited.claims.find((claim) => claim.change !== merge.change && inLane(claimed, claim.paths));
		if (holder)
			report("inside-another-claim", `${file} was claimed by ${holder.change} (${holder.agent}) at ${merge.claimsTip}`);
		else if (!own || !inLane(claimed, own.paths))
			report(
				"outside-claim",
				`${file} was not in ${merge.change}'s claim at ${merge.claimsTip}${merge.branch ? ` (on ${merge.branch})` : ""}`,
			);
	});
}

// Its claim's dependencies must have merged into the same branch first. Merges are read oldest first.
function checkDependencies(merges: MergeRecord[], merge: MergeRecord, own: ClaimRecord | undefined, report: Report) {
	const at = merges.indexOf(merge);
	for (const dependency of own?.after ?? []) {
		const before = merges.some(
			(earlier, index) =>
				index < at && earlier.change === dependency && (earlier.branch ?? "") === (merge.branch ?? ""),
		);
		if (!before)
			report(
				"merged-before-dependency",
				`${merge.change} waits on ${dependency}, which hadn't merged into ${merge.branch ?? "the project's branch"} ` +
					"before it",
			);
	}
}

function checkTested(merge: MergeRecord, indexed: IndexedRecords, report: Report) {
	if (!merge.testedOn) return report("untested", "the merge records no checks run (GitHive-Tested)");
	const asTested = merge.testedWith?.length
		? landedAsBatch(merge, indexed.byCommit, indexed.byBase)
		: testedAsLanded(merge, indexed.byCommit);
	if (asTested) return;
	const shortHeads = (heads: string[]) => heads.map((head) => head.slice(0, 8)).join(", ");
	if (merge.testedWith?.length) {
		const batch = ` with ${shortHeads(merge.testedWith)}`;
		report("untested", `checks ran on ${merge.testedOn}${batch}, but those didn't land on it as checked, in one batch`);
	} else {
		const after = merge.testedAfter?.length ? ` after ${shortHeads(merge.testedAfter)}` : "";
		report("untested", `checks ran on ${merge.testedOn}${after}, but the merge went onto ${merge.base}`);
	}
}

// A stamped revert resolves the violations of the commit it reverted. Reverting a commit the audit doesn't report
// is a violation of its own, which a later revert can resolve in turn.
function resolveReverts(violations: Violation[], reverts: MergeRecord[]) {
	for (const revert of reverts) {
		const undone = violations.filter((violation) => violation.commit === revert.reverts && !violation.resolvedBy);
		for (const violation of undone) violation.resolvedBy = revert.commit;
		if (!undone.length)
			violations.push({
				commit: revert.commit,
				author: revert.author,
				rule: "unjustified-revert",
				detail: `reverted ${revert.reverts}, which the audit doesn't report`,
				...(revert.by ? { by: revert.by } : {}),
			});
	}
}

// The claims a merge cites in GitHive-Claims: a registry tip, or when sharded `shard=tip` for each shard read,
// with the registry as "". Each file must be covered by a cited shard, its own or an ancestor.
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
		// A pair without "=" cites no tip, so nothing matches it and it's reported unknown below.
		const [encoded = "", at = ""] = pair.split("=");
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
	const checked = new Set<string>();
	let previous: Registry | null = null;
	for (const { tip, state } of history) {
		for (const held of state.claims) {
			const id = `${held.change}|${held.stamp ?? ""}|${held.active}`;
			if (checked.has(id)) continue;
			checked.add(id);
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
			const removed = previous.claims.filter((claim) => !state.claims.some((kept) => kept.change === claim.change));
			for (const gone of removed) {
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
	const bucketHistories = [...(records.voteBuckets?.values() ?? [])].flat();
	for (const { tip, state } of [...(records.votes ?? []), ...bucketHistories]) {
		const counted: VoteRecord[] = [];
		for (const vote of state.votes) {
			const id = `${vote.reviewer}|${vote.commit}|${vote.at}|${vote.stamp ?? ""}`;
			if (!checked.has(id)) {
				const ok = await verified("vote", vote);
				checked.set(id, ok);
				if (!ok)
					forged.push({
						commit: tip,
						author: vote.reviewer,
						rule: "unverified-record",
						detail: `${vote.reviewer}'s vote on ${vote.commit} has no valid GitHive stamp, so it ` + "doesn't count",
					});
			}
			if (checked.get(id)) counted.push(vote);
		}
		votesAt.set(tip, { votes: counted });
	}
	return { votesAt, forged };
}

// The cited claim must still have been held at merge time: the first later state without it must hold a release
// naming this merge. Otherwise the agent merged after giving its claim up.
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

// The votes a merge cites in GitHive-Votes: a votes record tip, or when sharded `=tip` for the record plus
// `bucket=tip` for the merged commit's bucket.
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
		const [bucket = "", tip = ""] = pair.split("=");
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

// A merge is held to the settings in the registry state it cites, since settings change over time, or to the
// records' own when it cites none.
function settingsFor(
	records: AuditRecords,
	registryAt: Map<string, Registry>,
	merge: MergeRecord,
): { policy?: ReviewPolicy; verify?: string[]; skipChecks?: string[] } {
	const tip = registryTip(merge.claimsTip!);
	const state = tip ? registryAt.get(tip) : undefined;
	const repo = {
		policy: state?.policy ?? records.policy,
		verify: state?.verify ?? records.verify,
		...(state?.skipChecks ? { skipChecks: state.skipChecks } : {}),
	};
	// A merge into another branch had that branch's settings at the time.
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

// The registry's tip in a GitHive-Claims trailer: the whole trailer, or when sharded the tip paired with "".
function registryTip(cited: string): string | undefined {
	if (!cited.includes("=")) return cited;
	return cited
		.split(/\s+/)
		.map((pair) => pair.split("="))
		.find(([shard = ""]) => decodeShard(shard) === "")?.[1];
}

// Whether a merge was GitHub's change, landed without votes as trusted: the trust rule (trustedGitHubChange) against
// its claim's records and the registry state it cites, the same rule the merge path applied.
async function trustedImport(
	records: AuditRecords,
	registryAt: Map<string, Registry>,
	merge: MergeRecord,
	claims: ClaimRecord[],
	key: string | undefined,
) {
	const tip = registryTip(merge.claimsTip!);
	return trustedGitHubChange({
		records: claims,
		head: merge.head,
		registry: tip ? registryAt.get(tip) : undefined,
		imports: async () => records.imports ?? [],
		stampKey: key,
	});
}

// The merged commit needs the policy's approvals from reviewers other than its author, every veto role's included,
// and no veto, in the votes the merge cites.
function checkApproved(
	records: AuditRecords,
	policy: ReviewPolicy | undefined,
	votesAt: Map<string, Votes>,
	merge: MergeRecord,
	report: (rule: string, detail: string) => void,
	author?: Author,
) {
	if (!policy) return;
	// A policy needing no approvals or sign-offs needs no votes cited, and there may be no votes at all yet.
	const needs = effectivePolicy(policy, merge.files);
	if (merge.head && !merge.votesTip && needs.required === 0 && !needs.vetoes.length) return;
	if (!merge.head || !merge.votesTip)
		return report("undeclared", "the merge names no reviewed commit or votes it counted (GitHive-Votes)");
	const votes = citedVotes(records, votesAt, merge, report);
	if (!votes) return;
	const outcome = approval(votes, merge.head, policy, author, merge.files);
	const { required } = needs;
	if (outcome.vetoedBy.length)
		report("unapproved", `${merge.head} was vetoed by ${outcome.vetoedBy.join(", ")} at ${merge.votesTip}`);
	else if (outcome.approvals < required)
		report("unapproved", `${merge.head} had ${outcome.approvals} of ${required} approvals at ${merge.votesTip}`);
	else if (outcome.awaiting.length)
		report("unapproved", `${merge.head} had no approval from ${outcome.awaiting.join(", ")} at ${merge.votesTip}`);
}

// Whether a merge went onto the code its checks ran on: the tested main itself or, for merges from before batches,
// that main plus exactly the merges it was checked after, in order.
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

// Whether a batch landed as checked: on the tested main, exactly its merges in order with nothing in between.
// A batch lands in one push, so main never stops partway through one.
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
	let at: MergeRecord | undefined = first;
	for (const head of heads) {
		if (!sameBatch(at) || at.head !== head) return false;
		at = byBase.get(at.commit);
	}
	return true;
}

/**
 * Releases of another agent's claim that wasn't stale yet. githive-github's claim (GitHub's change) is the exception:
 * a person who can write, or a repo admin, may give it up at any time, through the toolkit, which stamps the release
 * with who did it (see giveUpGitHubChange). The audit can't see who could write then, so it holds such a release to
 * being stamped.
 */
async function othersClaimsReleased(history: History, staleAfterMs: number | undefined, verified: Verify) {
	const staleAfter = staleAfterMs ?? STALE_AFTER_MS;
	const violations: Violation[] = [];
	let checked = 0;
	for (const entry of history) {
		for (const release of entry.state.released.slice(checked)) {
			if (release.by === release.agent) continue;
			if (release.agent === GITHUB_AGENT && release.stale && (await verified("release", release))) continue;
			const idle = Date.parse(release.at) - Date.parse(release.lastActive);
			if (idle <= staleAfter)
				violations.push({
					commit: entry.tip,
					author: release.by,
					rule: "released-others-claim",
					detail:
						`${release.by} released ${release.change} (${release.agent}), active ${Math.round(idle / 60_000)} ` +
						"minutes before, not stale",
				});
		}
		checked = entry.state.released.length;
	}
	return violations;
}
