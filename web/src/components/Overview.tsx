import { messageOf } from "../lib/errors";
import "./Overview.css";
import { useState } from "react";
import type { RepoLanding, RepoSnapshot, RepoTree } from "../api";
import { usePoll } from "../hooks/usePoll";
import { HiveMap } from "./HiveMap";
import { Territory } from "./Territory";
import { LAMP_WORDS, lampColor, lampCounts, LAMPS } from "../lib/overview";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";

/**
 * What the overview reads: the repo's files and, when the server reports it, what's landing. People who can
 * write can also make a branch.
 */
export interface OverviewApi {
	tree(repo: string, ref?: string): Promise<RepoTree>;
	landing?(repo: string, branch: string): Promise<RepoLanding>;
	makeBranch?(repo: string, name: string, from: string): Promise<{ name: string; made?: string }>;
}

export interface OverviewProps {
	repo: string;
	/** The project's branch. */
	branch: string;
	/** The branch shown, when not the project's (from the address). */
	shown?: string;
	snapshot: RepoSnapshot;
	api: OverviewApi;
	/** May make branches (write). */
	canWrite?: boolean;
	/** After a branch is made: read the snapshot again. */
	onBranchMade?: () => void;
}

/** Which branch the overview shows, and making another (for people who can write). */
function BranchBar({
	repo,
	branch,
	shown,
	snapshot,
	api,
	canWrite,
	onBranchMade,
}: {
	repo: string;
	branch: string;
	shown: string;
	snapshot: RepoSnapshot;
	api: OverviewApi;
	canWrite: boolean;
	onBranchMade?: () => void;
}) {
	const names = [
		branch,
		...(snapshot.branches ?? [])
			.map((known) => known.name)
			.filter((other) => other !== branch)
			.sort(),
	];
	const [making, setMaking] = useState(false);
	const [name, setName] = useState("");
	const [from, setFrom] = useState(shown);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const showBranch = (to: string) => {
		window.location.hash = href.repo(repo, "changes", to === branch ? undefined : to);
	};
	const make = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!api.makeBranch || !name.trim()) return;
		setBusy(true);
		setError(null);
		try {
			const made = await api.makeBranch(repo, name.trim(), from);
			setMaking(false);
			setName("");
			onBranchMade?.();
			showBranch(made.name);
		} catch (err) {
			setError(messageOf(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="branch-bar">
			<label className="branch-bar__pick">
				<span>Branch</span>
				<select id="overview-branch" value={shown} onChange={(event) => showBranch(event.target.value)}>
					{names.map((branchName) => (
						<option key={branchName} value={branchName}>
							{branchName}
							{branchName === branch ? " (project)" : ""}
						</option>
					))}
				</select>
			</label>
			{canWrite && api.makeBranch && !making ? (
				<button type="button" onClick={() => setMaking(true)}>
					New branch
				</button>
			) : null}
			{making ? (
				<form className="branch-bar__new" onSubmit={make}>
					<label className="sr-only" htmlFor="new-branch-name">
						Name of the new branch
					</label>
					<input
						id="new-branch-name"
						placeholder="feature/checkout"
						value={name}
						onChange={(event) => setName(event.target.value)}
						autoFocus
					/>
					<label htmlFor="new-branch-from">from</label>
					<select id="new-branch-from" value={from} onChange={(event) => setFrom(event.target.value)}>
						{names.map((branchName) => (
							<option key={branchName} value={branchName}>
								{branchName}
							</option>
						))}
					</select>
					<button type="submit" className="accent" disabled={busy || !name.trim()}>
						{busy ? "Making…" : "Make branch"}
					</button>
					<button type="button" onClick={() => setMaking(false)} disabled={busy}>
						Cancel
					</button>
				</form>
			) : null}
			{error ? (
				<p className="error branch-bar__error" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}

/** How each outcome lights. */
const SETTLED_COLOR: Record<RepoLanding["recent"][number]["how"], "green" | "red"> = { landed: "green", failed: "red" };

/** The claims in force, in a sentence: how many, and where their changes are. */
function Summary({ snapshot, landing }: { snapshot: RepoSnapshot; landing?: RepoLanding }) {
	const total = snapshot.claims.length;
	if (!total)
		return (
			<p className="overview__summary">
				No claims in force. When an agent claims part of the tree, it lights up below.
			</p>
		);
	const counts = lampCounts(snapshot.claims, { landing, votes: snapshot.votes });
	const parts = LAMPS.filter((lamp) => counts[lamp]).map((lamp) => (
		<span key={lamp} className={`overview__count lamp--${lampColor(lamp)}`}>
			<span className="lamp" aria-hidden="true" />
			{counts[lamp]} {lamp === "attention" && counts[lamp] > 1 ? "need a person" : LAMP_WORDS[lamp]}
		</span>
	));
	return (
		<p className="overview__summary">
			<strong>
				{total} {total === 1 ? "claim" : "claims"} in force
			</strong>
			{parts}
		</p>
	);
}

/** What goes before the item at `index` in a list of `length` read as a sentence: nothing, a comma, or "and". */
function listSeparator(index: number, length: number): string | null {
	if (!index) return null;
	return index === length - 1 ? " and " : ", ";
}

/**
 * What's landing on the branch, drawn as a track into it: the changes being
 * checked together nearest it, the approved ones waiting for the next batch.
 */
function Track({
	repo,
	branch,
	snapshot,
	landing,
	error,
}: {
	repo: string;
	branch: string;
	snapshot: RepoSnapshot;
	landing?: RepoLanding;
	error?: string;
}) {
	const checking = landing?.checking?.changes ?? [];
	const inBatch = new Set(checking.map((checked) => checked.change));
	const waiting = snapshot.claims.filter((claim) => claim.approval.approved && !inBatch.has(claim.change)).length;
	// Each change's last outcome, newest first.
	const lastOutcomes = new Map((landing?.recent ?? []).map((outcome) => [outcome.change, outcome]));
	const recent = [...lastOutcomes.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
	return (
		<section className="track" aria-labelledby="track-title">
			<div className="overview__head">
				<h2 id="track-title">Landing</h2>
				<p className="muted">
					Approved changes land on {branch} together: checked once as a batch
					{snapshot.verify.length ? " by running " : ""}
					{snapshot.verify.map((command, index) => (
						<span key={command}>
							{listSeparator(index, snapshot.verify.length)}
							<code className="nowrap">{command}</code>
						</span>
					))}
					, then landed in one push.
				</p>
			</div>
			{error && !landing ? <p className="muted">What's landing couldn't be read: {error}</p> : null}
			<ol className="track__plan">
				<li className="track__end">
					<span className="track__buffer" aria-hidden="true" />
					<span className="track__name">{branch}</span>
					{landing?.checking ? <code className="track__detail">{landing.checking.base.slice(0, 7)}</code> : null}
				</li>
				{checking.map((checked) => (
					<li key={checked.change} className="track__station lamp--amber">
						<span className="lamp lamp--track" aria-hidden="true" />
						<a className="track__name" href={href.change(repo, checked.change)}>
							{checked.change}
						</a>
						<span className="track__detail">checking</span>
						<span className="track__detail muted">{checked.agent}</span>
					</li>
				))}
				{waiting ? <li className="track__waiting">{waiting} approved, landing with the next batch</li> : null}
			</ol>
			{landing && !checking.length ? (
				<p className="track__empty muted">
					Nothing being checked. Approved changes land with the next batch, once one of them merges.
				</p>
			) : null}
			{recent.length ? (
				<div className="track__left">
					<h3>Lately</h3>
					<ul>
						{recent.map((outcome) => (
							<li key={`${outcome.change}-${outcome.at}`} className={`lamp--${SETTLED_COLOR[outcome.how]}`}>
								<span className="lamp" aria-hidden="true" />
								<a href={href.change(repo, outcome.change)}>{outcome.change}</a>{" "}
								{outcome.how === "landed" ? "landed" : "put out: its checks failed"}{" "}
								<span className="muted">{timeAgo(outcome.at)}</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}

/**
 * A repo at a glance, on one of its branches: the claims on it in a sentence,
 * what's landing on it, its hive map and its territory.
 */
export function Overview({ repo, branch, shown: asked, snapshot, api, canWrite = false, onBranchMade }: OverviewProps) {
	const known =
		asked === undefined || asked === branch || (snapshot.branches ?? []).some((other) => other.name === asked);
	const shown = asked && known ? asked : branch;
	const otherBranch = shown === branch ? undefined : shown;
	const landing = usePoll(api.landing ? `landing:${repo}:${shown}` : null, () => api.landing!(repo, shown), 5_000);
	const tree = usePoll(`tree:${repo}:${shown}`, () => api.tree(repo, otherBranch), 60_000);
	// Only the claims on this branch, since each change lands on one branch.
	const onBranch = { ...snapshot, claims: snapshot.claims.filter((claim) => (claim.into ?? branch) === shown) };
	const manyBranches = (snapshot.branches ?? []).length > 0 || canWrite;
	return (
		<div className="overview">
			{manyBranches ? (
				<BranchBar
					repo={repo}
					branch={branch}
					shown={shown}
					snapshot={snapshot}
					api={api}
					canWrite={canWrite}
					onBranchMade={onBranchMade}
				/>
			) : null}
			{!known ? (
				<p className="callout callout--warn">
					There's no branch {asked} taking changes here: showing {branch}.
				</p>
			) : null}
			<Summary snapshot={onBranch} landing={landing.data} />
			{api.landing ? (
				<Track repo={repo} branch={shown} snapshot={onBranch} landing={landing.data} error={landing.error} />
			) : null}
			<HiveMap
				repo={repo}
				branch={shown}
				snapshot={onBranch}
				tree={tree.data}
				error={tree.error}
				landing={landing.data}
			/>
			<Territory
				repo={repo}
				branch={shown}
				snapshot={onBranch}
				tree={tree.data}
				error={tree.error}
				landing={landing.data}
			/>
		</div>
	);
}
