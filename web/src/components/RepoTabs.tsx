import type { ReactNode } from "react";
import type { RepoAudit, RepoSnapshot } from "../api";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { useStagger } from "../hooks/useStagger";
import { identityName } from "../lib/agent";
import type { Tone } from "../lib/changeStatus";
import {
	claimAgent,
	claimApprovalLabel,
	claimTitle,
	blockingRoles,
	claimStatus,
	isFromGitHub,
	shardingSummary,
	votesShardingSummary,
	type Claim,
	type Vote,
} from "../lib/claimStatus";
import { leaseWords } from "../lib/lease";
import { shortSha, briefPaths } from "../lib/model";
import { counted } from "../lib/plural";
import { shortAge, timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icon";
import { StatusIcon, StatusPill, TONE_TEXT } from "./StatusPill";
import { Badge, Counter } from "./ui/badge";
import { Box, BoxBody, BoxHeader, Callout } from "./ui/box";
import { Empty } from "./ui/empty";
import { TERMS } from "./ui/manage";

export { ChangePage, type ChangePageProps } from "./ChangePage";

// No central server enforces a repo's rules, so these pages show who holds what, how reviews stand, and
// what the audit found in Git, including violations a revert has since resolved.

/** How a change's approvals look: blocked, approved, or still waiting. */
function approvalLook(approval: Claim["approval"]): { tone: Tone; icon: IconName } {
	if (approval.vetoedBy.length) return { tone: "bad", icon: "x" };
	if (approval.approved) return { tone: "good", icon: "check" };
	return { tone: "warn", icon: "eye" };
}

function Approvals({ claim }: { claim: Claim }) {
	const { approval } = claim;
	if (!claim.head) return null;
	const { tone, icon } = approvalLook(approval);
	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 font-medium whitespace-nowrap transition-colors duration-base",
				TONE_TEXT[tone],
			)}
			title={`${approval.approvals} of ${approval.required} approvals`}
		>
			<Icon name={icon} size={14} />
			{claimApprovalLabel(claim)}
		</span>
	);
}

/**
 * Where a change lands and what holds it back, when that isn't the plain case: into another branch, merging a
 * whole branch, or waiting on other changes. Pills a size smaller, beside a change row's title.
 */
export function ChangeLabels({
	claim,
}: {
	claim: Pick<Claim, "into" | "source" | "waitsOn" | "trusted"> & { agent?: string };
}) {
	return (
		<>
			{isFromGitHub(claim) ? (
				<Badge outline size="sm" title={claim.trusted ?? "GitHub's changes, reviewed like any change"}>
					from GitHub{claim.trusted ? ", trusted" : ""}
				</Badge>
			) : claim.source ? (
				<Badge outline size="sm">
					merges <code>{claim.source}</code>
				</Badge>
			) : null}
			{claim.into ? (
				<Badge outline size="sm">
					into <code>{claim.into}</code>
				</Badge>
			) : null}
			{claim.waitsOn?.length ? (
				<Badge tone="warn" size="sm">
					waits on {claim.waitsOn.join(", ")}
				</Badge>
			) : null}
		</>
	);
}

// A small icon in a line of text: on the text's baseline, a pixel under it, a little apart from what follows.
const INLINE_ICON = "inline -mb-px mr-0.75 align-baseline";

/**
 * One open change in the list: its status, title, who opened it, what it claims, when it frees up, and its approvals.
 * Under the pointer its row lights, fading in and out (an overlay's opacity: a mixed color doesn't transition well).
 */
