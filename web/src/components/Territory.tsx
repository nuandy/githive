import type { RepoLanding, RepoSnapshot, RepoTree } from "../api";
import { useChanged } from "../hooks/useChanged";
import { type Cell, cellLamp, type Lamp, LAMPS, type Region, territory } from "../lib/overview";
import { counted } from "../lib/plural";
import { href } from "../lib/routes";
import { STATES } from "../lib/status";
import { cn } from "../lib/utils";
import { StateMark } from "./StateMark";
import { Lamp as LampMark } from "./ui/badge";

/** A region with no more entries than this lists them by name; a bigger one is a grid of lamps. */
const NAMED_CELLS = 16;

/** What a cell says to someone who can't see its lamp. */
function cellLabel(cell: Cell, region: Region): string {
	const holder = cell.holders[0] ?? region.whole[0];
	const what = `${cell.path}${cell.planned ? " (new)" : ""}`;
	if (!holder) return `${what}: not claimed`;
	const others = cell.holders.length > 1 ? `, and ${cell.holders.length - 1} more` : "";
	return `${what}: ${holder.title} by ${holder.agent}, ${STATES[holder.lamp].short}${others}`;
}

/**
 * A cell: a dark slot when nobody holds it, its change's state when someone does (its color, pattern and glyph, as
 * everywhere), changing color smoothly.
 */
function CellMark({ lamp, className }: { lamp: Lamp | undefined; className?: string }) {
	return (
		<StateMark
			state={lamp}
			empty="border-surface-3 bg-surface-3"
			className={cn("grid size-3.5 rounded-xs", className)}
		/>
	);
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
			className={named ? "min-w-0 flex-[1_1_220px]" : "max-w-full min-w-45 flex-initial"}
			// Keep the grid about square, with about twice as many columns as rows. Each cell is 18px with its gap.
			style={named ? undefined : { width: `${Math.ceil(Math.sqrt(shown.length * 2)) * 18}px` }}
		>
			<h3 className="mb-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 border-b border-border pb-1.5 text-body-sm font-semibold">
				<code className="bg-transparent p-0 font-semibold">{region.name ? `${region.name}/` : "top level"}</code>
				<span className="text-ui font-normal text-muted-foreground">
					{region.files ? counted(region.files, "file") : "new"}
					{held ? `, ${held} held` : ""}
				</span>
			</h3>
			{wholeHolder ? (
				<p className="mt-0 mb-2.5 text-ui-lg">
					<LampMark state={wholeHolder.lamp} className="mr-1.75 align-[0.05em]" />
					<a href={href.change(repo, wholeHolder.change)}>{wholeHolder.title}</a> holds all of it,{" "}
					{STATES[wholeHolder.lamp].short}
				</p>
			) : null}
			{named ? (
				<ul className="m-0 grid list-none gap-1.25 p-0">
					{shown.map((cell) => {
						const holder = cell.holders[0] ?? region.whole[0];
						const lamp = cellLamp(cell, region);
						return (
							<li key={cell.path} className="flex min-w-0 items-center gap-2.25">
								{/* Named entries nobody holds show no lamp at all: only what's lit draws the eye. */}
								<CellMark lamp={lamp} className={lamp ? undefined : "invisible"} />
								<a
									href={linkOf(cell)}
									className={cn(
										"truncate font-mono text-ui text-muted-foreground",
										lamp && "font-semibold text-foreground",
									)}
									title={cellLabel(cell, region)}
								>
									{cell.name}
									{cell.folder ? "/" : ""}
								</a>
								{holder && cell.holders.length ? (
									<span className="ml-auto text-meta whitespace-nowrap text-muted-foreground">{holder.agent}</span>
								) : null}
							</li>
						);
					})}
				</ul>
			) : (
				<ul className="m-0 flex list-none flex-wrap gap-1 p-0">
					{shown.map((cell) => (
						<li key={cell.path}>
							<a
								className="block rounded-xs leading-0"
								href={linkOf(cell)}
								aria-label={cellLabel(cell, region)}
								title={cellLabel(cell, region)}
							>
								<CellMark lamp={cellLamp(cell, region)} />
							</a>
						</li>
					))}
				</ul>
			)}
			{region.cells.length > shown.length ? (
				<p className="mt-2 mb-0 text-ui text-muted-foreground">and {region.cells.length - shown.length} more</p>
			) : null}
		</section>
	);
}

/** What agents hold of the tree, by top-level folder. Once the tree is read, its regions fade in. */
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
	const regions = tree
		? territory(tree.files, snapshot.claims, { landing, votes: snapshot.votes, policy: snapshot.policy })
		: [];
	const treeStatus = error ? `The tree couldn't be read: ${error}` : "Reading the tree…";
	// What comes once the tree is read (or goes to read another branch's) fades in; what's there at once comes with the
	// page.
	const read = useChanged(Boolean(tree));
	const fades = read && "animate-fade";
	return (
		<section aria-labelledby="territory-title">
			<div className="mb-5 flex flex-wrap items-baseline gap-x-4.5 gap-y-1 border-t-2 border-foreground pt-2.5">
				<h2 id="territory-title" className="text-[19px]">
					Territory
				</h2>
				<p className="m-0 max-w-[72ch] text-muted-foreground">
					What agents hold of {branch}, by folder. A lit entry is claimed; its lamp says where the change is.
				</p>
			</div>
			<ul
				className="m-0 mb-4.5 flex list-none flex-wrap gap-x-4.5 gap-y-1.5 p-0 text-ui text-muted-foreground"
				aria-label="What the lamps mean"
			>
				{LAMPS.map((lamp) => (
					<li key={lamp} className="inline-flex items-center gap-1.75">
						<CellMark lamp={lamp} />
						{STATES[lamp].short}
					</li>
				))}
				<li className="inline-flex items-center gap-1.75">
					<CellMark lamp={undefined} />
					not claimed
				</li>
			</ul>
			{!tree ? <p className={cn("my-3.75 text-muted-foreground", fades)}>{treeStatus}</p> : null}
			{tree?.truncated ? (
				<p className={cn("my-3.75 text-muted-foreground", fades)}>
					This repo is large: the territory shows the first part of its tree.
				</p>
			) : null}
			{regions.length ? (
				<div className={cn("flex flex-wrap gap-x-7.5 gap-y-5.5", fades)}>
					{regions.map((region) => (
						<RegionView key={region.name || "/"} repo={repo} region={region} />
					))}
				</div>
			) : null}
		</section>
	);
}
