import type { RepoSnapshot } from "../api";
import { claimAgent, claimTitle } from "./claimStatus";
import { CLAIM_COLORS, covers } from "./claimsMap";
import { type LampContext, type Lamp, lampOf } from "./overview";
import { normalizePath } from "./tree";

// The hive map: the repo's folders as a honeycomb, one cell per top-level
// folder (split into its second-level folders when it's big or something
// below its top is claimed), each lit in the color of the agent holding it.
// An agent keeps its color everywhere: it comes from a hash of its name.

type Claim = RepoSnapshot["claims"][number];

/** A top-level folder with more files than this shows its second-level folders as cells of their own. */
export const BIG_FOLDER = 50;

/** The most cells the map draws; past that, it says how many more. */
export const MAX_HEXES = 240;

/** An agent's color, the same on every page and every load: an index into the claim colors (claim-c0…). */
export function agentColor(agent: string): number {
	// FNV-1a: small, and spreads short similar names ("agent-1", "agent-2") well.
	let hash = 0x811c9dc5;
	for (let index = 0; index < agent.length; index++) {
		hash ^= agent.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % CLAIM_COLORS;
}

/** A claim on a cell. */
export interface HexHolder {
	change: string;
	title: string;
	intent: string;
	agent: string;
	/** When the change claimed it. */
	since: string;
	color: number;
	lamp: Lamp;
	/** Its claim covers the whole cell (else something inside it). */
	whole: boolean;
	/** Its claimed paths in this cell, or the claim covering it. */
	paths: string[];
}

/** Where a cell's changes are on the way into the branch. */
export type HexLanding = "checking" | "queued";

/** One cell: a folder, or the files directly inside a folder (the top level's, for `path` ""). */
export interface Hex {
	/** Unique: the folder's path, or "<folder>/*" (just "*" at the top) for its own files. */
	key: string;
	/** The folder, "" for the top level. */
	path: string;
	kind: "folder" | "files";
	/** What the cell is called. */
	name: string;
	/** The top-level folder a second-level cell sits in. */
	parent?: string;
	files: number;
	/** Not in the tree yet: claimed for a change to create. */
	planned?: boolean;
	/** Whole claims first (the most specific first), then claims inside it, oldest first. */
	holders: HexHolder[];
	/** A change holding it is being checked to land, or approved and waiting for the next batch. */
	landing?: HexLanding;
}

interface Folder {
	files: number;
	direct: number;
	subs: Map<string, number>;
}

const segments = (path: string) => normalizePath(path).split("/").filter(Boolean);

/**
 * The map's cells from the branch's files and the claims on it: top-level
 * folders in name order, each big or claimed-below one opened into its
 * second-level folders (with a cell for its own files), then the top-level
 * files, plus a cell for any claimed folder that isn't there yet.
 */
export function honeycomb(files: string[], claims: Claim[], context: LampContext & { big?: number } = {}): Hex[] {
	const { tops, rootFiles } = countFiles(files);
	const claimed = claims.flatMap((claim) =>
		claim.paths.map((raw) => ({ raw, parts: segments(raw), folder: raw.endsWith("/") })),
	);
	const split = foldersToOpen(tops, claimed, context.big ?? BIG_FOLDER);
	const cells = new Map<string, Hex>();
	addTreeCells(cells, tops, split, rootFiles);
	addPlannedCells(cells, tops, split, claimed);
	for (const claim of claims) addHolders(cells, tops, claim, context);
	for (const hex of cells.values()) {
		hex.holders.sort(byHolding);
		const landing = landingOf(hex.holders);
		if (landing) hex.landing = landing;
	}
	return [...cells.values()].sort(byMapOrder);
}

type ClaimedPath = { raw: string; parts: string[]; folder: boolean };

/** Files per top-level folder, split into its own files and each subfolder's, and the files at the top. */
function countFiles(files: string[]) {
	const tops = new Map<string, Folder>();
	let rootFiles = 0;
	for (const file of files) {
		const parts = segments(file);
		const [topName, subName] = parts;
		if (topName === undefined) continue;
		if (subName === undefined) {
			rootFiles++;
			continue;
		}
		let top = tops.get(topName);
		if (!top) tops.set(topName, (top = { files: 0, direct: 0, subs: new Map() }));
		top.files++;
		if (parts.length === 2) top.direct++;
		else top.subs.set(subName, (top.subs.get(subName) ?? 0) + 1);
	}
	return { tops, rootFiles };
}

/** The top-level folders shown as their subfolders: big ones, and those claimed below the top. */
function foldersToOpen(tops: Map<string, Folder>, claimed: ClaimedPath[], big: number) {
	const claimedBelow = (top: string) => claimed.some(({ parts }) => parts.length >= 2 && parts[0] === top);
	const open = [...tops].filter(([name, top]) => top.subs.size > 0 && (top.files > big || claimedBelow(name)));
	return new Set(open.map(([name]) => name));
}

const addCell = (cells: Map<string, Hex>, hex: Hex) => {
	if (!cells.has(hex.key)) cells.set(hex.key, hex);
};

const folderCell = (path: string, name: string, files: number, extra: Partial<Hex> = {}): Hex => ({
	key: path,
	path,
	kind: "folder",
	name,
	files,
	holders: [],
	...extra,
});

const filesCell = (top: string, count: number, planned: boolean): Hex => ({
	key: top ? `${top}/*` : "*",
	path: top,
	kind: "files",
	name: top ? "files" : "top-level files",
	...(top ? { parent: top } : {}),
	files: count,
	...(planned ? { planned: true } : {}),
	holders: [],
});

/** A cell for each top-level folder, or each subfolder of an opened one plus its own files, and the top files. */
function addTreeCells(cells: Map<string, Hex>, tops: Map<string, Folder>, split: Set<string>, rootFiles: number) {
	for (const [name, top] of tops) {
		if (!split.has(name)) {
			addCell(cells, folderCell(name, name, top.files));
			continue;
		}
		if (top.direct) addCell(cells, filesCell(name, top.direct, false));
		for (const [sub, count] of top.subs) addCell(cells, folderCell(`${name}/${sub}`, sub, count, { parent: name }));
	}
	if (rootFiles) addCell(cells, filesCell("", rootFiles, false));
}

/** Cells for claims on what isn't there yet: a new folder, or a new file in an opened folder or at the top. */
function addPlannedCells(
	cells: Map<string, Hex>,
	tops: Map<string, Folder>,
	split: Set<string>,
	claimed: ClaimedPath[],
) {
	for (const { parts, folder } of claimed) {
		const [first, second] = parts;
		if (first === undefined) continue;
		const top = tops.get(first);
		if (!top) {
			if (folder || parts.length > 1) addCell(cells, folderCell(first, first, 0, { planned: true }));
			else if (!cells.has("*")) addCell(cells, filesCell("", 0, true));
			continue;
		}
		if (!split.has(first) || second === undefined || top.subs.has(second)) continue;
		if (parts.length > 2 || folder)
			addCell(cells, folderCell(`${first}/${second}`, second, 0, { parent: first, planned: true }));
		else if (!cells.has(`${first}/*`)) addCell(cells, filesCell(first, 0, true));
	}
}

/** How a claimed path meets a cell: covering all of it, inside it, or not at all. */
function meet(cells: Map<string, Hex>, tops: Map<string, Folder>, hex: Hex, raw: string): "whole" | "part" | undefined {
	const path = normalizePath(raw);
	const parts = segments(raw);
	if (hex.kind === "folder") {
		if (covers(path, hex.path)) return "whole";
		return path.startsWith(`${hex.path}/`) ? "part" : undefined;
	}
	// For a folder's own files, a claim on the folder or above covers the cell; one on a file in it is inside.
	if (!path || (hex.path && covers(path, hex.path))) return "whole";
	const depth = hex.path ? segments(hex.path).length + 1 : 1;
	if (parts.length !== depth || raw.endsWith("/")) return undefined;
	const [first = "", second = ""] = parts;
	const isSub = (top: string, name: string) => cells.get(`${top}/${name}`)?.kind === "folder";
	const isTopFolder = (name: string) => cells.get(name)?.kind === "folder" || tops.has(name);
	const elsewhere = hex.path ? first !== hex.path || isSub(hex.path, second) : isTopFolder(first);
	return elsewhere ? undefined : "part";
}

/** Adds the claim to each cell it meets: as a whole claim on its most specific path, or by the paths inside. */
function addHolders(cells: Map<string, Hex>, tops: Map<string, Folder>, claim: Claim, context: LampContext) {
	const base = {
		change: claim.change,
		title: claimTitle(claim),
		intent: claim.intent ?? "",
		agent: claimAgent(claim),
		since: claim.since,
		color: agentColor(claimAgent(claim)),
		lamp: lampOf(claim, context),
	};
	for (const hex of cells.values()) {
		let whole: string | undefined;
		const inside: string[] = [];
		for (const raw of claim.paths) {
			const how = meet(cells, tops, hex, raw);
			const moreSpecific = whole === undefined || normalizePath(raw).length > normalizePath(whole).length;
			if (how === "whole" && moreSpecific) whole = raw;
			else if (how === "part") inside.push(raw);
		}
		if (whole !== undefined) hex.holders.push({ ...base, whole: true, paths: [whole] });
		else if (inside.length) hex.holders.push({ ...base, whole: false, paths: inside });
	}
}

/** Whole claims first (the most specific first), then claims inside the cell, oldest first. */
function byHolding(a: HexHolder, b: HexHolder): number {
	const pathLength = (holder: HexHolder) => normalizePath(holder.paths[0] ?? "").length;
	const specificFirst = a.whole ? pathLength(b) - pathLength(a) : 0;
	return (
		Number(b.whole) - Number(a.whole) ||
		specificFirst ||
		a.since.localeCompare(b.since) ||
		a.change.localeCompare(b.change)
	);
}

function landingOf(holders: HexHolder[]): HexLanding | undefined {
	if (holders.some((holder) => holder.lamp === "checking")) return "checking";
	if (holders.some((holder) => holder.lamp === "approved")) return "queued";
	return undefined;
}

/** Folders by name, each split one's cells together (its own files first); the top-level files last. */
function byMapOrder(a: Hex, b: Hex): number {
	if ((a.key === "*") !== (b.key === "*")) return a.key === "*" ? 1 : -1;
	const sortKey = (hex: Hex): [string, string] => {
		if (!hex.parent) return [hex.name, ""];
		return [hex.parent, hex.kind === "files" ? "" : hex.name];
	};
	const [aFolder, aCell] = sortKey(a);
	const [bFolder, bCell] = sortKey(b);
	const numeric = { numeric: true };
	return aFolder.localeCompare(bFolder, undefined, numeric) || aCell.localeCompare(bCell, undefined, numeric);
}

/** An agent holding cells, with its color and changes. */
export interface HiveAgent {
	agent: string;
	color: number;
	changes: { change: string; title: string; intent: string; since: string; lamp: Lamp }[];
}

/** The agents holding cells, each with its color and changes, in name order. */
export function hiveAgents(claims: Claim[], context: LampContext = {}): HiveAgent[] {
	const agents = new Map<string, HiveAgent>();
	for (const claim of claims) {
		const agent = claimAgent(claim);
		let entry = agents.get(agent);
		if (!entry) agents.set(agent, (entry = { agent, color: agentColor(agent), changes: [] }));
		entry.changes.push({
			change: claim.change,
			title: claimTitle(claim),
			intent: claim.intent ?? "",
			since: claim.since,
			lamp: lampOf(claim, context),
		});
	}
	return [...agents.values()].sort((a, b) => a.agent.localeCompare(b.agent));
}

/** A pointy-top hexagon's corners around (cx, cy), as an SVG points list. */
export function hexPoints(cx: number, cy: number, radius: number): string {
	const corners: string[] = [];
	for (let corner = 0; corner < 6; corner++) {
		const angle = (Math.PI / 180) * (60 * corner - 90);
		const x = round(cx + radius * Math.cos(angle));
		const y = round(cy + radius * Math.sin(angle));
		corners.push(`${x},${y}`);
	}
	return corners.join(" ");
}

const round = (value: number) => Math.round(value * 100) / 100;

/** Cell centers for `count` cells in rows of `columns`, every other row shifted half a cell, and the map's size. */
export function hexGrid(
	count: number,
	columns: number,
	radius: number,
): { centers: { x: number; y: number }[]; width: number; height: number } {
	const perRow = Math.max(1, Math.min(columns, count || 1));
	const cellWidth = Math.sqrt(3) * radius;
	const rowHeight = 1.5 * radius;
	const rows = Math.max(1, Math.ceil(count / perRow));
	const centers = Array.from({ length: count }, (_, index) => {
		const row = Math.floor(index / perRow);
		const column = index % perRow;
		const shift = row % 2 ? cellWidth / 2 : 0;
		return { x: round(cellWidth / 2 + column * cellWidth + shift), y: round(radius + row * rowHeight) };
	});
	return {
		centers,
		width: round(perRow * cellWidth + (rows > 1 ? cellWidth / 2 : 0)),
		height: round(2 * radius + (rows - 1) * rowHeight),
	};
}