function ChangeRow({
	claim,
	votes,
	repo,
	now,
	arrived,
}: {
	claim: Claim;
	votes: Vote[];
	repo: string;
	now?: number;
	arrived: boolean;
}) {
	const status = claimStatus(claim, votes);
	// Only a claim on its agent's turn frees up, at a time; the change's page says why the others don't.
	const lease = leaseWords(claim.lease, now);
	return (
		<li
			className={cn(
				"relative isolate flex items-start gap-2.5 border-t border-border px-4 py-3 first:border-t-0 to-720:flex-wrap",
				"before:absolute before:inset-0 before:-z-10 before:bg-surface-2/55 before:opacity-0",
				"before:transition-opacity before:duration-fast hover:before:opacity-100",
				arrived && "animate-appear",
			)}
		>
			<StatusIcon status={status} />
			<div className="min-w-0 flex-1 to-720:basis-[calc(100%-30px)]">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
					<a
						className="text-body font-semibold wrap-anywhere text-foreground transition-colors duration-fast hover:text-link"
						href={href.change(repo, claim.change)}
					>
						{claimTitle(claim)}
					</a>
					{status.kind !== "in-review" ? <StatusPill status={status} size="sm" /> : null}
					<ChangeLabels claim={claim} />
				</div>
				<p className="mt-0.75 mb-0 text-meta wrap-anywhere text-muted-foreground">
					<span className="font-mono text-caption">{claim.change}</span>
					<span>
						{" · "}opened {timeAgo(claim.since)} by {claimAgent(claim)}
					</span>
					{claim.paths.length ? (
						<span className="font-mono text-caption">
							{" · "}
							<Icon name="folder" size={12} className={INLINE_ICON} />
							<span title={claim.paths.join("\n")}>{briefPaths(claim.paths)}</span>
						</span>
					) : null}
					{lease?.short ? (
						<span className={cn("whitespace-nowrap", lease.free && "text-warn")} title={lease.long}>
							{" · "}
							<Icon name="clock" size={12} className={INLINE_ICON} />
							{lease.short}
						</span>
					) : null}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-3.5 pt-0.5 text-meta to-720:ml-6.5 to-720:flex-wrap to-720:gap-y-1.5">
				<Approvals claim={claim} />
				{claim.head ? <code className="text-muted-foreground">{shortSha(claim.head)}</code> : null}
				<time
					className="min-w-7 text-right text-muted-foreground to-720:text-left"
					dateTime={claim.active}
					title={`Last active ${new Date(claim.active).toLocaleString()}`}
				>
					{shortAge(claim.active)}
				</time>
			</div>
		</li>
	);
}

/** A number that bumps as it changes. */
function Bumping({ count }: { count: number }) {
	const changed = useChanged(count);
	return (
		<span key={count} className={changed ? "animate-bump" : undefined}>
			{count}
		</span>
	);
}

/** The rows of a list that has some: those that come after it first showed fade in as they do. */
function ChangeRows({
	claims,
	votes,
	repo,
	now,
	fades,
}: {
	claims: Claim[];
	votes: Vote[];
	repo: string;
	now?: number;
	fades: boolean;
}) {
	const arrived = useArrivals(claims.map((claim) => claim.change));
	const staggers = useStagger(claims.length > 0);
	return (
		<ul className={cn("m-0 list-none p-0", staggers ? "stagger" : fades && "animate-fade")}>
			{claims.map((claim) => (
				<ChangeRow
					key={claim.change}
					claim={claim}
					votes={votes}
					repo={repo}
					now={now}
					arrived={arrived(claim.change)}
				/>
			))}
		</ul>
	);
}

/**
 * The open changes, newest first: all of them, or those on `shown` (the branch the overview shows). Another branch's
 * list, or the list in place of "No open changes" (or that in place of the list), fades in; so does a change opened
 * while it shows.
 */
export function ChangeList({
	snapshot,
	repo,
	shown,
	now,
}: {
	snapshot: RepoSnapshot;
	repo: string;
	shown?: string;
	/** The time leases are told against (tests fix it). */
	now?: number;
}) {
	const project = snapshot.branch ?? "main";
	const claims = [...snapshot.claims]
		.filter((claim) => !shown || (claim.into ?? project) === shown)
		.sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
	const branchChanged = useChanged(shown);
	const emptied = useChanged(claims.length === 0);
	const fades = branchChanged || emptied;
	return (
		<Box aria-labelledby="changes-title">
			<BoxHeader>
				{/* The browser's size for an h2: 1.5em of the 15px it's in. */}
				<h2
					id="changes-title"
					className="inline-flex items-center gap-1.5 py-0.5 text-[22.5px] font-semibold text-foreground"
					aria-current="page"
				>
					<Icon name="pull" />
					<Bumping count={claims.length} /> Open
				</h2>
				{snapshot.audit ? (
					<span className="inline-flex items-center gap-1.5 py-0.5 font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground">
						<Icon name="merge" />
						<Bumping count={snapshot.audit.merges} /> merged on {snapshot.branch ?? "main"}
					</span>
				) : null}
			</BoxHeader>
			{claims.length === 0 ? (
				<Empty className={cn(fades && "animate-fade")}>
					<Icon name="pull" size={28} />
					<h2>No open changes</h2>
					<p>When an agent claims part of {repo} and starts work, its change appears here.</p>
				</Empty>
			) : (
				<ChangeRows key={shown} claims={claims} votes={snapshot.votes} repo={repo} now={now} fades={fades} />
			)}
		</Box>
	);
}

