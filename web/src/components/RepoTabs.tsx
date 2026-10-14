import { type ReactNode, useEffect, useRef, useState } from "react";
import type { LandedChange, RepoAudit, RepoLanding, RepoSnapshot } from "../api";
import { useAnnouncer } from "../hooks/useAnnouncer";
import { useArrivals } from "../hooks/useArrivals";
import { useChanged } from "../hooks/useChanged";
import { useStagger } from "../hooks/useStagger";
import { identityName } from "../lib/agent";
import { changeAt, violationWords } from "../lib/auditWords";
import {
	activeWords,
	arrivalWords,
	CHANGE_FILTERS,
	type ChangeFilter,
	changeList,
	FILTER_WORDS,
	openOn,
} from "../lib/changeList";
import type { Tone } from "../lib/changeStatus";
import {
	claimAgent,
	claimApprovalLabel,
	claimTitle,
	claimStatus,
	isFromGitHub,
	type Claim,
	type Vote,
} from "../lib/claimStatus";
import { leaseWords } from "../lib/lease";
import { briefPaths, shortSha, shortTitle } from "../lib/model";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import type { RepoPolicy } from "../lib/status";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icon";
import { LoadError } from "./LoadError";
import { StatusIcon, StatusPill, TONE_TEXT } from "./StatusPill";
import { Announcer } from "./ui/announcer";
import { Badge, Counter, Lamp } from "./ui/badge";
import { MergePolicyTerms, RecordsTerms } from "./PolicyTerms";
import { Box, BoxBody, BoxHeader, BoxTitle, Callout } from "./ui/box";
import { Button } from "./ui/button";
import { Empty } from "./ui/empty";
import { Input } from "./ui/field";
import { TERMS } from "./ui/manage";

export { ChangePage, type ChangePageProps } from "./ChangePage";
export { githubTerms } from "./PolicyTerms";

// No central server enforces a repo's rules, so these pages show who holds what, how reviews stand, and
// what the audit found in Git, including violations a revert has since resolved.

/** How a change's approvals look: blocked, approved, or still in review (see status.ts). */
function approvalLook(approval: Claim["approval"]): { tone: Tone; icon: IconName } {
	if (approval.vetoedBy.length) return { tone: "bad", icon: "x" };
	if (approval.approved) return { tone: "good", icon: "check" };
	return { tone: "accent", icon: "eye" };
}

/** The change's approvals; for someone who can vote on a change still short of them, a link to its vote form. */
function Approvals({ claim, repo, voting }: { claim: Claim; repo: string; voting: boolean }) {
	const { approval } = claim;
	if (!claim.head) return null;
	const { tone, icon } = approvalLook(approval);
	const look = cn(
		"inline-flex items-center gap-1 font-medium whitespace-nowrap transition-colors duration-base",
		TONE_TEXT[tone],
	);
	const counted = `${approval.approvals} of ${approval.required} approvals`;
	const label = (
		<>
			<Icon name={icon} size={14} />
			{claimApprovalLabel(claim)}
		</>
	);
	if (!voting || approval.approved || claim.trusted)
		return (
			<span className={look} title={counted}>
				{label}
			</span>
		);
	return (
		<a className={cn(look, "hover:underline")} href={href.review(repo, claim.change)} title={`${counted}: review it`}>
			{label}
		</a>
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
	settings,
	landing,
	repo,
	now,
	arrived,
	voting,
}: ChangeRowProps & { claim: Claim; arrived: boolean }) {
	const status = claimStatus(claim, votes, { settings, landing, now: now ?? Date.now() });
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
							<Icon name="folder" size={14} className={INLINE_ICON} />
							<span title={claim.paths.join("\n")}>{briefPaths(claim.paths)}</span>
						</span>
					) : null}
					{lease?.short ? (
						<span className={cn("whitespace-nowrap", lease.free && "text-warn")} title={lease.long}>
							{" · "}
							<Icon name="clock" size={14} className={INLINE_ICON} />
							{lease.short}
						</span>
					) : null}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-3.5 pt-0.5 text-meta to-720:ml-6.5 to-720:flex-wrap to-720:gap-y-1.5">
				<Approvals claim={claim} repo={repo} voting={voting} />
				{claim.head ? <code className="text-muted-foreground">{shortSha(claim.head)}</code> : null}
				<time
					className="text-right whitespace-nowrap text-muted-foreground to-720:text-left"
					dateTime={claim.active}
					title={`Last active ${new Date(claim.active).toLocaleString()}`}
				>
					{activeWords(claim.active, now)}
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
interface ChangeRowProps {
	votes: Vote[];
	/** The repo's review settings: each change is held to its own branch's policy. */
	settings: RepoPolicy;
	landing: Pick<RepoLanding, "checking"> | undefined;
	repo: string;
	now?: number;
	/** Whoever reads the list can vote on its changes. */
	voting: boolean;
}

