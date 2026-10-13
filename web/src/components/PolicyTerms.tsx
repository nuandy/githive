import type { RepoSnapshot } from "../api";
import { blockingRoles, shardingSummary, votesShardingSummary } from "../lib/claimStatus";

// A repo's settings in words, as terms in a list (TERMS): how changes merge, for readers and, from the draft, for the
// admin editing it ("What this means"); and how the records are kept.

type Policy = RepoSnapshot["policy"];
type PathRule = NonNullable<Policy["escalate"]>[number];

/** A stricter rule for paths, in words: what touching them needs. */
function ruleWords(rule: PathRule, required: number) {
	const approvals = rule.required ?? required;
	const approvalWords = `${approvals} ${approvals === 1 ? "approval" : "approvals"}`;
	const blockers = rule.vetoes?.length ? `; ${rule.vetoes.join(", ")} can block` : "";
	return `${approvalWords}${blockers}`;
}

/** How changes merge, as terms: approvals, who can block, stricter paths and the checks. */
export function MergePolicyTerms({ policy, verify }: { policy: Policy; verify: string[] }) {
	const blockers = blockingRoles(policy);
	return (
		<>
			<dt>Approvals</dt>
			<dd>
				Merging needs {policy.required} {policy.required === 1 ? "approval" : "approvals"}
				{policy.vetoes.length ? `; ${policy.vetoes.join(", ")} can block` : ""}
			</dd>
			{blockers.length ? (
				<>
					<dt>Who can block</dt>
					<dd>
						{blockers.map(({ role, holders }) => `${role}: ${holders}`).join("; ")}. A vote as one of these roles from
						anyone else counts as an ordinary review.
					</dd>
				</>
			) : null}
			{policy.escalate?.length ? (
				<>
					<dt>Stricter paths</dt>
					<dd>
						<ul className="m-0 list-disc pl-5">
							{policy.escalate.map((rule, index) => (
								<li key={index} className="not-first:mt-1">
									{rule.paths.map((path) => (
										<code key={path}>{path}</code>
									))}{" "}
									need {ruleWords(rule, policy.required)}
								</li>
							))}
						</ul>
					</dd>
				</>
			) : null}
			<dt>Merge checks</dt>
			<dd>
				{verify.length
					? verify.map((command) => <code key={command}>{command}</code>)
					: "None: changes that merge cleanly but break together aren't caught"}
			</dd>
		</>
	);
}

/** The GitHub link in words: where GitHive's work goes, and whether GitHub's changes come back reviewed. */
export function githubTerms(github: NonNullable<RepoSnapshot["github"]>, branch: string) {
	const how =
		github.sync === "pr"
			? `GitHive's work reaches ${github.repo} through one pull request from githive/main, merged on GitHub`
			: `GitHive pushes ${branch} to ${github.repo} after every landing`;
	if (!github.inbound) return `${how}, as it did before modes: GitHub's changes aren't brought back.`;
	const back = github.trust
		? "GitHub's changes come back as githive-github's change, landing through the checks without review"
		: "GitHub's changes come back as githive-github's change, reviewed like any change";
	return `${how}. ${back}.`;
}

/** How the records are kept, as terms: signed or not, how claims and votes are stored, branches, and GitHub. */
export function RecordsTerms({ snapshot }: { snapshot: RepoSnapshot }) {
	const sharding = shardingSummary(snapshot);
	const votesSharding = votesShardingSummary(snapshot);
	return (
		<>
			<dt>Signed records</dt>
			<dd>
				{snapshot.verified
					? "Records and merges are stamped with verified identity"
					: "Records are not stamped: names are as agents give them"}
			</dd>
			{sharding ? (
				<>
					<dt>Claims</dt>
					<dd>{sharding.detail}</dd>
				</>
			) : null}
			{votesSharding ? (
				<>
					<dt>Votes</dt>
					<dd>{votesSharding.detail}</dd>
				</>
			) : null}
			<dt>Branches</dt>
			<dd>
				Each change works in its own fork: agents can't write {snapshot.branch ?? "main"}; only the toolkit merges, once
				the conventions hold.
			</dd>
			{snapshot.github ? (
				<>
					<dt>GitHub</dt>
					<dd>{githubTerms(snapshot.github, snapshot.branch ?? "main")}</dd>
				</>
			) : null}
		</>
	);
}
