import { type CSSProperties, type KeyboardEvent, useEffect, useState } from "react";
import { useFresh } from "../hooks/useFresh";
import { useLeaving } from "../hooks/useLeaving";
import { hexGrid, hexPoints } from "../lib/hexGeometry";
import { agentChip, type Cell, type CellState, type HiveCells, LANDED_LATELY_MS } from "../lib/hiveCells";
import type { GoalMotion, Motion } from "../lib/hiveMotion";
import { timeOf } from "../lib/model";
import { counted } from "../lib/plural";
import { href } from "../lib/routes";
import { type ChangeState, STATES } from "../lib/status";
import { cn } from "../lib/utils";
import type { HiveFilter } from "./HiveTab";
import { StateMark } from "./StateMark";

/** A cell's corner-to-center size, in px. */
const RADIUS = 34;
const GAP = 2.5;
/** Room above a cluster's first row for the chips that sit on its cells' tops. */
const TOP = 8;
/** How many columns the map draws before it has measured its box. */
const COLUMNS = 7;
/** Chips a cell shows before "+n". */
const CHIPS = 3;

/** A cell's state in words, the same on the cell as in its name: its goal's state's (see status.ts). */
const stateWords = (state: CellState) => (state === "next" ? "up next" : state === "free" ? "" : STATES[state].short);

/** How many characters of a name fit in a cell. */
const NAME_FITS = 10;

/** A name cut to fit a cell: its extension goes first ("res.sendFile.js" → "res.sendF…"). */
function fitName(name: string): string {
	if (name.length <= NAME_FITS) return name;
	const bare = name.replace(/\.[A-Za-z0-9]{1,5}$/, "");
	return bare.length <= NAME_FITS ? bare : `${bare.slice(0, NAME_FITS - 1)}…`;
}

/** A deep cell's folder, above its name, cut from the front: "…uth/src/". */
function fitParent(parent: string): string {
	const shown = `${parent}/`;
	return shown.length <= NAME_FITS + 1 ? shown : `…${shown.slice(-NAME_FITS)}`;
}

/** Past this many letters a state's words take two lines under the name, split where they're most even. */
const WORDS_FIT = 12;

function wordLines(words: string): string[] {
	if (words.length <= WORDS_FIT) return [words];
	let best = -1;
	for (let at = words.indexOf(" "); at >= 0; at = words.indexOf(" ", at + 1))
		if (best < 0 || Math.abs(words.length / 2 - at) < Math.abs(words.length / 2 - best)) best = at;
	return best < 0 ? [words] : [words.slice(0, best), words.slice(best + 1)];
}

/**
 * A cell in each state: its outline and tint, its name's color and its state's. Free cells are dim; the rest take
 * their stage's color. Tints are fill opacities, not mixed colors: Chrome animates a color-mix() through garbage
 * colors. A cell landed lately fades as the landing gets older (--fade from 1 to 0).
 */
const LOOK: Record<CellState, { shape: string; name: string; sub: string }> = {
	free: { shape: "", name: "", sub: "" },
	next: { shape: "stroke-border-strong [stroke-dasharray:4_3]", name: "", sub: "" },
	building: {
		shape: "fill-stage-building [fill-opacity:0.24] stroke-stage-building",
		name: "fill-foreground",
		sub: "fill-stage-building",
	},
	"in-review": {
		shape: "fill-stage-review [fill-opacity:0.09] stroke-stage-review [stroke-dasharray:5_3]",
		name: "fill-foreground",
		sub: "fill-stage-review",
	},
	approved: { shape: "fill-good [fill-opacity:0.1] stroke-good", name: "fill-foreground", sub: "fill-good" },
	landing: {
		shape: "fill-stage-landing [fill-opacity:0.18] stroke-stage-landing",
		name: "fill-foreground",
		sub: "fill-stage-landing",
	},
	"changes-requested": {
		shape: "fill-stage-asking [fill-opacity:0.14] stroke-stage-asking",
		name: "fill-foreground",
		sub: "fill-stage-asking",
	},
	"checks-failed": {
		shape: "fill-stage-asking [fill-opacity:0.14] stroke-stage-asking",
		name: "fill-foreground",
		sub: "fill-stage-asking",
	},
	"needs-person": {
		shape: "fill-stage-asking [fill-opacity:0.3] stroke-stage-asking",
		name: "fill-foreground",
		sub: "fill-stage-asking",
	},
	landed: {
		shape:
			"fill-stage-landed [fill-opacity:calc(0.06+0.18*var(--fade,1))] stroke-stage-landed [stroke-opacity:calc(0.3+0.45*var(--fade,1))]",
		name: "",
		sub: "fill-stage-landed",
	},
};

