import { counted } from "../lib/plural";
import "./HiveMap.css";
import { useEffect, useState } from "react";
import type { RepoLanding, RepoSnapshot, RepoTree } from "../api";
import { type Hex, type HexHolder, hexGrid, hexPoints, hiveAgents, honeycomb, MAX_HEXES } from "../lib/honeycomb";
import { LAMP_WORDS } from "../lib/overview";
import { timeAgo } from "../lib/relativeTime";
import { href } from "../lib/routes";

export interface HiveMapProps {
	repo: string;
	/** The branch shown. */
	branch: string;
	/** Its claims (those landing on `branch`) and votes. */
	snapshot: Pick<RepoSnapshot, "claims" | "votes">;
	tree?: RepoTree;
	error?: string;
	landing?: RepoLanding;
	/** The time "claimed … ago" counts from (tests fix it). */
	now?: number;
}

/** A cell's corner-to-center size, in px at full size. */
const RADIUS = 38;
/** The gap between cells. */
const GAP = 3;
/** How wide the map draws before it has measured its box: wraps after this many cells. */
const COLUMNS = 10;

/** Short enough to sit inside a cell. */
const fit = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Where a cell is, in words: "src/stats/", "the files in src/", "the top-level files". */
function place(hex: Hex): string {
	if (hex.kind === "files") return hex.path ? `the files directly in ${hex.path}/` : "the top-level files";
	return `${hex.path}/`;
}

const LANDING_WORDS = {
	checking: "a change here is being checked to land",
	queued: "a change here is approved and waiting to land",
} as const;

/** A cell's name inside its hexagon. */
function cellName(hex: Hex): string {
	if (hex.kind !== "files") return fit(hex.name, 8);
	return hex.path ? "· files" : "top files";
}

/** A cell's path in its details: a folder, or the files directly in one. */
function detailsPath(hex: Hex): string {
	if (hex.kind !== "files") return `${hex.path}/`;
	return hex.path ? `${hex.path}/*` : "top-level files";
}

/** What a cell says to someone who can't see it. */
export function hexLabel(hex: Hex, now: number = Date.now()): string {
	const what = `${place(hex)}${hex.planned ? " (new)" : ""}`;
	const holder = hex.holders[0];
	if (!holder) return `${what}: not claimed`;
	const others = hex.holders.length > 1 ? `, and ${counted(hex.holders.length - 1, "more change")}` : "";
	// Mention that a change in the cell is landing only if the holder's own state doesn't already say so.
	const said =
		(hex.landing === "checking" && holder.lamp === "checking") ||
		(hex.landing === "queued" && holder.lamp === "approved");
	const landing = hex.landing && !said ? `; ${LANDING_WORDS[hex.landing]}` : "";
	const held = holder.whole ? "held" : "partly held";
	const claimed = `claimed ${timeAgo(holder.since, now)}`;
	const state = LAMP_WORDS[holder.lamp];
	return `${what}: ${held} by ${holder.agent} for ${holder.title}, ${claimed}, ${state}${others}${landing}`;
}

/** The width of the box the map draws in, once known (a callback ref, since the box shows only once the tree is in). */
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

function Swatch({ color }: { color: number }) {
	return <span className={`claims__swatch hive__swatch claim-c${color}`} aria-hidden="true" />;
}

/** One cell: its hexagon in its holder's color, its name, and a ring when a change in it is landing. */
function Cell({
	hex,
	x,
	y,
	active,
	onShow,
	onPick,
	now,
}: {
	hex: Hex;
	x: number;
	y: number;
	active: boolean;
	onShow: (key: string | null) => void;
	onPick: (key: string) => void;
	now: number;
}) {
	const holder = hex.holders[0];
	const className = [
		"hive__cell",
		holder ? `hive__cell--held claim-c${holder.color}` : "",
		holder && !holder.whole ? "hive__cell--part" : "",
		hex.planned ? "hive__cell--planned" : "",
		hex.landing ? `hive__cell--${hex.landing}` : "",
		active ? "hive__cell--active" : "",
	]
		.filter(Boolean)
		.join(" ");
	const label = hexLabel(hex, now);
	return (
		<g
			className={className}
			role="button"
			tabIndex={0}
			aria-label={label}
			aria-pressed={active}
			onMouseEnter={() => onShow(hex.key)}
			onMouseLeave={() => onShow(null)}
			onFocus={() => onShow(hex.key)}
			onBlur={() => onShow(null)}
			onClick={() => onPick(hex.key)}
			onKeyDown={(event) => {
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onPick(hex.key);
				}
			}}
		>
			<title>{label}</title>
			<polygon className="hive__shape" points={hexPoints(x, y, RADIUS - GAP)} />
			{hex.landing ? <polygon className="hive__ring" points={hexPoints(x, y, RADIUS - GAP - 6)} /> : null}
			{hex.landing === "checking" ? <circle className="hive__lamp" cx={x} cy={y - RADIUS + GAP + 15} r={4} /> : null}
			{hex.parent ? (
				<text className="hive__parent" x={x} y={y - 11} aria-hidden="true">
					{fit(`${hex.parent}/`, 10)}
				</text>
			) : null}
			<text className="hive__name" x={x} y={y + (hex.parent ? 4 : 0)} aria-hidden="true">
				{cellName(hex)}
			</text>
			<text className="hive__count" x={x} y={y + (hex.parent ? 18 : 15)} aria-hidden="true">
				{hex.planned ? "new" : counted(hex.files, "file")}
				{hex.holders.length > 1 ? ` +${hex.holders.length - 1}` : ""}
			</text>
		</g>
	);
}

