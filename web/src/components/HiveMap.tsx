import { type CSSProperties, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { hexGrid, hexPoints } from "../lib/hexGeometry";
import { agentChip, type Cell, type CellState, type HiveCells, LANDED_LATELY_MS } from "../lib/hiveCells";
import type { GoalMotion } from "../lib/hiveMotion";
import { timeOf } from "../lib/model";
import { counted } from "../lib/plural";
import { href } from "../lib/routes";
import type { HiveFilter } from "./HiveTab";
import "./HiveMap.css";

/** A cell's corner-to-center size, in px. */
const RADIUS = 34;
const GAP = 2.5;
/** Room above a cluster's first row for the chips that sit on its cells' tops. */
const TOP = 8;
/** How many columns the map draws before it has measured its box. */
const COLUMNS = 7;
/** Chips a cell shows before "+n". */
const CHIPS = 3;

const STATE_WORDS: Record<CellState, string> = {
	asking: "asking",
	revising: "changes asked",
	landing: "landing",
	approved: "approved",
	review: "in review",
	building: "building",
	landed: "landed",
	next: "up next",
	free: "",
};

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

/** A cell's state in the fewest words, under its name. */
const SUB_WORDS: Record<CellState, string> = {
	asking: "asking",
	revising: "revising",
	landing: "landing",
	approved: "approved",
	review: "review",
	building: "building",
	landed: "landed",
	next: "up next",
	free: "",
};

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
	const fresh = useFresh(!!cells);
	const laid = (cells?.clusters ?? []).map((cluster) => {
		const grid = hexGrid(cluster.cells.length, columns, RADIUS, TOP);
		const placed = cluster.cells.flatMap((cell, index) => {
			const center = grid.centers[index];
			return center ? [{ cell, cluster: cluster.key, x: center.x, y: center.y }] : [];
		});
		return { cluster, grid, placed };
	});
	const leaving = useLeaving(laid.flatMap((each) => each.placed));
	return (
		<section className="hive-map" aria-labelledby="hive-map-title">
			<div className="hive-map__head">
				<h2 id="hive-map-title">The hive</h2>
				<span className="muted">{branch}, opened up where agents work</span>
			</div>
			{!cells ? <p className="muted">{status}</p> : null}
			{cells && !cells.clusters.length ? <p className="muted">{branch} has no files yet.</p> : null}
			<div className="hive-map__board" ref={boxRef}>
				{laid.map(({ cluster, grid, placed }) => (
					<div
						key={cluster.key || "~rest"}
						className={[
							"hive-map__cluster",
							cluster.busy ? "hive-map__cluster--busy" : "",
							fresh(`cluster:${cluster.key}`) ? "hive-map__cluster--fresh" : "",
						]
							.filter(Boolean)
							.join(" ")}
					>
						<h3>{cluster.label}</h3>
						{/* The comb's height eases as cells come and go, so what's below doesn't jump. */}
						<div className="hive-map__comb" style={{ height: grid.height }}>
							<svg
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
			{cells?.more ? <p className="muted hive-map__note">and {counted(cells.more, "more cell")}</p> : null}
			{truncated ? (
				<p className="muted hive-map__note">This repo is large: the map shows the first part of its tree.</p>
			) : null}
			{pickedCell && pickedCell.kind !== "files" && !pickedCell.planned ? (
				<p className="hive-map__note">
					<code>{pickedCell.path}</code> · <a href={href.code(repo, pickedCell.path, branch)}>Open in Code</a>
				</p>
			) : null}
		</section>
	);
}

/** How long something new keeps its arriving class, so a redraw mid-way doesn't cut its animation short. */
const FRESH_MS = 800;

/**
 * Whether a cell, chip or cluster has only just appeared. What's there on the first draw with cells isn't: the map
 * opens settled, and only what comes later arrives.
 */
function useFresh(ready: boolean): (key: string) => boolean {
	const seen = useRef<Map<string, number> | null>(null);
	const first = ready && seen.current === null;
	if (first) seen.current = new Map();
	const at = Date.now();
	return (key) => {
		const map = seen.current;
		if (!map) return false;
		const when = map.get(key);
		if (when === undefined) {
			map.set(key, first ? 0 : at);
			return !first;
		}
		return at - when < FRESH_MS;
	};
}

interface Placed {
	cell: Cell;
	cluster: string;
	x: number;
	y: number;
}

/** How long a cell that has gone stays to fade out where it was. */
const LEAVING_MS = 450;

/** Cells drawn last time and gone now, kept a moment where they were so they fade instead of vanishing. */
function useLeaving(placed: Placed[]): Placed[] {
	const last = useRef(new Map<string, Placed>());
	const [leaving, setLeaving] = useState<Placed[]>([]);
	const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
	useEffect(() => {
		const now = new Map(placed.map((each) => [each.cell.key, each]));
		const gone = [...last.current.values()].filter((each) => !now.has(each.cell.key));
		last.current = now;
		if (!gone.length) return;
		setLeaving((current) => [...current.filter((each) => !now.has(each.cell.key)), ...gone]);
		const timer = setTimeout(() => {
			timers.current.delete(timer);
			setLeaving((current) => current.filter((each) => !gone.includes(each)));
		}, LEAVING_MS);
		timers.current.add(timer);
	});
	useEffect(() => () => timers.current.forEach(clearTimeout), []);
	const now = new Set(placed.map((each) => each.cell.key));
	return leaving.filter((each) => !now.has(each.cell.key));
}

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
	return `${what}: ${STATE_WORDS[cell.state]}${agents}`;
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
	const className = [
		"hive-cell",
		`hive-cell--${cell.state}`,
		cell.planned ? "hive-cell--planned" : "",
		lit ? "hive-cell--lit" : "",
		picked ? "hive-cell--picked" : "",
		dim ? "hive-cell--dim" : "",
		motion ? `hive-cell--m-${motion.motion}` : "",
		leaving ? "hive-cell--leaving" : fresh(`cell:${cell.key}`) ? "hive-cell--fresh" : "",
	]
		.filter(Boolean)
		.join(" ");
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
			: SUB_WORDS[cell.state] || (cell.kind === "file" ? "" : counted(cell.files, "file"));
	const chips = cell.agents.slice(0, CHIPS);
	const extra = cell.agents.length - chips.length;
	const chipY = -RADIUS + 3;
	const chipX = (index: number, count: number) => (index - (count - 1) / 2) * 15;
	const chipClass = (agent: string, more = "") =>
		["hive-cell__chip", more, fresh(`chip:${cell.key}:${agent}`) ? "hive-cell__chip--fresh" : ""]
			.filter(Boolean)
			.join(" ");
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
		<g className={className} style={style} {...interactive}>
			{leaving ? null : <title>{label}</title>}
			<g className="hive-cell__in">
				<polygon className="hive-cell__shape" points={hexPoints(0, 0, RADIUS - GAP)} />
				{cell.state === "landing" ? <circle className="hive-cell__lamp" cx={0} cy={20} r={3.5} /> : null}
				{cell.parent ? (
					<text className="hive-cell__parent" x={0} y={-10}>
						{fitParent(cell.parent)}
					</text>
				) : null}
				<text className="hive-cell__name" x={0} y={sub ? 2 : 4}>
					{fitName(cell.name)}
				</text>
				{sub ? (
					<text className="hive-cell__sub" x={0} y={13}>
						{sub}
					</text>
				) : null}
				{chips.map((agent, index) => (
					<g key={agent} className={chipClass(agent)}>
						<circle cx={chipX(index, chips.length + (extra ? 1 : 0))} cy={chipY} r={7.5} />
						<text x={chipX(index, chips.length + (extra ? 1 : 0))} y={chipY + 3}>
							{agentChip(agent)}
						</text>
					</g>
				))}
				{extra ? (
					<g className={chipClass("+more", "hive-cell__chip--more")}>
						<circle cx={chipX(chips.length, chips.length + 1)} cy={chipY} r={7.5} />
						<text x={chipX(chips.length, chips.length + 1)} y={chipY + 3}>
							+{extra}
						</text>
					</g>
				) : null}
				{!chips.length && cell.landed ? (
					<g className={chipClass(`landed:${cell.landed.agent}`, "hive-cell__chip--landed")}>
						<circle cx={0} cy={chipY} r={7.5} />
						<text x={0} y={chipY + 3}>
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