// The audit's rows: an icon a little down the first line, then what it says; ruled off from the one above, the first
// from the box's header too.
const AUDIT_ROW = "flex items-start gap-2.5 border-t border-border px-0.5 py-3 wrap-anywhere";
const AUDIT_ICON = "mt-0.5 inline-flex shrink-0";

function Violations({ title, violations }: { title: string; violations: RepoAudit["violations"] }) {
	const changed = useChanged(violations.length);
	const staggers = useStagger(violations.length > 0);
	return (
		<Box>
			<BoxHeader>
				<h3 className="text-body-sm">{title}</h3>
				<Counter key={violations.length} className={changed ? "animate-bump" : undefined}>
					{violations.length}
				</Counter>
			</BoxHeader>
			<ul className={cn("m-0 list-none p-0", staggers && "stagger")}>
				{violations.map((violation, index) => (
					<ViolationRow key={`${violation.commit}-${violation.rule}-${index}`} violation={violation} />
				))}
			</ul>
		</Box>
	);
}

/** A rule broken: by whom, in which commit, what was wrong, and the commit that resolved it, if one has. */
function ViolationRow({ violation }: { violation: RepoAudit["violations"][number] }) {
	const by = violation.by ? identityName(violation.by) : "unverified";
	return (
		<li className={cn(AUDIT_ROW, violation.resolvedBy && "opacity-75")}>
			<span className={cn(AUDIT_ICON, violation.resolvedBy ? "text-neutral" : "text-bad")}>
				<Icon name={violation.resolvedBy ? "check-circle" : "alert"} />
			</span>
			<div>
				<p className="m-0">
					<strong>{violation.rule}</strong> by {violation.author}
					<span className="text-muted-foreground"> ({by})</span>
					{" in"} <code>{shortSha(violation.commit)}</code>
				</p>
				<p className="mt-0.5 mb-0 text-muted-foreground">{violation.detail}</p>
				{violation.resolvedBy ? (
					<p className="mt-0.5 mb-0 text-muted-foreground">resolved by {shortSha(violation.resolvedBy)}</p>
				) : null}
			</div>
		</li>
	);
}

/** The reviews recorded, newest as the snapshot lists them; one recorded since they first showed fades in. */
function RecentReviews({ votes }: { votes: RepoSnapshot["votes"] }) {
	const key = (vote: RepoSnapshot["votes"][number]) => `${vote.reviewer}-${vote.commit}-${vote.at}`;
	const arrived = useArrivals(votes.map(key));
	const staggers = useStagger(votes.length > 0);
	if (votes.length === 0) return <p className="my-3.75 px-0.5 py-3 text-muted-foreground">No reviews yet.</p>;
	return (
		<ul className={cn("m-0 list-none p-0", staggers && "stagger")}>
			{votes.map((vote) => (
				<li key={key(vote)} className={cn(AUDIT_ROW, arrived(key(vote)) && "animate-appear")}>
					<span className={cn(AUDIT_ICON, vote.verdict === "approve" ? "text-good" : "text-bad")}>
						<Icon name={vote.verdict === "approve" ? "check" : "x"} />
					</span>
					<div>
						<p className="m-0">
							<strong>{vote.reviewer}</strong> <span className="text-muted-foreground">({vote.role})</span>{" "}
							{vote.verdict === "approve" ? "approved" : "rejected"} <code>{shortSha(vote.commit)}</code>
							{vote.by ? <span className="text-muted-foreground"> · {identityName(vote.by)}</span> : null}
							<span className="text-muted-foreground"> · {timeAgo(vote.at)}</span>
							{vote.thin ? <span className="text-muted-foreground"> · thin evidence</span> : null}
						</p>
						{vote.evidence ? <p className="mt-0.5 mb-0 text-ui text-muted-foreground">{vote.evidence}</p> : null}
					</div>
				</li>
			))}
		</ul>
	);
}

