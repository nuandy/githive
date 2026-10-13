import { type CSSProperties, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useFresh } from "../hooks/useFresh";
import { useLeaving } from "../hooks/useLeaving";
import { displayName } from "../lib/agent";
import { type Goal, goalStatus } from "../lib/goals";
import { type Direction, hexGrid, hexPoints, hexWidthAt, nearestInDirection } from "../lib/hexGeometry";
import {
	agentChip,
	agentHue,
	type Cell,
	type CellState,
	fitLines,
	type HiveCells,
	HUE_STROKE,
	cellNames,
	LANDED_LATELY_MS,
	sansWidth,
} from "../lib/hiveCells";
import type { GoalMotion, Motion } from "../lib/hiveMotion";
import { timeOf } from "../lib/model";
import { counted } from "../lib/plural";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";
import { type ChangeState, STATES } from "../lib/status";
import { cn } from "../lib/utils";
import type { HiveFilter } from "./HiveTab";
import { StateMark } from "./StateMark";
import { Button } from "./ui/button";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** A cell's corner-to-center size, in px: eleven letters of a name fit across it at 10px, and four cells a phone. */
const RADIUS = 45.75;
const GAP = 2.5;
/** The hexagon as drawn, inside its gap. */
const DRAWN = RADIUS - GAP;
/** How many columns the map draws before it has measured its box. */
const COLUMNS = 5;
/** Chips a cell shows; past that, one fewer and "+n". */
const CHIPS = 3;

/** The map's type: nothing smaller than 10px, a name in the mono face and a state's words in the sans. */
const TYPE = 10;
/** Overpass Mono's letters are 0.616 of their size wide. */
const MONO = 0.616;
/** Room kept clear inside a cell's edge, either side. */
const INSET = 3;
/** A line of words, baseline to baseline. */
const LEADING = 11;

/** The room a name has across a cell's middle. */
const NAME_ROOM = hexWidthAt(DRAWN, 0) - 2 * INSET;
/** How many letters of a name a cell shows: what fits, and one more drawn a little closer together. */
const NAME_FITS = Math.floor(NAME_ROOM / (TYPE * MONO)) + 1;

/** Chips sit in a row inside the cell's top, overlapping a little, clear of its edges. */
const CHIP_R = 10;
const CHIP_Y = -22;
const CHIP_STEP = 15.5;

/** A cell's state in words, the same on the cell as in its name: its goal's state's (see status.ts). */
const stateWords = (state: CellState) => (state === "next" ? "up next" : state === "free" ? "" : STATES[state].short);

/**
 * Where a cell's words go: its name, then its state on up to two lines under it. Under a row of chips the words sit
 * below them; with none they're centered.
 */
function layout(lines: number, chips: boolean): { name: number; words: number[] } {
	const top = chips ? -7.5 : -(TYPE + LEADING * lines) / 2;
	const name = top + 7.5;
	return { name, words: Array.from({ length: lines }, (_, index) => name + 12 + LEADING * index) };
}

/** The room a line of words has at its baseline: the cell's width at the bottom of its letters, less the inset. */
const roomAt = (baseline: number) => hexWidthAt(DRAWN, baseline + 3) - 2 * INSET;

/** A cell's state words on as many lines as they need (two at most), each fitting the cell where it sits. */
function wordLines(words: string, chips: boolean): string[] {
	if (!words) return [];
	const width = (text: string) => sansWidth(text, TYPE);
	return fitLines(words, layout(2, chips).words.map(roomAt), width);
}

/**
 * A cell in each state: its outline and tint, its name's color and its state's. Free cells are dim; the rest take
 * their stage's color, and their words the text color made for it: amber's words in --warn, and a cell that needs a
 * person, filled, in ink. Tints are fill opacities, not mixed colors: Chrome animates a color-mix() through garbage
 * colors. A cell landed lately fades as the landing gets older (--fade from 1 to 0).
 */
