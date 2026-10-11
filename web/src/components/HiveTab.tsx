import type { HiveEvent, LandingStretch, RepoAudit, RepoLanding, RepoSnapshot, RepoTree } from "../api";
import { useEffect } from "react";
import { usePoll } from "../hooks/usePoll";
import { type HiveActivity, type HiveState, hiveActivity, hiveCounts } from "../lib/hive";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { justFinished, stretchWords } from "../lib/stretch";
import { HiveFeed } from "./HiveFeed";
import { HiveMap } from "./HiveMap";
import { LandingTrack } from "./LandingTrack";
import "./HiveTab.css";

export interface HiveApi {
	tree(repo: string, ref?: string): Promise<RepoTree>;
	landing?: (repo: string, branch: string) => Promise<RepoLanding>;
	events?: (repo: string) => Promise<{ events: HiveEvent[] }>;
}

/** The Hive tab: the agents working on the repo's branch, what each is doing, and what's landing. */
export function HiveTab({
	repo,
	branch,
	snapshot,
	api,
}: {
	repo: string;
	branch: string;
	snapshot: RepoSnapshot;
	api: HiveApi;
}) {
	const load = api.landing;
	const landing = usePoll(load ? `landing:${repo}:${branch}` : null, () => load!(repo, branch), 5_000);
	const tree = usePoll(`tree:${repo}:${branch}`, () => api.tree(repo), 60_000);
	const loadEvents = api.events;
	const events = usePoll(loadEvents ? `events:${repo}` : null, () => loadEvents!(repo), 10_000);
	// The snapshot is read again on each ping from the live feed, so the events follow it.
	const refreshEvents = events.refresh;
	useEffect(() => refreshEvents(), [snapshot.claims, refreshEvents]);
	// Only the claims landing on this branch: each change lands on one branch.
	const onBranch = { ...snapshot, claims: snapshot.claims.filter((claim) => (claim.into ?? branch) === branch) };
	return (
		<Hive
			repo={repo}
			branch={branch}
			snapshot={onBranch}
			{...(landing.data ? { landing: landing.data } : {})}
			{...(landing.error ? { landingError: String(landing.error) } : {})}
			{...(tree.data ? { tree: tree.data } : {})}
			{...(tree.error ? { treeError: String(tree.error) } : {})}
			{...(events.data ? { events: events.data.events } : {})}
			{...(events.error ? { eventsError: String(events.error) } : {})}
			showsLanding={!!load}
			showsFeed={!!loadEvents}
		/>
	);
}

export interface HiveProps {
	repo: string;
	branch: string;
	snapshot: RepoSnapshot;
	landing?: RepoLanding;
	landingError?: string;
	tree?: RepoTree;
	treeError?: string;
	showsLanding?: boolean;
	events?: HiveEvent[];
	eventsError?: string;
	showsFeed?: boolean;
	/** The time "ago" counts from (tests fix it). */
	now?: number;
}

/** The hive as drawn, from what's been loaded. */
export function Hive(props: HiveProps) {
	const { repo, branch, snapshot, landing, now = Date.now() } = props;
	const rows = hiveActivity(snapshot, landing, now);
	return (
		<div className="hive-tab">
			<Headline
				repo={repo}
				rows={rows}
				open={snapshot.claims.length}
				{...(landing?.stretch ? { stretch: landing.stretch } : {})}
				{...(snapshot.audit ? { audit: snapshot.audit } : {})}
				now={now}
			/>
			<div className="hive-tab__grid">
				<HiveMap
					repo={repo}
					branch={branch}
					snapshot={snapshot}
					{...(props.tree ? { tree: props.tree } : {})}
					{...(props.treeError ? { error: props.treeError } : {})}
					{...(landing ? { landing } : {})}
					now={now}
				/>
				{props.showsLanding ? (
					<LandingTrack
						repo={repo}
						branch={branch}
						snapshot={snapshot}
						{...(landing ? { landing } : {})}
						{...(props.landingError ? { error: props.landingError } : {})}
					/>
				) : null}
			</div>
			<div className="hive-tab__grid">
				<AgentsAtWork repo={repo} rows={rows} now={now} />
				{props.showsFeed ? (
					<HiveFeed
						repo={repo}
						snapshot={snapshot}
						{...(props.events ? { events: props.events } : {})}
						{...(props.eventsError ? { error: props.eventsError } : {})}
						now={now}
					/>
				) : null}
			</div>
		</div>
	);
}

