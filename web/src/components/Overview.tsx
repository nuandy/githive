import "./Overview.css";
import { useState } from "react";
import type { RepoLine, RepoSnapshot, RepoTree } from "../api";
import { usePoll } from "../hooks/usePoll";
import { type Cell, cellLamp, LAMP_WORDS, type Lamp, lampColor, lampCounts, LAMPS, type Region, territory } from "../lib/overview";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";

/** What the overview reads: the repo's files, and its line when the server has one; and, for people who can write, making a branch. */
export interface OverviewApi {
	tree(repo: string, ref?: string): Promise<RepoTree>;
	line?(repo: string, branch?: string): Promise<RepoLine>;
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
function BranchBar({ repo, branch, shown, snapshot, api, canWrite, onBranchMade }: { repo: string; branch: string; shown: string; snapshot: RepoSnapshot; api: OverviewApi; canWrite: boolean; onBranchMade?: () => void }) {
	const names = [branch, ...(snapshot.branches ?? []).map((b) => b.name).filter((n) => n !== branch).sort()];
	const [making, setMaking] = useState(false);
	const [name, setName] = useState("");
	const [from, setFrom] = useState(shown);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const go = (to: string) => {
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
			go(made.name);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="branch-bar">
			<label className="branch-bar__pick">
				<span>Branch</span>
				<select id="overview-branch" value={shown} onChange={(event) => go(event.target.value)}>
					{names.map((n) => (
						<option key={n} value={n}>
							{n}
							{n === branch ? " (project)" : ""}
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
					<input id="new-branch-name" placeholder="feature/checkout" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
					<label htmlFor="new-branch-from">from</label>
					<select id="new-branch-from" value={from} onChange={(event) => setFrom(event.target.value)}>
						{names.map((n) => (
							<option key={n} value={n}>
								{n}
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

/** A region with no more entries than this lists them by name; a bigger one is a grid of lamps. */
const NAMED_CELLS = 16;

const LEFT_COLOR: Record<RepoLine["left"][number]["how"], "green" | "red" | "neutral"> = {
	landed: "green",
	failed: "red",
	"gave up": "neutral",
	"went quiet": "neutral",
	"behind one that left": "neutral",
};

/** The claims in force, in a sentence: how many, and where their changes are. */
function Summary({ snapshot, line }: { snapshot: RepoSnapshot; line?: RepoLine }) {
	const total = snapshot.claims.length;
	if (!total) return <p className="overview__summary">No claims in force. When an agent claims part of the tree, it lights up below.</p>;
	const counts = lampCounts(snapshot.claims, { ...(line ? { line } : {}), votes: snapshot.votes });
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

/** The line of merges, drawn as a track into the project's branch: the next to land nearest it. */
function Track({ repo, branch, snapshot, line, error }: { repo: string; branch: string; snapshot: RepoSnapshot; line?: RepoLine; error?: string }) {
	const inLine = new Set(line?.entries.map((e) => e.change));
	const waiting = snapshot.claims.filter((c) => c.approval.approved && !inLine.has(c.change)).length;
	// The last time each change left (one that left behind another, then landed, shows as landed), newest first.
	const left = [...new Map((line?.left ?? []).map((l) => [l.change, l])).values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
	return (
		<section className="track" aria-labelledby="track-title">
			<div className="overview__head">
				<h2 id="track-title">Merge line</h2>
				<p className="muted">
					Changes land on {branch} in this order, each checked on top of the ones ahead of it
					{snapshot.verify.length ? " by running " : ""}
					{snapshot.verify.map((command, i) => (
						<span key={command}>
							{i ? (i === snapshot.verify.length - 1 ? " and " : ", ") : null}
							<code className="nowrap">{command}</code>
						</span>
					))}
					.
				</p>
			</div>
			{error && !line ? <p className="muted">The line couldn't be read: {error}</p> : null}
			<ol className="track__plan">
				<li className="track__end">
					<span className="track__buffer" aria-hidden="true" />
					<span className="track__name">{branch}</span>
					{line?.tip ? <code className="track__detail">{line.tip.slice(0, 7)}</code> : null}
				</li>
				{line?.entries.map((entry, index) => (
					<li key={entry.id} className={`track__station lamp--${entry.status === "passed" ? "green" : "amber"}`}>
						<span className="lamp lamp--track" aria-hidden="true" />
						<a className="track__name" href={href.change(repo, entry.change)}>
							{entry.change}
						</a>
						<span className="track__detail">{entry.status === "passed" ? "passed, landing" : "checking"}</span>
						<span className="track__detail muted">{index === 0 ? "lands next" : `${index + 1} to land`}, {entry.agent}</span>
					</li>
				))}
				{waiting ? (
					<li className="track__waiting">
						{waiting} approved, not in line yet
					</li>
				) : null}
			</ol>
			{line && !line.entries.length ? <p className="track__empty muted">Nothing in line. An approved change joins it when its agent merges.</p> : null}
			{left.length ? (
				<div className="track__left">
					<h3>Recently left the line</h3>
					<ul>
						{left.map((l) => (
							<li key={`${l.change}-${l.at}`} className={`lamp--${LEFT_COLOR[l.how]}`}>
								<span className="lamp" aria-hidden="true" />
								<a href={href.change(repo, l.change)}>{l.change}</a> {l.how} <span className="muted">{timeAgo(l.at)}</span>
							</li>
						))}
					</ul>
				</div>
			) : null}
		</section>
	);
}

/** What a cell says to someone who can't see its lamp. */
function cellLabel(cell: Cell, region: Region): string {
	const holder = cell.holders[0] ?? region.whole[0];
	const what = `${cell.path}${cell.planned ? " (new)" : ""}`;
	if (!holder) return `${what}: not claimed`;
	const others = cell.holders.length > 1 ? `, and ${cell.holders.length - 1} more` : "";
	return `${what}: ${holder.title} by ${holder.agent}, ${LAMP_WORDS[holder.lamp]}${others}`;
}

function CellMark({ lamp }: { lamp: Lamp | undefined }) {
	return <span className={lamp ? `cell cell--${lamp} lamp--${lampColor(lamp)}` : "cell"} aria-hidden="true" />;
}

/** One top-level folder: its entries named, or as a grid of lamps when there are many. */
function RegionView({ repo, region }: { repo: string; region: Region }) {
	const held = region.cells.filter((c) => cellLamp(c, region)).length;
	const shown = region.cells.slice(0, 400);
	const named = region.cells.length <= NAMED_CELLS;
	const linkOf = (cell: Cell) => {
		const holder = cell.holders[0] ?? region.whole[0];
		return holder ? href.change(repo, holder.change) : href.code(repo, cell.path);
	};
	return (
		<section
			className={`region${named ? " region--named" : " region--grid"}`}
			// A grid is about square: as many columns as fit twice its rows (each cell 18px with its gap).
			style={named ? undefined : { width: `${Math.ceil(Math.sqrt(shown.length * 2)) * 18}px` }}
		>
			<h3 className="region__name">
				<code>{region.name ? `${region.name}/` : "top level"}</code>
				<span className="muted">
					{region.files ? `${region.files} ${region.files === 1 ? "file" : "files"}` : "new"}
					{held ? `, ${held} held` : ""}
				</span>
			</h3>
			{region.whole.length ? (
				<p className={`region__whole lamp--${lampColor(region.whole[0].lamp)}`}>
					<span className="lamp" aria-hidden="true" />
					<a href={href.change(repo, region.whole[0].change)}>{region.whole[0].title}</a> holds all of it, {LAMP_WORDS[region.whole[0].lamp]}
				</p>
			) : null}
			{named ? (
				<ul className="region__list">
					{shown.map((cell) => {
						const holder = cell.holders[0] ?? region.whole[0];
						return (
							<li key={cell.path}>
								<CellMark lamp={cellLamp(cell, region)} />
								<a href={linkOf(cell)} className={`region__entry${cellLamp(cell, region) ? " region__entry--held" : ""}`} title={cellLabel(cell, region)}>
									{cell.name}
									{cell.folder ? "/" : ""}
								</a>
								{holder && cell.holders.length ? <span className="region__holder muted">{holder.agent}</span> : null}
							</li>
						);
					})}
				</ul>
			) : (
				<ul className="region__grid">
					{shown.map((cell) => (
						<li key={cell.path}>
							<a href={linkOf(cell)} aria-label={cellLabel(cell, region)} title={cellLabel(cell, region)}>
								<CellMark lamp={cellLamp(cell, region)} />
							</a>
						</li>
					))}
				</ul>
			)}
			{region.cells.length > shown.length ? <p className="muted region__more">and {region.cells.length - shown.length} more</p> : null}
		</section>
	);
}

/** What agents hold of the tree, by top-level folder. */
function Territory({ repo, branch, snapshot, tree, error, line }: { repo: string; branch: string; snapshot: RepoSnapshot; tree?: RepoTree; error?: string; line?: RepoLine }) {
	const regions = tree ? territory(tree.files, snapshot.claims, { ...(line ? { line } : {}), votes: snapshot.votes }) : [];
	return (
		<section className="territory" aria-labelledby="territory-title">
			<div className="overview__head">
				<h2 id="territory-title">Territory</h2>
				<p className="muted">What agents hold of {branch}, by folder. A lit entry is claimed; its lamp says where the change is.</p>
			</div>
			<ul className="territory__legend" aria-label="What the lamps mean">
				{LAMPS.map((lamp) => (
					<li key={lamp}>
						<CellMark lamp={lamp} />
						{LAMP_WORDS[lamp]}
					</li>
				))}
				<li>
					<CellMark lamp={undefined} />
					not claimed
				</li>
			</ul>
			{!tree ? <p className="muted">{error ? `The tree couldn't be read: ${error}` : "Reading the tree…"}</p> : null}
			{tree?.truncated ? <p className="muted">This repo is large: the territory shows the first part of its tree.</p> : null}
			{regions.length ? (
				<div className="territory__regions">
					{regions.map((region) => (
						<RegionView key={region.name || "/"} repo={repo} region={region} />
					))}
				</div>
			) : null}
		</section>
	);
}

/**
 * A repo at a glance, on one of its branches: the claims on it in a sentence,
 * its line of merges, and its territory.
 */
export function Overview({ repo, branch, shown: asked, snapshot, api, canWrite = false, onBranchMade }: OverviewProps) {
	const known = asked === undefined || asked === branch || (snapshot.branches ?? []).some((b) => b.name === asked);
	const shown = asked && known ? asked : branch;
	const other = shown === branch ? undefined : shown;
	const line = usePoll(api.line ? `line:${repo}:${shown}` : null, () => api.line!(repo, other), 5_000);
	const tree = usePoll(`tree:${repo}:${shown}`, () => api.tree(repo, other), 60_000);
	// The claims on this branch only: a change lands on one.
	const onBranch = { ...snapshot, claims: snapshot.claims.filter((c) => (c.into ?? branch) === shown) };
	const many = (snapshot.branches ?? []).length > 0 || canWrite;
	return (
		<div className="overview">
			{many ? <BranchBar repo={repo} branch={branch} shown={shown} snapshot={snapshot} api={api} canWrite={canWrite} {...(onBranchMade ? { onBranchMade } : {})} /> : null}
			{!known ? <p className="callout callout--warn">There's no branch {asked} taking changes here: showing {branch}.</p> : null}
			<Summary snapshot={onBranch} line={line.data} />
			{api.line ? <Track repo={repo} branch={shown} snapshot={onBranch} line={line.data} error={line.error} /> : null}
			<Territory repo={repo} branch={shown} snapshot={onBranch} tree={tree.data} error={tree.error} line={line.data} />
		</div>
	);
}