function ChangeRows({
	claims,
	votes,
	settings,
	landing,
	repo,
	now,
	fades,
	voting,
}: ChangeRowProps & { claims: Claim[]; fades: boolean }) {
	const arrived = useArrivals(claims.map((claim) => claim.change));
	const staggers = useStagger(claims.length > 0);
	return (
		<ul className={cn("m-0 list-none p-0", staggers ? "stagger" : fades && "animate-fade")}>
			{claims.map((claim) => (
				<ChangeRow
					key={claim.change}
					claim={claim}
					votes={votes}
					settings={settings}
					landing={landing}
					repo={repo}
					now={now}
					arrived={arrived(claim.change)}
					voting={voting}
				/>
			))}
		</ul>
	);
}

/** One filter of the list: a pill with its count, ink-filled while it's the one shown. A link, so the address keeps it. */
function FilterChip({
	filter,
	count,
	current,
	link,
}: {
	filter: ChangeFilter;
	count: number;
	current: boolean;
	link: string;
}) {
	return (
		<a
			href={link}
			aria-current={current ? "true" : undefined}
			className={cn(
				"touch-target inline-flex items-center gap-1.5 rounded-full border border-input px-2.75 py-0.5",
				"text-ui font-semibold whitespace-nowrap text-muted-foreground no-underline",
				"transition-colors duration-fast hover:bg-surface-2 hover:text-foreground hover:no-underline",
				current && "border-primary bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
			)}
		>
			{FILTER_WORDS[filter]}
			<span
				className={cn(
					"font-normal tabular-nums",
					// What needs you, while anything does, in the color that asks for a person.
					filter === "needs-you" && count > 0 && !current && "font-semibold text-bad",
				)}
			>
				{count}
			</span>
		</a>
	);
}

/** What a filter shows when nothing on the branch is in it, or nothing it holds matches the search. */
function noneWords(filter: ChangeFilter, query: string, branch: string): string {
	if (query.trim()) {
		const among = filter === "all" ? "" : ` under ${FILTER_WORDS[filter]}`;
		return `No change on ${branch} matches “${query.trim()}”${among}.`;
	}
	const none: Record<ChangeFilter, string> = {
		"needs-you": "Nothing needs you",
		"needs-work": "Nothing needs work",
		"in-review": "No change is in review",
		approved: "No change is approved",
		building: "No change is being built",
		landing: "Nothing is landing",
		all: "No open changes",
	};
	return `${none[filter]} on ${branch}.`;
}

/**
 * The open changes on `shown` (the branch the tab shows; without it, every branch's), what needs action first, then
 * the one active last (changeList.ts): narrowed by a filter, a chip each with its count, and a search. Another
 * branch's list, another filter's, or the list in place of "No open changes" (or that in place of the list), fades
 * in; so does a change opened while it shows, which a screen reader hears of too.
 */