/** What just happened in a cell, on its outline: a red or green flash, or a pulse. */
const SHAPE_MOTION: Partial<Record<Motion, string>> = {
	"changes-asked": "animate-hive-cell-flash-bad",
	failed: "animate-hive-cell-flash-bad",
	asking: "animate-hive-cell-flash-bad",
	landed: "animate-hive-cell-flash-good",
	checking: "animate-hive-cell-pulse",
	approved: "animate-hive-cell-pulse",
};

// The SVG's words: in the map's mono face, or its sans one for states and chips, centered under their point.
const NAME = "pointer-events-none font-mono text-[9px] font-normal";
const SMALL = "pointer-events-none text-[7.5px]";

export interface HiveMapProps {
	repo: string;
	branch: string;
	cells?: HiveCells;
	truncated?: boolean;
	error?: string;
	/** Cells of the goal pointed at in the goals panel. */
	lit: Set<string>;
	filter: HiveFilter | null;
	/** What's moving now, by change. */
	motions: Map<string, GoalMotion & { seq: number }>;
	onHover(cell: string | null): void;
	onPick(cell: Cell): void;
	now: number;
}

/**
 * The repo as a honeycomb: each busy top-level folder opened up to the paths agents are on, the rest of the repo
 * folded. A cell's color is its stage (the strip above is its key); chips on it are the agents at work there.
 */
