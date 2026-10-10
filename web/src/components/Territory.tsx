import "./Overview.css";
import type { RepoLanding, RepoSnapshot, RepoTree } from "../api";
import { type Cell, cellLamp, LAMP_WORDS, type Lamp, lampColor, LAMPS, type Region, territory } from "../lib/overview";
import { counted } from "../lib/plural";
import { href } from "../lib/routes";

/** A region with no more entries than this lists them by name; a bigger one is a grid of lamps. */
const NAMED_CELLS = 16;

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
	const held = region.cells.filter((cell) => cellLamp(cell, region)).length;
	const shown = region.cells.slice(0, 400);
	const named = region.cells.length <= NAMED_CELLS;
	const wholeHolder = region.whole[0];
	const linkOf = (cell: Cell) => {
		const holder = cell.holders[0] ?? region.whole[0];
		return holder ? href.change(repo, holder.change) : href.code(repo, cell.path);
	};
	return (
		<section
			className={`region${named ? " region--named" : " region--grid"}`}
			// Keep the grid about square, with about twice as many columns as rows. Each cell is 18px with its gap.
			style={named ? undefined : { width: `${Math.ceil(Math.sqrt(shown.length * 2)) * 18}px` }}
		>
			<h3 className="region__name">
				<code>{region.name ? `${region.name}/` : "top level"}</code>
				<span className="muted">
					{region.files ? counted(region.files, "file") : "new"}
					{held ? `, ${held} held` : ""}
				</span>
			</h3>
			{wholeHolder ? (
				<p className={`region__whole lamp--${lampColor(wholeHolder.lamp)}`}>
					<span className="lamp" aria-hidden="true" />
					<a href={href.change(repo, wholeHolder.change)}>{wholeHolder.title}</a> holds all of it,{" "}
					{LAMP_WORDS[wholeHolder.lamp]}
				</p>
			) : null}
			{named ? (
				<ul className="region__list">
					{shown.map((cell) => {
						const holder = cell.holders[0] ?? region.whole[0];
						return (
							<li key={cell.path}>
								<CellMark lamp={cellLamp(cell, region)} />
								<a
									href={linkOf(cell)}
									className={`region__entry${cellLamp(cell, region) ? " region__entry--held" : ""}`}
									title={cellLabel(cell, region)}
								>
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
			{region.cells.length > shown.length ? (
				<p className="muted region__more">and {region.cells.length - shown.length} more</p>
			) : null}
		</section>
	);
}

/** What agents hold of the tree, by top-level folder. */
export function Territory({
	repo,
	branch,
	snapshot,
	tree,
	error,
	landing,
}: {
	repo: string;
	branch: string;
	snapshot: RepoSnapshot;
	tree?: RepoTree;
	error?: string;
	landing?: RepoLanding;
}) {
	const regions = tree ? territory(tree.files, snapshot.claims, { landing, votes: snapshot.votes }) : [];
	const treeStatus = error ? `The tree couldn't be read: ${error}` : "Reading the tree…";
	return (
		<section className="territory" aria-labelledby="territory-title">
			<div className="overview__head">
				<h2 id="territory-title">Territory</h2>
				<p className="muted">
					What agents hold of {branch}, by folder. A lit entry is claimed; its lamp says where the change is.
				</p>
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
			{!tree ? <p className="muted">{treeStatus}</p> : null}
			{tree?.truncated ? (
				<p className="muted">This repo is large: the territory shows the first part of its tree.</p>
			) : null}
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