export function ChangeList({
	snapshot,
	repo,
	shown,
	landing,
	now,
	filter = "all",
	search = "",
	landed,
	voting = false,
}: {
	snapshot: RepoSnapshot;
	repo: string;
	shown?: string;
	/** What's being checked to land on the branch shown, so a change in the batch says it's landing. */
	landing?: Pick<RepoLanding, "checking">;
	/** The time leases and abandoned changes are told against (tests fix it). */
	now?: number;
	/** The filter the address asks for. */
	filter?: ChangeFilter;
	/** What the search starts with (tests set it). */
	search?: string;
	/** How many changes have landed on the project's branch, as History counts them, once it has. */
	landed?: number;
	/** The reader can vote, so a change short of approvals links to its vote form. */
	voting?: boolean;
}) {
	const project = snapshot.branch ?? "main";
	const branch = shown ?? project;
	const open = shown ? openOn(snapshot, shown) : snapshot.claims;
	const [query, setQuery] = useState(search);
	const context = { votes: snapshot.votes, settings: snapshot, landing, now: now ?? Date.now() };
	const { shown: listed, counts } = changeList(open, context, { filter, query });
	const claims = listed.map((each) => each.claim);
	const branchChanged = useChanged(shown);
	const filterChanged = useChanged(filter);
	const emptied = useChanged(open.length === 0);
	const fades = branchChanged || filterChanged || emptied;
	const { said, say } = useAnnouncer();
	useArrivalsSaid(open, branch, say);
	const linkTo = (to: ChangeFilter) =>
		href.changes(repo, {
			...(shown && shown !== project ? { branch: shown } : {}),
			...(to === "all" ? {} : { filter: to }),
		});
	const audit = branch === project ? (snapshot.audit?.open ?? 0) : 0;
	// History's count comes after the list: it fades in where there was none.
	const countArrived = useChanged(landed !== undefined);
	return (
		<Box aria-labelledby="changes-title">
			<BoxHeader>
				<h2
					id="changes-title"
					className="inline-flex items-center gap-1.5 py-0.5 text-title font-semibold text-foreground"
					aria-current="page"
				>
					<Icon name="pull" />
					<Bumping count={open.length} /> Open
				</h2>
				{landed !== undefined ? (
					<a
						href={href.repo(repo, "history")}
						className={cn(
							"inline-flex items-center gap-1.5 py-0.5 font-medium text-muted-foreground transition-colors duration-fast hover:text-foreground",
							countArrived && "animate-fade",
						)}
					>
						<Icon name="merge" />
						<Bumping count={landed} /> landed on {project}
					</a>
				) : null}
			</BoxHeader>
			{open.length > 0 ? (
				<div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 border-b border-border px-0.5 py-3">
					<nav aria-label="Show changes" className="min-w-0">
						<ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
							{CHANGE_FILTERS.map((each) => (
								<li key={each}>
									<FilterChip filter={each} count={counts[each]} current={each === filter} link={linkTo(each)} />
								</li>
							))}
						</ul>
					</nav>
					<div className="relative ml-auto w-64 to-720:ml-0 to-720:w-full">
						<Icon
							name="search"
							size={14}
							className="pointer-events-none absolute top-2.5 left-2.5 text-muted-foreground"
						/>
						<label className="sr-only" htmlFor="change-search">
							Find a change
						</label>
						<Input
							id="change-search"
							type="search"
							className="h-8.5 w-full pl-8 text-ui"
							placeholder="Title, id, agent or path…"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>
				</div>
			) : null}
			{audit ? (
				<p className="m-0 flex flex-wrap items-center gap-1.75 border-b border-border px-4 py-2.5 text-ui">
					<Lamp state="needs-person" />
					<a href={href.repo(repo, "audit")}>{counted(audit, "open audit violation")}</a>
				</p>
			) : null}
			{open.length === 0 ? (
				<Empty className={cn(fades && "animate-fade")}>
					<Icon name="pull" size={28} />
					<h2>No open changes</h2>
					<p>When an agent claims part of {repo} and starts work, its change appears here.</p>
				</Empty>
			) : claims.length === 0 ? (
				<p
					key={`${filter}:none`}
					className={cn("m-0 px-4 py-8 text-center text-muted-foreground", fades && "animate-fade")}
				>
					{noneWords(filter, query, branch)}
					{filter !== "all" && counts.all > 0 ? (
						<>
							{" "}
							<a href={linkTo("all")}>Show all {counts.all}</a>
						</>
					) : null}
					{query.trim() ? (
						<>
							{" "}
							<Button variant="link" className="align-baseline" onClick={() => setQuery("")}>
								Clear the search
							</Button>
						</>
					) : null}
				</p>
			) : (
				<ChangeRows
					key={`${shown}:${filter}`}
					claims={claims}
					votes={snapshot.votes}
					settings={snapshot}
					landing={landing}
					repo={repo}
					now={now}
					fades={fades}
					voting={voting}
				/>
			)}
			<Announcer said={said} />
		</Box>
	);
}

/**
 * Says what changes opened on the branch since the list first showed it, as they come: at most once every few
 * seconds (useAnnouncer). Another branch starts over, unsaid.
 */