export function HiveMap({
	repo,
	branch,
	cells,
	truncated,
	error,
	lit,
	filter,
	motions,
	onHover,
	onPick,
	now,
}: HiveMapProps) {
	const [boxRef, width] = useWidth<HTMLDivElement>();
	const cellWidth = Math.sqrt(3) * RADIUS;
	const columns = width ? Math.max(3, Math.floor((width - cellWidth / 2) / cellWidth)) : COLUMNS;
	const picked = filter?.kind === "cell" ? filter.key : undefined;
	const status = error ? `The tree couldn't be read: ${error}` : "Reading the tree…";
	const pickedCell = picked
		? cells?.clusters.flatMap((cluster) => cluster.cells).find((cell) => cell.key === picked)
		: undefined;
	// Whether a cell, chip or cluster has only just appeared: the map opens settled, and only what comes later arrives.
	const fresh = useFresh(!!cells, FRESH_MS);
	const laid = (cells?.clusters ?? []).map((cluster) => {
		const grid = hexGrid(cluster.cells.length, columns, RADIUS, TOP);
		const placed = cluster.cells.flatMap((cell, index) => {
			const center = grid.centers[index];
			return center ? [{ cell, cluster: cluster.key, x: center.x, y: center.y }] : [];
		});
		return { cluster, grid, placed };
	});
	// Cells drawn last time and gone now stay a moment where they were, to shrink away instead of vanishing.
	const leaving = useLeaving(
		laid.flatMap((each) => each.placed),
		(each) => each.cell.key,
		LEAVING_MS,
	);
	return (
		<section className="min-w-0" aria-labelledby="hive-map-title">
			<div className="mb-1.5 flex items-baseline gap-2.5">
				<h2 id="hive-map-title" className="m-0 text-lead">
					The hive
				</h2>
				<span className="text-ui text-muted-foreground">{branch}, opened up where agents work</span>
			</div>
			{cells?.clusters.length ? <RedKey /> : null}
			{!cells ? <p className="my-[1em] text-muted-foreground">{status}</p> : null}
			{cells && !cells.clusters.length ? (
				<p className="my-[1em] text-muted-foreground">{branch} has no files yet.</p>
			) : null}
			<div ref={boxRef}>
				{laid.map(({ cluster, grid, placed }) => (
					// A cluster that opens later (a folder agents start on) eases in.
					<div
						key={cluster.key || "~rest"}
						className={cn(fresh(`cluster:${cluster.key}`) && "animate-hive-cluster-in")}
					>
						<h3 className="mx-0 mt-2.5 mb-0.5 text-[11px] font-bold tracking-[0.06em] text-muted-foreground uppercase">
							{cluster.label}
						</h3>
						{/* The comb's height eases as cells come and go, so what's below doesn't jump. */}
						<div className="[transition:height_0.45s_ease]" style={{ height: grid.height }}>
							<svg
								className="block overflow-visible"
								viewBox={`0 0 ${grid.width} ${grid.height}`}
								width={grid.width}
								height={grid.height}
								style={{ maxWidth: "100%", height: "auto" }}
								role="group"
								aria-label={`${cluster.label}: ${counted(cluster.cells.length, "cell")}`}
							>
								{placed.map(({ cell, x, y }) => (
									<HexCell
										key={cell.key}
										cell={cell}
										x={x}
										y={y}
										lit={lit.has(cell.key)}
										picked={picked === cell.key}
										dim={dims(cell, filter)}
										motion={cell.goals.map((key) => motions.get(key)).find(Boolean)}
										fresh={fresh}
										onHover={onHover}
										onPick={onPick}
										now={now}
									/>
								))}
								{leaving
									.filter((gone) => gone.cluster === cluster.key)
									.map(({ cell, x, y }) => (
										<HexCell key={`gone:${cell.key}`} cell={cell} x={x} y={y} leaving fresh={fresh} now={now} />
									))}
							</svg>
						</div>
					</div>
				))}
			</div>
			{cells?.more ? <p className={cn(NOTE, "text-muted-foreground")}>and {counted(cells.more, "more cell")}</p> : null}
			{truncated ? (
				<p className={cn(NOTE, "text-muted-foreground")}>
					This repo is large: the map shows the first part of its tree.
				</p>
			) : null}
			{pickedCell && pickedCell.kind !== "files" && !pickedCell.planned ? (
				<p className={NOTE}>
					<code>{pickedCell.path}</code> · <a href={href.code(repo, pickedCell.path, branch)}>Open in Code</a>
				</p>
			) : null}
		</section>
	);
}

// A line under the map.
const NOTE = "mx-0 mt-1.5 mb-0 text-ui";

/** The cells the strip above has no stage for, all red: told apart by their glyphs and their words. */
const KEYED: ChangeState[] = ["needs-person", "changes-requested", "checks-failed"];

/** A quiet key to the red cells, under the map's heading. */
function RedKey() {
	return (
		<ul
			className="m-0 mb-1 flex list-none flex-wrap gap-x-3.5 gap-y-1 p-0 text-caption text-muted-foreground"
			aria-label="What the red cells mean"
		>
			{KEYED.map((state) => (
				<li key={state} className="inline-flex items-center gap-1.5">
					<StateMark state={state} className="size-3 rounded-xs" glyph="text-[8px]" />
					{STATES[state].short}
				</li>
			))}
		</ul>
	);
}

/** How long something new keeps its arriving animation, so a redraw midway doesn't cut it short. */
const FRESH_MS = 800;

/** How long a cell that has gone stays to shrink away where it was. */
const LEAVING_MS = 450;

/** Whether the filter leaves a cell out: another agent's, or not the cell picked. */
function dims(cell: Cell, filter: HiveFilter | null): boolean {
	if (!filter) return false;
	if (filter.kind === "cell") return filter.key !== cell.key;
	return !cell.agents.includes(filter.agent) && cell.landed?.agent !== filter.agent;
}