interface HeadlineProps {
	repo: string;
	rows: HiveActivity[];
	/** Claims in force. */
	open: number;
	stretch?: LandingStretch;
	audit?: RepoAudit;
	now: number;
}

/** Who's at work and doing what; once a stretch of work has landed and nothing's open, that it's all done. */
function Headline({ repo, rows, open, stretch, audit, now }: HeadlineProps) {
	if (!open && justFinished(stretch, now)) return <AllLanded repo={repo} stretch={stretch} audit={audit} now={now} />;
	const counts = hiveCounts(rows);
	if (!counts.agents) return <EmptyHive stretch={stretch} now={now} />;
	const parts = [
		counted(counts.building, "building", "building"),
		counted(counts.inReview, "in review", "in review"),
		counted(counts.landing, "landing", "landing"),
	];
	return (
		<header className="hive-tab__head">
			<h2>
				{counted(counts.agents, "agent")} in the hive · {parts.join(" · ")}
			</h2>
			<p className="muted">
				No queen: nothing assigns the work. Each agent claims its own, and every claim, vote and landing is a record in
				Git.
			</p>
		</header>
	);
}

/** The recap once a stretch of work has landed: how much, how fast, by how many, and what the audit says. */
function AllLanded({
	repo,
	stretch,
	audit,
	now,
}: {
	repo: string;
	stretch: LandingStretch;
	audit?: RepoAudit;
	now: number;
}) {
	return (
		<header className="hive-tab__head hive-tab__head--done">
			<h2>
				<span className="tone-good">✓ All landed.</span> The hive is quiet.
			</h2>
			<p className="muted">
				{stretchWords(stretch)}, finished {timeAgo(stretch.to, now)}. <AuditWords repo={repo} audit={audit} />{" "}
				<a href={href.repo(repo, "history")}>See what landed</a>
			</p>
		</header>
	);
}

/** What the audit found, in a sentence: nothing, or how many merges to look at. */
function AuditWords({ repo, audit }: { repo: string; audit?: RepoAudit }) {
	if (!audit) return null;
	if (!audit.open) return <>The audit is clean.</>;
	return (
		<a href={href.repo(repo, "audit")} className="tone-bad">
			{counted(audit.open, "merge")} for the audit to look at.
		</a>
	);
}

/** No agent at work: how to bring one in, or when the last work finished. */
function EmptyHive({ stretch, now }: { stretch?: LandingStretch; now: number }) {
	return (
		<header className="hive-tab__head">
			<h2>No agents in the hive {stretch ? "now" : "yet"}</h2>
			<p className="muted">
				{stretch ? `Its last stretch of work finished ${timeAgo(stretch.to, now)}: ${stretchWords(stretch)}. ` : ""}
				Connect an agent from the Agents page: it claims work here, and shows up as it does.
			</p>
		</header>
	);
}

const STATE_WORDS: Record<HiveState, string> = {
	building: "building",
	revising: "revising",
	"in-review": "in review",
	asking: "asking a person",
	landing: "landing",
	waiting: "waiting to land",
	reviewed: "reviewing",
};

function AgentsAtWork({ repo, rows, now }: { repo: string; rows: HiveActivity[]; now: number }) {
	if (!rows.length) return null;
	return (
		<section className="box hive-tab__agents" aria-labelledby="hive-agents">
			<div className="box__header">
				<h2 id="hive-agents">Agents</h2>
			</div>
			<ul className="hive-tab__rows">
				{rows.map((row) => (
					<li key={`${row.agent}:${row.change}`} className={`hive-tab__row hive-tab__row--${row.state}`}>
						<strong className="hive-tab__agent">{row.agent}</strong>
						<span className="hive-tab__state">{STATE_WORDS[row.state]}</span>
						<a href={href.change(repo, row.change)}>{row.change}</a>
						<span className="muted">{row.detail}</span>
						<time className="muted hive-tab__when" dateTime={row.at}>
							{timeAgo(row.at, now)}
						</time>
					</li>
				))}
			</ul>
		</section>
	);
}