function useArrivalsSaid(open: Claim[], branch: string, say: (words: string) => void) {
	const seen = useRef<{ branch: string; changes: Set<string> } | null>(null);
	const ids = open.map((claim) => claim.change).join("\n");
	useEffect(() => {
		const before = seen.current;
		seen.current = { branch, changes: new Set(open.map((claim) => claim.change)) };
		if (!before || before.branch !== branch) return;
		say(
			arrivalWords(
				open.filter((claim) => !before.changes.has(claim.change)),
				branch,
			),
		);
		// Keyed by the list's changes: a poll that brings the same ones says nothing.
	}, [ids, branch, say]);
}

// The audit's rows: an icon a little down the first line, then what it says; ruled off from the one above, the first
// from the box's header too.
const AUDIT_ROW = "flex items-start gap-2.5 border-t border-border px-0.5 py-3 wrap-anywhere";
const AUDIT_ICON = "mt-0.5 inline-flex shrink-0";

/** A commit's short hash, linked to the code at it. */
function CommitLink({ repo, commit }: { repo: string; commit: string }) {
	return (
		<a href={href.code(repo, "", commit)}>
			<code>{shortSha(commit)}</code>
		</a>
	);
}

function Violations({ repo, title, violations }: { repo: string; title: string; violations: RepoAudit["violations"] }) {
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
					<ViolationRow key={`${violation.commit}-${violation.rule}-${index}`} repo={repo} violation={violation} />
				))}
			</ul>
		</Box>
	);
}

/**
 * A rule broken, in words (auditWords.ts): by whom, in which commit, what was wrong, and, while it's open, what
 * someone can do about it; once resolved, the commit that resolved it. Each commit links to the code at it.
 */
function ViolationRow({ repo, violation }: { repo: string; violation: RepoAudit["violations"][number] }) {
	const by = violation.by ? identityName(violation.by) : "unverified";
	const { words, remedy } = violationWords(violation.rule);
	return (
		<li className={AUDIT_ROW}>
			<span className={cn(AUDIT_ICON, violation.resolvedBy ? "text-neutral" : "text-bad")}>
				<Icon name={violation.resolvedBy ? "check-circle" : "alert"} />
			</span>
			<div className="min-w-0">
				<p className="m-0">
					<strong>{words}</strong>
					{violation.resolvedBy ? (
						<>
							{" "}
							<Badge size="sm">Resolved</Badge>
						</>
					) : null}
				</p>
				<p className="mt-0.5 mb-0 text-ui text-muted-foreground">
					{violation.author} <span>({by})</span> in <CommitLink repo={repo} commit={violation.commit} />
					{" · "}
					<code className="text-caption">{violation.rule}</code>
				</p>
				<p className="mt-0.5 mb-0 max-w-measure text-ui text-muted-foreground">{violation.detail}</p>
				{violation.resolvedBy ? (
					<p className="mt-0.5 mb-0 text-ui text-muted-foreground">
						Resolved by <CommitLink repo={repo} commit={violation.resolvedBy} />
					</p>
				) : (
					<p className="mt-1.5 mb-0 max-w-measure text-ui">
						<strong className="font-semibold">What to do:</strong> {remedy}
					</p>
				)}
			</div>
		</li>
	);
}

/**
 * The reviews recorded, newest as the snapshot lists them, each naming the change it reviewed where its commit is a
 * change's head (open, or landed as History has it); one recorded since they first showed fades in.
 */
function RecentReviews({
	repo,
	votes,
	claims,
	landed,
}: {
	repo: string;
	votes: RepoSnapshot["votes"];
	claims: RepoSnapshot["claims"];
	landed: Pick<LandedChange, "change" | "title" | "head">[];
}) {
	const key = (vote: RepoSnapshot["votes"][number]) => `${vote.reviewer}-${vote.commit}-${vote.at}`;
	const arrived = useArrivals(votes.map(key));
	const staggers = useStagger(votes.length > 0);
	if (votes.length === 0) return <p className="my-3.75 px-0.5 py-3 text-muted-foreground">No reviews yet.</p>;
	return (
		<ul className={cn("m-0 list-none p-0", staggers && "stagger")}>
			{votes.map((vote) => {
				const change = changeAt(vote.commit, claims, landed);
				return (
					<li key={key(vote)} className={cn(AUDIT_ROW, arrived(key(vote)) && "animate-appear")}>
						<span className={cn(AUDIT_ICON, vote.verdict === "approve" ? "text-good" : "text-bad")}>
							<Icon name={vote.verdict === "approve" ? "check" : "x"} />
						</span>
						<div className="min-w-0">
							<p className="m-0">
								<strong>{vote.reviewer}</strong> <span className="text-muted-foreground">({vote.role})</span>{" "}
								{vote.verdict === "approve" ? "approved" : "rejected"}{" "}
								{change ? (
									<>
										<a href={href.change(repo, change.change)}>{shortTitle(change.title)}</a> at{" "}
									</>
								) : null}
								<CommitLink repo={repo} commit={vote.commit} />
								{vote.by ? <span className="text-muted-foreground"> · {identityName(vote.by)}</span> : null}
								<span className="text-muted-foreground"> · {timeAgo(vote.at)}</span>
								{vote.thin ? <span className="text-muted-foreground"> · thin evidence</span> : null}
							</p>
							{vote.evidence ? (
								<p className="mt-0.5 mb-0 max-w-measure text-ui text-muted-foreground">{vote.evidence}</p>
							) : null}
						</div>
					</li>
				);
			})}
		</ul>
	);
}