/** What a cell says to someone who can't see it, and in its tooltip. */
export function cellLabel(cell: Cell): string {
	const where =
		cell.kind === "files"
			? cell.path
				? `${cell.folders ? "everything else" : "the other files"} in ${cell.path}/`
				: "the top-level files"
			: cell.kind === "folder"
				? `${cell.path}/`
				: cell.path;
	const what = cell.planned ? `${where} (new)` : where;
	const agents = cell.agents.length ? `, ${cell.agents.join(", ")} at work` : "";
	if (cell.state === "free") return `${what}: ${cell.kind === "file" ? "nobody on it" : counted(cell.files, "file")}`;
	if (cell.state === "landed") return `${what}: ${cell.landed?.agent ?? "an agent"} landed a change here lately`;
	if (cell.state === "next") return `${what}: backlog work waiting for an agent`;
	return `${what}: ${stateWords(cell.state)}${agents}`;
}

function HexCell({
	cell,
	x,
	y,
	lit = false,
	picked = false,
	dim = false,
	motion,
	leaving = false,
	fresh,
	onHover,
	onPick,
	now,
}: {
	cell: Cell;
	x: number;
	y: number;
	lit?: boolean;
	picked?: boolean;
	dim?: boolean;
	motion?: GoalMotion | undefined;
	/** Gone: drawn a moment longer, fading, where it was. */
	leaving?: boolean;
	fresh: (key: string) => boolean;
	onHover?(cell: string | null): void;
	onPick?(cell: Cell): void;
	now: number;
}) {
	// A cell that appears grows in; one that goes shrinks away where it was.
	const arriving = leaving ? "animate-hive-cell-out" : fresh(`cell:${cell.key}`) ? "animate-hive-cell-in" : "";
	const look = LOOK[cell.state];
	const age = cell.landed ? (now - (timeOf(cell.landed.at) ?? now)) / LANDED_LATELY_MS : 0;
	// Drawn around its own center and moved into place, so a cell glides when the comb rearranges.
	const style = {
		transform: `translate(${x}px, ${y}px)`,
		"--fade": Math.max(0, 1 - age).toFixed(2),
		...(motion ? { "--motion-delay": `${motion.delay}ms` } : {}),
	} as CSSProperties;
	const label = cellLabel(cell);
	const sub =
		cell.planned && cell.state === "free"
			? "new"
			: stateWords(cell.state) || (cell.kind === "file" ? "" : counted(cell.files, "file"));
	// Words too long for one line take two, and the name and its folder move up to make room.
	const lines = wordLines(sub);
	const up = lines.length > 1 ? 3.5 : 0;
	const chips = cell.agents.slice(0, CHIPS);
	const extra = cell.agents.length - chips.length;
	const chipY = -RADIUS + 3;
	const chipX = (index: number, count: number) => (index - (count - 1) / 2) * 15;
	// A chip that appears pops on; on a goal that has just arrived, in its turn in the burst.
	const chipClass = (agent: string) => {
		const isFresh = fresh(`chip:${cell.key}:${agent}`);
		const pops = motion?.motion === "arrived" ? "animate-hive-chip-arrive" : isFresh ? "animate-hive-chip-in" : "";
		return cn("origin-center [transform-box:fill-box]", pops);
	};
	const chip = (landed = false, more = false) => ({
		circle: cn(
			"stroke-1",
			landed ? "fill-background stroke-stage-landed" : "fill-surface-3 stroke-foreground",
			more && "[stroke-dasharray:2_2]",
		),
		text: cn(SMALL, "font-sans font-bold", landed ? "fill-stage-landed" : "fill-foreground"),
	});
	const keys = (event: KeyboardEvent) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onPick?.(cell);
		}
	};
	const interactive = leaving
		? { "aria-hidden": true }
		: {
				role: "button",
				tabIndex: 0,
				"aria-label": label,
				"aria-pressed": picked,
				onMouseEnter: () => onHover?.(cell.key),
				onMouseLeave: () => onHover?.(null),
				onFocus: () => onHover?.(cell.key),
				onBlur: () => onHover?.(null),
				onClick: () => onPick?.(cell),
				onKeyDown: keys,
			};
	return (
		<g
			data-state={cell.state}
			className={cn(
				// Each cell is moved into place by its transform, so it glides when the comb rearranges.
				"group cursor-pointer outline-none [transition:transform_0.5s_var(--ease-out),opacity_0.3s_ease]",
				dim && "opacity-30",
				leaving && "pointer-events-none",
			)}
			style={style}
			{...interactive}
		>
			{leaving ? null : <title>{label}</title>}
			<g className={cn("origin-center [transform-box:fill-box]", arriving)}>
				<polygon
					className={cn(
						"fill-card stroke-border stroke-[1.5]",
						"[transition:fill_0.4s_ease,fill-opacity_0.4s_ease,stroke_0.4s_ease,stroke-opacity_0.4s_ease,stroke-width_0.2s_ease]",
						look.shape,
						"group-hover:stroke-3",
						lit && "stroke-3",
						picked && "stroke-foreground stroke-3",
						motion && SHAPE_MOTION[motion.motion],
					)}
					points={hexPoints(0, 0, RADIUS - GAP)}
				/>
				{/* Keyboard focus: the ring every focused thing has, hugging the cell in the gap before its neighbors. */}
				<polygon
					className="pointer-events-none fill-none stroke-ring stroke-2 opacity-0 group-focus-visible:opacity-100"
					points={hexPoints(0, 0, RADIUS - GAP + 2)}
				/>
				{cell.state === "landing" ? (
					<circle className="animate-hive-cell-blink fill-stage-landing" cx={0} cy={20} r={3.5} />
				) : null}
				{cell.parent ? (
					<text
						className="pointer-events-none fill-muted-foreground font-mono text-[7.5px] opacity-80"
						textAnchor="middle"
						x={0}
						y={-10 - up}
					>
						{fitParent(cell.parent)}
					</text>
				) : null}
				<text className={cn(NAME, look.name || "fill-muted-foreground")} textAnchor="middle" x={0} y={sub ? 2 - up : 4}>
					{fitName(cell.name)}
				</text>
				{sub ? (
					<text
						className={cn(
							SMALL,
							"font-sans font-semibold tracking-[0.04em] uppercase",
							look.sub || "fill-muted-foreground",
						)}
						textAnchor="middle"
						x={0}
						y={13 - up}
					>
						{/* The space ends the first line, so the words read as written. */}
						{lines.map((line, index) => (
							<tspan key={index} x={0} dy={index ? 8.5 : 0}>
								{index < lines.length - 1 ? `${line} ` : line}
							</tspan>
						))}
					</text>
				) : null}
				{chips.map((agent, index) => (
					<g key={agent} className={chipClass(agent)}>
						<circle className={chip().circle} cx={chipX(index, chips.length + (extra ? 1 : 0))} cy={chipY} r={7.5} />
						<text
							className={chip().text}
							textAnchor="middle"
							x={chipX(index, chips.length + (extra ? 1 : 0))}
							y={chipY + 3}
						>
							{agentChip(agent)}
						</text>
					</g>
				))}
				{extra ? (
					<g className={chipClass("+more")}>
						<circle
							className={chip(false, true).circle}
							cx={chipX(chips.length, chips.length + 1)}
							cy={chipY}
							r={7.5}
						/>
						<text className={chip().text} textAnchor="middle" x={chipX(chips.length, chips.length + 1)} y={chipY + 3}>
							+{extra}
						</text>
					</g>
				) : null}
				{!chips.length && cell.landed ? (
					<g className={chipClass(`landed:${cell.landed.agent}`)}>
						<circle className={chip(true).circle} cx={0} cy={chipY} r={7.5} />
						<text className={chip(true).text} textAnchor="middle" x={0} y={chipY + 3}>
							{agentChip(cell.landed.agent)}
						</text>
					</g>
				) : null}
			</g>
		</g>
	);
}

/** The width of the box the map draws in, once known. */
function useWidth<T extends Element>(): [(element: T | null) => void, number | undefined] {
	const [element, setElement] = useState<T | null>(null);
	const [width, setWidth] = useState<number>();
	useEffect(() => {
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width));
		observer.observe(element);
		return () => observer.disconnect();
	}, [element]);
	return [setElement, width];
}