/** A cell's holders, in full. */
function HolderLine({ repo, holder, now }: { repo: string; holder: HexHolder; now: number }) {
	return (
		<li className={`claim-c${holder.color}`}>
			<Swatch color={holder.color} />
			<div className="hive__holder">
				<p>
					<strong>{holder.agent}</strong> {holder.whole ? "holds it" : "holds part of it"} for{" "}
					<a href={href.change(repo, holder.change)}>{holder.title}</a>
				</p>
				{holder.intent && holder.intent.trim() !== holder.title ? (
					<p className="muted hive__intent">{fit(holder.intent.trim(), 280)}</p>
				) : null}
				<p className="muted">
					Claimed {timeAgo(holder.since, now)} · {LAMP_WORDS[holder.lamp]} ·{" "}
					{holder.paths.map((path, index) => (
						<span key={path}>
							{index ? ", " : ""}
							<code>{path || "/"}</code>
						</span>
					))}
				</p>
			</div>
		</li>
	);
}

/** What the shown cell holds: its path, its holders, and whether something in it is landing. */
function Details({ repo, branch, hex, now }: { repo: string; branch: string; hex: Hex | undefined; now: number }) {
	if (!hex)
		return (
			<p className="muted hive__hint">
				Point at a cell, or tab to it, to see who holds it. Select one to keep it here.
			</p>
		);
	return (
		<div className="hive__details-body">
			<h3>
				<code>{detailsPath(hex)}</code>
				<span className="muted">{hex.planned ? `new: not on ${branch} yet` : counted(hex.files, "file")}</span>
				{hex.kind === "folder" && !hex.planned ? <a href={href.code(repo, hex.path, branch)}>Open in Code</a> : null}
			</h3>
			{hex.landing ? (
				<p className={`hive__landing lamp--${hex.landing === "checking" ? "amber" : "green"}`}>
					<span className="lamp" aria-hidden="true" />
					{hex.landing === "checking"
						? `A change here is being checked to land on ${branch}.`
						: `A change here is approved, landing on ${branch} with the next batch.`}
				</p>
			) : null}
			{hex.holders.length ? (
				<ul className="hive__holders">
					{hex.holders.map((holder) => (
						<HolderLine key={holder.change} repo={repo} holder={holder} now={now} />
					))}
				</ul>
			) : (
				<p className="muted">Not claimed: free for any agent to take.</p>
			)}
		</div>
	);
}

/** Each agent holding claims, in its color, with its changes and how far along each is. */
function HiveLegend({ repo, branch, agents }: { repo: string; branch: string; agents: ReturnType<typeof hiveAgents> }) {
	if (!agents.length) return <p className="muted">No agent holds a claim on {branch}: every folder is free.</p>;
	return (
		<ul className="hive__legend" aria-label="Agents holding claims">
			{agents.map((entry) => (
				<li key={entry.agent} className={`claim-c${entry.color}`}>
					<Swatch color={entry.color} />
					<strong>{entry.agent}</strong>
					{entry.changes.map((change, index) => (
						<span key={change.change} className="hive__legend-change">
							{index ? "; " : ""}
							<a href={href.change(repo, change.change)} title={change.intent}>
								{change.title}
							</a>
							<span className="muted"> · {LAMP_WORDS[change.lamp]}</span>
						</span>
					))}
				</li>
			))}
		</ul>
	);
}

