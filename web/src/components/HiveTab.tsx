import type { RepoLanding, RepoSnapshot, RepoTree } from "../api";
import { usePoll } from "../hooks/usePoll";
import { type HiveActivity, type HiveState, hiveActivity, hiveCounts } from "../lib/hive";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { HiveMap } from "./HiveMap";
import { LandingTrack } from "./LandingTrack";
import "./HiveTab.css";

export interface HiveApi {
	tree(repo: string, ref?: string): Promise<RepoTree>;
	landing?: (repo: string, branch: string) => Promise<RepoLanding>;
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
			showsLanding={!!load}
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
	/** The time "ago" counts from (tests fix it). */
	now?: number;
}

/** The hive as drawn, from what's been loaded. */
export function Hive(props: HiveProps) {
	const { repo, branch, snapshot, landing, now = Date.now() } = props;
	const rows = hiveActivity(snapshot, landing, now);
	return (
		<div className="hive-tab">
			<Headline rows={rows} />
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
			<AgentsAtWork repo={repo} rows={rows} now={now} />
		</div>
	);
}

function Headline({ rows }: { rows: HiveActivity[] }) {
	const counts = hiveCounts(rows);
	if (!counts.agents) {
		return (
			<header className="hive-tab__head">
				<h2>No agents in the hive yet</h2>
				<p className="muted">Connect one from the Agents page: it claims work here, and shows up as it does.</p>
			</header>
		);
	}
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