/**
 * The Audit tab: rules broken on the project's branch, read from Git, each in words with what to do, and the reviews
 * recorded, each naming its change. `landed` (History's) names the changes reviews of landed heads were for.
 */
export function AuditTab({
	repo,
	snapshot,
	landed = [],
	error,
	onRetry,
}: {
	repo: string;
	snapshot: RepoSnapshot;
	landed?: Pick<LandedChange, "change" | "title" | "head">[];
	/** Why the audit couldn't be read, while there's none to show. */
	error?: string;
	onRetry?: () => void;
}) {
	const { audit, votes } = snapshot;
	// Once the records are replayed, what they found, or why they couldn't be, fades in where "Replaying" was.
	const replayed = useChanged(audit ? "audit" : error ? "error" : "replaying");
	if (!audit) {
		if (error)
			return <LoadError what="The audit" error={error} onRetry={onRetry} className={cn(replayed && "animate-fade")} />;
		return (
			<p className="my-3.75 py-8 text-center text-muted-foreground" role="status">
				Replaying the records from Git…
			</p>
		);
	}
	const open = audit.violations.filter((violation) => !violation.resolvedBy);
	const resolved = audit.violations.filter((violation) => violation.resolvedBy);
	const openHeadline = open.length ? counted(open.length, "open violation") : "No open violations";
	return (
		<div className={cn("grid gap-4", replayed && "animate-fade")}>
			<Callout tone={open.length ? "bad" : "good"}>
				<Icon
					name={open.length ? "alert" : "check-circle"}
					className={cn("transition-colors duration-base", open.length ? "text-bad" : "text-good")}
				/>
				<div>
					<strong>{openHeadline}</strong>
					<p className="text-muted-foreground">
						{/* The audit reads every branch changes land on, not only the project's. */}
						{counted(audit.merges, "commit")} checked since GitHive started.
						{audit.violations.length === 0 ? " No violations." : ""}
					</p>
				</div>
			</Callout>
			{open.length > 0 ? <Violations repo={repo} title="Open" violations={open} /> : null}
			{resolved.length > 0 ? <Violations repo={repo} title="Resolved" violations={resolved} /> : null}
			<Box>
				<BoxHeader>
					<h3 className="text-body-sm">Recent reviews</h3>
				</BoxHeader>
				<RecentReviews repo={repo} votes={votes} claims={snapshot.claims} landed={landed} />
			</Box>
		</div>
	);
}

/**
 * The Settings tab for those who can't change it: how changes merge and how the records are kept, then who may do
 * what (`access`). The repo's admins get RepoSettings instead.
 */
export function SettingsTab({
	snapshot,
	access,
}: {
	snapshot: RepoSnapshot;
	/** Who may do what: the reader's permission and the repo's visibility. */ access?: ReactNode;
}) {
	return (
		<div className="grid gap-6">
			<Callout className="text-ui">
				<Icon name="alert" className="text-muted-foreground" />
				<span>
					The repo's admins set how changes merge, and every agent checks it itself. A role can be granted to a team, as
					@org/team.
				</span>
			</Callout>
			<Box aria-labelledby="settings-merge-title">
				<BoxHeader>
					<BoxTitle id="settings-merge-title">How changes land</BoxTitle>
				</BoxHeader>
				<BoxBody>
					<dl className={TERMS}>
						<MergePolicyTerms policy={snapshot.policy} verify={snapshot.verify} />
						<RecordsTerms snapshot={snapshot} />
					</dl>
				</BoxBody>
			</Box>
			{access}
		</div>
	);
}