/** What a cell's shading, ring and lamp mean. */
function HiveKey() {
	return (
		<ul className="hive__key" aria-label="What the cells mean">
			<li>
				<svg viewBox="0 0 20 22" width="16" height="18" aria-hidden="true">
					<polygon className="hive__key-shape" points={hexPoints(10, 11, 9)} />
				</svg>
				not claimed
			</li>
			<li>
				<svg viewBox="0 0 20 22" width="16" height="18" aria-hidden="true" className="hive__cell--part claim-c0">
					<polygon className="hive__key-shape hive__key-shape--part" points={hexPoints(10, 11, 9)} />
				</svg>
				pale: part of it held
			</li>
			<li>
				<svg viewBox="0 0 20 22" width="16" height="18" aria-hidden="true">
					<polygon className="hive__key-shape" points={hexPoints(10, 11, 9)} />
					<polygon className="hive__key-ring" points={hexPoints(10, 11, 5.5)} />
				</svg>
				ring: approved, waiting to land
			</li>
			<li>
				<svg viewBox="0 0 20 22" width="16" height="18" aria-hidden="true">
					<polygon className="hive__key-shape" points={hexPoints(10, 11, 9)} />
					<polygon className="hive__key-ring" points={hexPoints(10, 11, 5.5)} />
					<circle className="hive__key-lamp" cx={10} cy={11} r={2} />
				</svg>
				ring and lamp: being checked to land
			</li>
		</ul>
	);
}

/**
 * The repo's folders as a honeycomb: a cell per top-level folder (opened into
 * its second-level folders when it's big or claimed below its top), lit in
 * the color of the agent holding it, ringed while a change in it is landing.
 */
export function HiveMap({ repo, branch, snapshot, tree, error, landing, now = Date.now() }: HiveMapProps) {
	const [boxRef, width] = useWidth<HTMLDivElement>();
	const [hovered, setHovered] = useState<string | null>(null);
	const [picked, setPicked] = useState<string | null>(null);
	const context = { landing, votes: snapshot.votes, now };
	const allHexes = tree ? honeycomb(tree.files, snapshot.claims, context) : [];
	const hexes = allHexes.slice(0, MAX_HEXES);
	const agents = hiveAgents(snapshot.claims, context);
	const cellWidth = Math.sqrt(3) * RADIUS;
	const columns = width ? Math.max(2, Math.floor((width - cellWidth / 2) / cellWidth)) : COLUMNS;
	const grid = hexGrid(hexes.length, columns, RADIUS);
	const shown = hexes.find((hex) => hex.key === (hovered ?? picked));
	const held = hexes.filter((hex) => hex.holders.length).length;
	const treeStatus = error ? `The tree couldn't be read: ${error}` : "Reading the tree…";
	return (
		<section className="hive" aria-labelledby="hive-title">
			<div className="overview__head">
				<h2 id="hive-title">Hive map</h2>
				<p className="muted">
					{branch}'s folders, each lit in the color of the agent holding it. A ringed cell has a change landing.
				</p>
			</div>
			<HiveLegend repo={repo} branch={branch} agents={agents} />
			<HiveKey />
			{!tree ? <p className="muted">{treeStatus}</p> : null}
			{tree && !hexes.length ? <p className="muted">{branch} has no files yet.</p> : null}
			{hexes.length ? (
				<div className="hive__body">
					<div className="hive__board" ref={boxRef}>
						<svg
							className="hive__svg"
							viewBox={`0 0 ${grid.width} ${grid.height}`}
							width={grid.width}
							height={grid.height}
							style={{ maxWidth: "100%", height: "auto" }}
							role="group"
							aria-label={`${counted(hexes.length, "folder cell")}, ${held} held`}
						>
							{hexes.map((hex, index) => {
								const center = grid.centers[index];
								if (!center) return null;
								return (
									<Cell
										key={hex.key}
										hex={hex}
										x={center.x}
										y={center.y}
										active={picked === hex.key}
										onShow={setHovered}
										onPick={(key) => setPicked((current) => (current === key ? null : key))}
										now={now}
									/>
								);
							})}
						</svg>
						{allHexes.length > hexes.length ? (
							<p className="muted">and {allHexes.length - hexes.length} more folders</p>
						) : null}
						{tree?.truncated ? (
							<p className="muted">This repo is large: the map shows the first part of its tree.</p>
						) : null}
					</div>
					<div className="hive__details">
						<Details repo={repo} branch={branch} hex={shown} now={now} />
					</div>
				</div>
			) : null}
		</section>
	);
}