const LOOK: Record<CellState, { shape: string; name: string; sub: string }> = {
	free: { shape: "", name: "", sub: "" },
	next: { shape: "stroke-border-strong [stroke-dasharray:4_3]", name: "", sub: "" },
	building: {
		shape: "fill-stage-building [fill-opacity:0.24] stroke-stage-building",
		name: "fill-foreground",
		sub: "fill-link",
	},
	"in-review": {
		shape: "fill-stage-review [fill-opacity:0.09] stroke-stage-review [stroke-dasharray:5_3]",
		name: "fill-foreground",
		sub: "fill-link",
	},
	approved: { shape: "fill-good [fill-opacity:0.1] stroke-good", name: "fill-foreground", sub: "fill-good" },
	landing: {
		shape: "fill-stage-landing [fill-opacity:0.18] stroke-stage-landing",
		name: "fill-foreground",
		sub: "fill-warn",
	},
	"changes-requested": {
		shape: "fill-stage-asking [fill-opacity:0.14] stroke-stage-asking",
		name: "fill-foreground",
		sub: "fill-bad",
	},
	"checks-failed": {
		shape: "fill-stage-asking [fill-opacity:0.14] stroke-stage-asking",
		name: "fill-foreground",
		sub: "fill-bad",
	},
	"needs-person": {
		shape: "fill-stage-asking [fill-opacity:0.3] stroke-stage-asking stroke-2",
		name: "fill-foreground",
		sub: "fill-foreground font-bold",
	},
	landed: {
		shape:
			"fill-stage-landed [fill-opacity:calc(0.04+0.14*var(--fade,1))] stroke-stage-landed [stroke-opacity:calc(0.3+0.45*var(--fade,1))]",
		name: "",
		sub: "fill-good",
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

// The SVG's words: a name in the map's mono face, a state and a chip in its sans one, centered on their point.
const NAME = "pointer-events-none font-mono text-[10px] font-normal";
const WORDS = "pointer-events-none font-sans text-[10px] font-semibold";

export interface HiveMapProps {
	repo: string;
	branch: string;
	cells?: HiveCells;
	/** The goals, for a cell's details. */
	goals?: Goal[];
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
 *
 * The map is one stop for the keyboard: the arrow keys move between cells, Enter or Space picks one as a click does,
 * and its details open beside it; Escape closes them and comes back to the cell.
 */
export function HiveMap({
	repo,
	branch,
	cells,
	goals,
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
	const all = cells?.clusters.flatMap((cluster) => cluster.cells) ?? [];
	// Whether a cell, chip or cluster has only just appeared: the map opens settled, and only what comes later arrives.
	const fresh = useFresh(!!cells, FRESH_MS);
	const laid = (cells?.clusters ?? []).map((cluster) => {
		const grid = hexGrid(cluster.cells.length, columns, RADIUS);
		// Names cut so the cells side by side still read apart.
		const names = cellNames(
			cluster.cells.map((cell) => cell.name),
			NAME_FITS,
		);
		const placed = cluster.cells.flatMap((cell, index) => {
			const center = grid.centers[index];
			return center ? [{ cell, cluster: cluster.key, x: center.x, y: center.y, name: names[index]! }] : [];
		});
		return { cluster, grid, placed };
	});
	// Cells drawn last time and gone now stay a moment where they were, to shrink away instead of vanishing.
	const leaving = useLeaving(
		laid.flatMap((each) => each.placed),
		(each) => each.cell.key,
		LEAVING_MS,
	);

	// The one cell the keyboard reaches with Tab: the last one focused, else the one picked, else the first.
	const [active, setActive] = useState<string | null>(null);
	const has = (key: string | null | undefined): key is string => !!key && all.some((cell) => cell.key === key);
	const reachable = has(active) ? active : has(picked) ? picked : all[0]?.key;
	const elements = useRef(new Map<string, SVGGElement>());
	const focusCell = (key: string) => elements.current.get(key)?.focus();
	const move = (event: KeyboardEvent<HTMLDivElement>) => {
		const direction = ARROWS[event.key];
		const home = event.key === "Home" || event.key === "End";
		if (!direction && !home) return;
		const from = (event.target as Element).closest<SVGGElement>("[data-cell]")?.dataset.cell;
		if (!from) return;
		event.preventDefault();
		if (home) {
			const key = event.key === "Home" ? all[0]?.key : all[all.length - 1]?.key;
			if (key) focusCell(key);
			return;
		}
		const centers = [...elements.current].map(([key, element]) => {
			const box = element.getBoundingClientRect();
			return { key, x: box.left + box.width / 2, y: box.top + box.height / 2 };
		});
		const here = centers.find((center) => center.key === from);
		const to = here && nearestInDirection(here, centers, direction!);
		if (to) focusCell(to);
	};

	// A cell's details, opened by a click, a tap or Enter, beside it.
	const [opened, setOpened] = useState<string | null>(null);
	const openedCell = all.find((cell) => cell.key === opened);
	const anchor = useRef<SVGGElement | null>(null);
	anchor.current = openedCell ? (elements.current.get(openedCell.key) ?? null) : null;
	// Closed by a click elsewhere, focus stays where that click put it; closed by Escape, it comes back to the cell.
	const outside = useRef(false);
	const pick = (cell: Cell) => {
		const next = pickCell(opened, picked, cell.key);
		setOpened(next.opened);
		if (next.filter) onPick(cell);
	};

	return (
		<section className="min-w-0" aria-labelledby="hive-map-title" aria-describedby="hive-map-keys">
			<div className="mb-1.5 flex items-baseline gap-2.5">
				<h2 id="hive-map-title" className="m-0 text-lead">
					The hive
				</h2>
				<span className="text-ui text-muted-foreground">{branch}, opened up where agents work</span>
			</div>
			<p id="hive-map-keys" className="sr-only">
				The arrow keys move between cells; Enter shows a cell's goals and details.
			</p>
			{cells?.clusters.length ? <RedKey /> : null}
			{!cells ? <p className="my-[1em] text-muted-foreground">{status}</p> : null}
			{cells && !cells.clusters.length ? (
				<p className="my-[1em] text-muted-foreground">{branch} has no files yet.</p>
			) : null}
			{/* Drawn at its own size, never scaled down: a box too narrow for three cells scrolls instead. */}
			<div ref={boxRef} className="overflow-x-auto" onKeyDown={move}>
				{laid.map(({ cluster, grid, placed }) => (
					// A cluster that opens later (a folder agents start on) eases in.
					<div
						key={cluster.key || "~rest"}
						className={cn(fresh(`cluster:${cluster.key}`) && "animate-hive-cluster-in")}
					>
						<h3 className="mx-0 mt-2.5 mb-1 text-[11px] font-bold tracking-[0.06em] text-muted-foreground uppercase">
							{cluster.label}
						</h3>
						{/* The comb's height eases as cells come and go, so what's below doesn't jump. */}
						<div className="[transition:height_0.45s_ease]" style={{ height: grid.height }}>
							<svg
								className="block overflow-visible"
								viewBox={`0 0 ${grid.width} ${grid.height}`}
								width={grid.width}
								height={grid.height}
								role="group"
								aria-label={`${cluster.label}: ${counted(cluster.cells.length, "cell")}`}
							>
								{placed.map(({ cell, x, y, name }) => (
									<HexCell
										key={cell.key}
										cell={cell}
										name={name}
										x={x}
										y={y}
										lit={lit.has(cell.key)}
										picked={picked === cell.key}
										popped={opened === cell.key}
										reachable={reachable === cell.key}
										dim={dims(cell, filter)}
										motion={cell.goals.map((key) => motions.get(key)).find(Boolean)}
										fresh={fresh}
										onHover={onHover}
										onPick={pick}
										onFocused={setActive}
										element={(element) => {
											if (element) elements.current.set(cell.key, element);
											else elements.current.delete(cell.key);
										}}
										now={now}
									/>
								))}
								{leaving
									.filter((gone) => gone.cluster === cluster.key)
									.map(({ cell, x, y, name }) => (
										<HexCell
											key={`gone:${cell.key}`}
											cell={cell}
											name={name}
											x={x}
											y={y}
											leaving
											fresh={fresh}
											now={now}
										/>
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
			<Popover
				open={!!openedCell}
				onOpenChange={(open) => {
					if (!open) setOpened(null);
				}}
			>
				<PopoverAnchor virtualRef={anchor} />
				{openedCell ? (
					<PopoverContent
						// Beside the cell where there's room, and under it on a phone.
						side={wide(anchor.current) ? "right" : "bottom"}
						align={wide(anchor.current) ? "start" : "center"}
						collisionPadding={12}
						aria-label={cellPlace(openedCell)}
						onInteractOutside={(event) => {
							// A cell's own click moves the details to it, or closes them (see pick).
							if ((event.target as Element | null)?.closest?.("[data-cell]")) event.preventDefault();
							else outside.current = true;
						}}
						onCloseAutoFocus={(event) => {
							event.preventDefault();
							if (!outside.current) focusCell(openedCell.key);
							outside.current = false;
						}}
					>
						<CellDetails
							repo={repo}
							branch={branch}
							cell={openedCell}
							goals={goals ?? []}
							picked={picked === openedCell.key}
							onPick={() => onPick(openedCell)}
							now={now}
						/>
					</PopoverContent>
				) : null}
			</Popover>
		</section>
	);
}

/**
 * What a click, a tap or Enter on a cell does: its details open, or close if they're open, and the goals' filter
 * follows them, on to the cell as they open and off it as they close. With another cell's details open, both move to
 * this one. `filter` says whether the filter is to be switched (see HiveTab's onPick).
 */
export function pickCell(
	opened: string | null,
	picked: string | undefined,
	key: string,
): { opened: string | null; filter: boolean } {
	const opening = opened !== key;
	return { opened: opening ? key : null, filter: opening !== (picked === key) };
}

/** Whether the window a cell is in has room for its details beside it. */
const wide = (element: Element | null) => (element?.ownerDocument.defaultView?.innerWidth ?? 1280) >= 640;

const ARROWS: Record<string, Direction> = {
	ArrowUp: "up",
	ArrowDown: "down",
	ArrowLeft: "left",
	ArrowRight: "right",
};

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
					<StateMark state={state} className="size-3.5 rounded-xs" />
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

/** Where a cell is: its path, "lib/router/" for a folder, or what it folds together. */
export function cellPlace(cell: Cell): string {
	const where =
		cell.kind === "files"
			? cell.path
				? `${cell.folders ? "everything else" : "the other files"} in ${cell.path}/`
				: "the top-level files"
			: cell.kind === "folder"
				? `${cell.path}/`
				: cell.path;
	return cell.planned ? `${where} (new)` : where;
}

/** What's happening in a cell, in words that start with those it shows: its state, and who's at work there. */
function cellNews(cell: Cell): string {
	const agents = cell.agents.length ? `, ${cell.agents.join(", ")} at work` : "";
	if (cell.state === "free") return cell.kind === "file" ? "nobody on it" : counted(cell.files, "file");
	if (cell.state === "landed") return `landed lately by ${cell.landed?.agent ?? "an agent"}`;
	if (cell.state === "next") return "up next, backlog work waiting for an agent";
	return `${stateWords(cell.state)}${agents}`;
}

/**
 * What a cell says to someone who can't see it: its name in full and its state, the words it shows cut to fit, then
 * where it is. A name that starts with what's shown is one speech can click by (WCAG 2.5.3): "OrderSummary.tsx:
 * approved, ines/claude at work, in src/components/checkout/".
 */
export function cellLabel(cell: Cell): string {
	const name = `${cell.name}${cell.kind === "folder" ? "/" : ""}${cell.planned ? " (new)" : ""}`;
	// The folder it's in; what a folder's other files fold together is in that folder.
	const path = cell.kind === "files" ? (cell.path ? `${cell.path}/` : "") : cell.path;
	const folder = path.slice(0, path.lastIndexOf("/") + 1);
	return `${name}: ${cellNews(cell)}${folder ? `, in ${folder}` : ""}`;
}

/** The chips a cell shows: up to three agents, or two and "+n". */
function chipsOf(cell: Cell): { agents: string[]; more: number } {
	if (!cell.agents.length) return { agents: cell.landed ? [cell.landed.agent] : [], more: 0 };
	if (cell.agents.length <= CHIPS) return { agents: cell.agents, more: 0 };
	return { agents: cell.agents.slice(0, CHIPS - 1), more: cell.agents.length - (CHIPS - 1) };
}

function HexCell({
	cell,
	name,
	x,
	y,
	lit = false,
	picked = false,
	popped = false,
	reachable = false,
	dim = false,
	motion,
	leaving = false,
	fresh,
	onHover,
	onPick,
	onFocused,
	element,
	now,
}: {
	cell: Cell;
	/** Its name as shown, cut to fit. */
	name: string;
	x: number;
	y: number;
	lit?: boolean;
	picked?: boolean;
	/** Its details are open. */
	popped?: boolean;
	/** The map's one stop for Tab. */
	reachable?: boolean;
	dim?: boolean;
	motion?: GoalMotion | undefined;
	/** Gone: drawn a moment longer, fading, where it was. */
	leaving?: boolean;
	fresh: (key: string) => boolean;
	onHover?(cell: string | null): void;
	onPick?(cell: Cell): void;
	onFocused?(cell: string): void;
	element?(element: SVGGElement | null): void;
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
	const { agents, more } = chipsOf(cell);
	const chipCount = agents.length + (more ? 1 : 0);
	// Words too long for one line take two; they and the name sit under the chips, or centered without any.
	const lines = wordLines(sub, chipCount > 0);
	const at = layout(lines.length, chipCount > 0);
	const chipX = (index: number) => (index - (chipCount - 1) / 2) * CHIP_STEP;
	// A chip that appears pops on; on a goal that has just arrived, in its turn in the burst.
	const chipClass = (agent: string) => {
		const isFresh = fresh(`chip:${cell.key}:${agent}`);
		const pops = motion?.motion === "arrived" ? "animate-hive-chip-arrive" : isFresh ? "animate-hive-chip-in" : "";
		return cn("origin-center [transform-box:fill-box]", pops);
	};
	const keys = (event: KeyboardEvent) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			onPick?.(cell);
		}
	};
	// Its hexagon, ring and lamp: the button.
	const outline = (
		<>
			<polygon
				className={cn(
					"fill-card stroke-border stroke-[1.5]",
					"[transition:fill_0.4s_ease,fill-opacity_0.4s_ease,stroke_0.4s_ease,stroke-opacity_0.4s_ease,stroke-width_0.2s_ease]",
					look.shape,
					"group-hover:stroke-3",
					lit && "stroke-3",
					(picked || popped) && "stroke-foreground stroke-3",
					motion && SHAPE_MOTION[motion.motion],
				)}
				points={hexPoints(0, 0, DRAWN)}
			/>
			{/* Keyboard focus: the ring every focused thing has, hugging the cell in the gap before its neighbors. */}
			<polygon
				className="pointer-events-none fill-none stroke-ring stroke-2 opacity-0 group-focus-visible:opacity-100"
				points={hexPoints(0, 0, DRAWN + 2)}
			/>
			{cell.state === "landing" ? (
				<circle className="animate-hive-cell-blink fill-stage-landing" cx={0} cy={DRAWN - 9} r={3.5} />
			) : null}
		</>
	);
	// Its words and chips, drawn over it.
	const words = (
		<>
			<CellName cell={cell} name={name} y={at.name} className={look.name || "fill-muted-foreground"} />
			{lines.length ? (
				<text className={cn(WORDS, look.sub || "fill-muted-foreground")} textAnchor="middle" x={0} y={at.words[0]}>
					{/* The space ends the first line, so the words read as written. */}
					{lines.map((line, index) => (
						<tspan key={index} x={0} dy={index ? LEADING : 0}>
							{index < lines.length - 1 ? `${line} ` : line}
						</tspan>
					))}
				</text>
			) : null}
			{agents.map((agent, index) => (
				<g key={agent} className={chipClass(agent)}>
					<circle
						className={cn("fill-card stroke-[1.5]", HUE_STROKE[agentHue(agent)])}
						cx={chipX(index)}
						cy={CHIP_Y}
						r={CHIP_R}
					/>
					<ChipText x={chipX(index)} text={agentChip(agent)} />
				</g>
			))}
			{more ? (
				<g className={chipClass("+more")}>
					<circle
						className="fill-card stroke-border-strong stroke-[1.5] [stroke-dasharray:2_2]"
						cx={chipX(agents.length)}
						cy={CHIP_Y}
						r={CHIP_R}
					/>
					<ChipText x={chipX(agents.length)} text={`+${more}`} />
				</g>
			) : null}
		</>
	);
	// The words sit over the button, not in it, and pointer events pass through them to it. What they show is cut to
	// fit, so the button's name says it in full instead (cellLabel), and they're hidden from screen readers.
	const drawn = (button: ReactNode) => (
		<g className={cn("origin-center [transform-box:fill-box]", arriving)}>
			{button}
			<g className="pointer-events-none" aria-hidden="true">
				{words}
			</g>
		</g>
	);
	// Each cell is moved into place by its transform, so it glides when the comb rearranges.
	const MOVES = "[transition:transform_0.5s_var(--ease-out),opacity_0.3s_ease]";
	if (leaving)
		return (
			<g data-state={cell.state} className={cn("pointer-events-none", MOVES)} style={style} aria-hidden="true">
				{drawn(<g>{outline}</g>)}
			</g>
		);
	return (
		<g className={cn(MOVES, dim && "opacity-30")} style={style}>
			{drawn(
				<Tooltip>
					<TooltipTrigger asChild>
						<g
							data-state={cell.state}
							data-cell={cell.key}
							className="group cursor-pointer outline-none"
							role="button"
							tabIndex={reachable ? 0 : -1}
							aria-label={label}
							aria-haspopup="dialog"
							aria-expanded={popped}
							ref={element}
							onMouseEnter={() => onHover?.(cell.key)}
							onMouseLeave={() => onHover?.(null)}
							onFocus={() => {
								onFocused?.(cell.key);
								onHover?.(cell.key);
							}}
							onBlur={() => onHover?.(null)}
							onClick={() => onPick?.(cell)}
							onKeyDown={keys}
						>
							{outline}
						</g>
					</TooltipTrigger>
					{/* Its place in full, and what's happening there; hidden while its details are open beside it. */}
					<TooltipContent side="top" className={cn(popped && "hidden")}>
						<span className="block font-mono wrap-anywhere">{cellPlace(cell)}</span>
						{cellNews(cell)}
					</TooltipContent>
				</Tooltip>,
			)}
		</g>
	);
}

/**
 * A cell's name: a file's or folder's in the mono face, cut to fit (see cellNames), and drawn a little closer together where
 * it's a letter too wide; what a cell folds together ("the others") in words.
 */
function CellName({ cell, name, y, className }: { cell: Cell; name: string; y: number; className: string }) {
	if (cell.kind === "files")
		return (
			<text className={cn(WORDS, "font-normal", className)} textAnchor="middle" x={0} y={y}>
				{fitLines(cell.name, [NAME_ROOM], (text) => sansWidth(text, TYPE))[0]}
			</text>
		);
	const squeeze = name.length * TYPE * MONO > NAME_ROOM;
	return (
		<text
			className={cn(NAME, className)}
			textAnchor="middle"
			x={0}
			y={y}
			{...(squeeze ? { textLength: NAME_ROOM, lengthAdjust: "spacing" } : {})}
		>
			{name}
		</text>
	);
}

/** A chip's letters, squeezed a little where three digits would touch its ring. */
function ChipText({ x, text }: { x: number; text: string }) {
	return (
		<text
			className={cn(WORDS, "fill-foreground font-bold")}
			textAnchor="middle"
			x={x}
			y={CHIP_Y + 3.5}
			{...(text.length > 2 ? { textLength: CHIP_R * 1.6, lengthAdjust: "spacingAndGlyphs" } : {})}
		>
			{text}
		</text>
	);
}

/** A cell's details: where it is, what's happening there, the goals in it and where to go next. */
function CellDetails({
	repo,
	branch,
	cell,
	goals,
	picked,
	onPick,
	now,
}: {
	repo: string;
	branch: string;
	cell: Cell;
	goals: Goal[];
	picked: boolean;
	onPick(): void;
	now: number;
}) {
	const byKey = new Map(goals.map((goal) => [goal.key, goal]));
	const inIt = cell.goals.flatMap((key) => byKey.get(key) ?? []);
	const state = cell.state;
	const code = cell.kind !== "files" && !cell.planned;
	return (
		<div className="grid gap-2">
			<p className="m-0 font-mono text-meta font-semibold wrap-anywhere">{cellPlace(cell)}</p>
			<p className="m-0 flex items-center gap-1.5 text-ui">
				{state === "free" || state === "next" ? null : <StateMark state={state} className="size-3.5 rounded-xs" />}
				<span className={state === "free" || state === "next" ? "text-muted-foreground" : STATES[state].text}>
					{state === "free"
						? cell.kind === "file"
							? "Nobody on it"
							: `${counted(cell.files, "file")}, nobody on them`
						: state === "next"
							? "Backlog work waiting for an agent"
							: state === "landed"
								? `Landed ${timeAgo(cell.landed?.at, now)} by ${displayName(cell.landed?.agent) ?? "an agent"}`
								: STATES[state].label}
				</span>
			</p>
			{inIt.length ? (
				<ul className="m-0 grid list-none gap-1.5 p-0">
					{inIt.slice(0, 5).map((goal) => (
						<li key={goal.key} className="grid gap-px">
							<a className="font-semibold" href={href.change(repo, goal.change)}>
								{goal.title}
							</a>
							<span className="text-caption text-muted-foreground">
								{goal.agent} · {goalStatus(goal).words}
							</span>
						</li>
					))}
					{inIt.length > 5 ? (
						<li className="text-caption text-muted-foreground">and {counted(inIt.length - 5, "more goal")}</li>
					) : null}
				</ul>
			) : null}
			<p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2 text-ui">
				{code ? <a href={href.code(repo, cell.path, branch)}>Open in Code</a> : null}
				{inIt.length || picked ? (
					<Button variant="link" className="leading-[inherit]" onClick={onPick}>
						{picked ? "Show every goal" : "Show only its goals"}
					</Button>
				) : null}
			</p>
		</div>
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