/** The Audit tab: rules broken on the project's branch, read from Git, and the reviews recorded. */
export function AuditTab({ snapshot }: { snapshot: RepoSnapshot }) {
	const { audit, votes } = snapshot;
	// Once the records are replayed, what they found fades in where "Replaying" was.
	const replayed = useChanged(Boolean(audit));
	if (!audit)
		return (
			<p className="my-3.75 py-8 text-center text-muted-foreground" role="status">
				Replaying the records from Git…
			</p>
		);
	const open = audit.violations.filter((violation) => !violation.resolvedBy);
	const resolved = audit.violations.filter((violation) => violation.resolvedBy);
	const openHeadline = open.length ? counted(open.length, "open violation") : "No open violations";
	return (
		<div className={cn("grid max-w-225 gap-4", replayed && "animate-fade")}>
			<Callout tone={open.length ? "bad" : "good"}>
				<Icon
					name={open.length ? "alert" : "check-circle"}
					className={cn("transition-colors duration-base", open.length ? "text-bad" : "text-good")}
				/>
				<div>
					<strong>{openHeadline}</strong>
					<p className="text-muted-foreground">
						{audit.merges} {audit.merges === 1 ? "commit" : "commits"} on {snapshot.branch ?? "main"} since GitHive
						started on it.
						{audit.violations.length === 0 ? " No violations." : ""}
					</p>
				</div>
			</Callout>
			{open.length > 0 ? <Violations title="Open" violations={open} /> : null}
			{resolved.length > 0 ? <Violations title="Resolved" violations={resolved} /> : null}
			<Box>
				<BoxHeader>
					<h3 className="text-body-sm">Recent reviews</h3>
				</BoxHeader>
				<RecentReviews votes={votes} />
			</Box>
		</div>
	);
}

type Policy = RepoSnapshot["policy"];
type PathRule = NonNullable<Policy["escalate"]>[number];

/** A stricter rule for paths, in words: what touching them needs. */
function ruleWords(rule: PathRule, required: number) {
	const approvals = rule.required ?? required;
	const approvalWords = `${approvals} ${approvals === 1 ? "approval" : "approvals"}`;
	const blockers = rule.vetoes?.length ? `; ${rule.vetoes.join(", ")} can block` : "";
	return `${approvalWords}${blockers}`;
}

/** How changes merge, as terms in the Settings tab's list: for readers who can't change it. */
function MergePolicyTerms({ policy, verify }: { policy: Policy; verify: string[] }) {
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

/**
 * The Settings tab: how changes merge (for the repo's admins, `editor` to
 * change it; for everyone else, what it is), how the records are kept, and
 * who may do what (`access`).
 */
export function SettingsTab({
	snapshot,
	access,
	editor,
}: {
	snapshot: RepoSnapshot;
	/** Who may do what: the reader's permission, visibility, collaborators. */ access?: ReactNode;
	/** For the repo's admins: the form that changes how changes merge. */ editor?: ReactNode;
}) {
	const { policy, verify } = snapshot;
	const sharding = shardingSummary(snapshot);
	const votesSharding = votesShardingSummary(snapshot);
	return (
		<div className="grid max-w-205 gap-4">
			<Callout className="mb-2 text-ui">
				<Icon name="alert" className="text-muted-foreground" />
				<span>
					{editor
						? "Changes here apply to merges from now on: each merge is audited against the " +
							"settings in force when it merged. Agents can change them too, with the MCP " +
							"settings tool."
						: "The repo's admins set how changes merge, and every agent checks it itself. A role " +
							"can be granted to a team, as @org/team."}
				</span>
			</Callout>
			{editor}
			<Box>
				<BoxHeader>
					<h2 className="text-body-sm font-semibold">{editor ? "How the records are kept" : "How changes merge"}</h2>
				</BoxHeader>
				<BoxBody>
					<dl className={TERMS}>
						{editor ? null : <MergePolicyTerms policy={policy} verify={verify} />}
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
							Each change works in its own fork: agents can't write {snapshot.branch ?? "main"}; only the toolkit
							merges, once the conventions hold.
						</dd>
						{snapshot.github ? (
							<>
								<dt>GitHub</dt>
								<dd>{githubTerms(snapshot.github, snapshot.branch ?? "main")}</dd>
							</>
						) : null}
					</dl>
				</BoxBody>
			</Box>
			{/* Who may do what (RepoAdmin) takes the tab's smaller headings and paragraphs' spacing. */}
			{access ? <div className="[&_h2]:text-body-sm [&_h2]:font-semibold [&_p]:mt-0 [&_p]:mb-2">{access}</div> : null}
		</div>
	);
}
