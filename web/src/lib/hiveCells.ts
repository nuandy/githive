import type { BacklogItem } from "../api";
import { covers } from "./claimsMap";
import type { Goal } from "./goals";
import { timeOf } from "./model";
import { buildTree, normalizePath, type TreeNode } from "./tree";

// The hive map's cells: the repo as a honeycomb, opened up where agents are busy. A folder holding a path some goal
// claims, landed lately, or the backlog names, opens into its children, down to that path's own cell; quiet folders
// stay one cell each. A cell's state is what's happening in it (one meaning per color), not whose it is.

/** How long a landed change still lights its cells, fading as it goes. */
export const LANDED_LATELY_MS = 30 * 60_000;

/** The most cells the map draws; past that, it says how many more. */
export const MOST_CELLS = 240;

/** What's happening in a cell, loudest first: its goals' states (see status.ts), then backlog work, then nothing. */
export const CELL_STATES = [
	"needs-person",
	"changes-requested",
	"checks-failed",
	"landing",
	"approved",
	"in-review",
	"building",
	"landed",
	"next",
	"free",
] as const;
export type CellState = (typeof CELL_STATES)[number];

/** A goal lights its cells in its own state. */
const cellStateOf = (goal: Goal): CellState => (goal.state === "released" ? "free" : goal.state);

export interface Cell {
	/** A folder's or file's path; "<folder>/*" for the rest of a folder's own files, "*" at the top. */
	key: string;
	path: string;
	kind: "folder" | "file" | "files";
	name: string;
	files: number;
	/** For the rest of an opened folder: how many of its folders are folded into the cell. */
	folders?: number;
	/** Where it sits within its top-level folder, when deeper ("auth/src" for packages/auth/src/tokens.ts). */
	parent?: string;
	/** Not on the branch yet: claimed for a change to create. */
	planned?: boolean;
	state: CellState;
	/** The goals in it (their keys): in flight, loudest first, then landed lately. */
	goals: string[];
	/** The agents at work in it. */
	agents: string[];
	/** Who landed something here lately, and when. */
	landed?: { agent: string; at: string };
}

export interface CellCluster {
	/** A busy top-level folder's path, or "" for the rest of the repo. */
	key: string;
	label: string;
	busy: boolean;
	cells: Cell[];
}

export interface HiveCells {
	clusters: CellCluster[];
	/** Cells left out past MOST_CELLS. */
	more: number;
}

interface Hot {
	path: string;
	goal?: Goal;
	item?: BacklogItem;
}

const segments = (path: string) => normalizePath(path).split("/").filter(Boolean);
const parentOf = (path: string) => segments(path).slice(0, -1).join("/");

/** The map's cells, grouped: each busy top-level folder opened up, then the rest of the repo. */
export function hiveCells(files: string[], goals: Goal[], upNext: BacklogItem[], now: number): HiveCells {
	const lit = goals.filter((goal) => !goal.finished || landedLately(goal, now));
	const hot: Hot[] = [
		...lit.flatMap((goal) => goal.paths.map((path) => ({ path: normalizePath(path), goal }))),
		...upNext.flatMap((item) => (item.paths ?? []).map((path) => ({ path: normalizePath(path), item }))),
	];
	const root = { name: "", path: "", kind: "dir" as const, children: buildTree(files) };
	const folders = new Map<string, TreeNode>();
	const fileSet = new Set<string>();
	const index = (node: TreeNode) => {
		if (node.kind === "dir") {
			folders.set(node.path, node);
			node.children.forEach(index);
		} else fileSet.add(node.path);
	};
	index(root);
	// A folder opens when some hot path lies below it; the top level always does.
	const open = new Set<string>([""]);
	for (const { path } of hot) {
		const parts = segments(path);
		for (let depth = 1; depth < parts.length; depth++) open.add(parts.slice(0, depth).join("/"));
	}
	const hotPaths = hot.map(({ path }) => path);
	const hotFiles = new Set(hotPaths.filter((path) => fileSet.has(path) || !folders.has(path)));
	const hotFolders = new Set(hotPaths.filter((path) => folders.has(path)));

	const cells = new Map<string, Cell>();
	const blank = { state: "free" as CellState, goals: [], agents: [] };
	const cellFor = (node: TreeNode, kind: "folder" | "file"): Cell => {
		// Where it sits inside its top-level folder, when that's deeper than the folder itself.
		const parent = segments(node.path).slice(1, -1).join("/");
		const files = kind === "file" ? 1 : countFiles(node);
		return { key: node.path, path: node.path, kind, name: node.name, files, ...(parent ? { parent } : {}), ...blank };
	};
	// What each opened top-level folder folds away: everything in it, however deep, that has no cell of its own.
	const folded = new Map<string, { files: number; folders: number }>();
	const fold = (top: string, files: number, folders: number) => {
		const was = folded.get(top) ?? { files: 0, folders: 0 };
		folded.set(top, { files: was.files + files, folders: was.folders + folders });
	};
	// At the top every folder keeps a cell, so the repo keeps its shape. Inside an opened one only what something is
	// happening in gets a cell, and the rest of it is one cell.
	const walk = (folder: TreeNode) => {
		const top = segments(folder.path)[0];
		let topFiles = 0;
		for (const child of folder.children) {
			if (child.kind === "dir") {
				if (open.has(child.path)) walk(child);
				else if (!top || hotFolders.has(child.path)) cells.set(child.path, cellFor(child, "folder"));
				else fold(top, countFiles(child), 1);
			} else if (hotFiles.has(child.path)) cells.set(child.path, cellFor(child, "file"));
			else if (top) fold(top, 1, 0);
			else topFiles++;
		}
		if (!top && topFiles) {
			const some = folder.children.some((child) => child.kind === "file" && cells.has(child.path));
			cells.set("*", {
				key: "*",
				path: "",
				kind: "files",
				name: some ? "other top files" : "top files",
				files: topFiles,
				...blank,
			});
		}
	};
	walk(root);
	for (const [top, rest] of folded)
		cells.set(`${top}/*`, {
			key: `${top}/*`,
			path: top,
			kind: "files",
			name: rest.folders ? "the others" : "other files",
			files: rest.files,
			...(rest.folders ? { folders: rest.folders } : {}),
			...blank,
		});
	addPlanned(cells, folders, hot, open);
	for (const cell of cells.values()) light(cell, hot, cells, now);

	const all = [...cells.values()];
	const kept = all.slice(0, MOST_CELLS);
	return { clusters: clusterCells(kept, open), more: all.length - kept.length };
}

export const landedLately = (goal: Goal, now: number) =>
	goal.state === "landed" && !!goal.finished && now - (timeOf(goal.finished) ?? 0) <= LANDED_LATELY_MS;

function countFiles(node: TreeNode): number {
	return node.kind === "file" ? 1 : node.children.reduce((sum, child) => sum + countFiles(child), 0);
}

/** Cells for hot paths not on the branch yet, at the level of their deepest folder that is. */
function addPlanned(cells: Map<string, Cell>, folders: Map<string, TreeNode>, hot: Hot[], open: Set<string>) {
	for (const { path } of hot) {
		if (!path || cells.has(path) || folders.has(path)) continue;
		const parts = segments(path);
		let depth = parts.length - 1;
		while (depth > 0 && !folders.has(parts.slice(0, depth).join("/"))) depth--;
		const within = parts.slice(0, depth).join("/");
		if (!open.has(within)) continue;
		const name = parts[depth]!;
		const cellPath = parts.slice(0, depth + 1).join("/");
		if (cells.has(cellPath)) continue;
		const kind = cellPath === path ? "file" : "folder";
		const parent = parts.slice(1, depth).join("/");
		cells.set(cellPath, {
			key: cellPath,
			path: cellPath,
			kind,
			name,
			files: 0,
			...(parent ? { parent } : {}),
			planned: true,
			state: "free",
			goals: [],
			agents: [],
		});
	}
}

/** Whether a hot path is in a cell: it covers the cell, or lies inside it. */
function meets(cell: Cell, path: string, cells: Map<string, Cell>): boolean {
	if (cell.kind === "files") {
		if (covers(path, cell.path)) return true;
		// One of the folder's own files that has no cell of its own.
		return parentOf(path) === cell.path && segments(path).length > 0 && !cells.has(path) && !path.endsWith("/");
	}
	if (covers(path, cell.path)) return true;
	return cell.kind === "folder" && path.startsWith(`${cell.path}/`);
}

/** A cell's state, changes and agents, from the hot paths in it. */
function light(cell: Cell, hot: Hot[], cells: Map<string, Cell>, now: number) {
	const inFlight = new Map<string, Goal>();
	let landed: Goal | undefined;
	let next = false;
	for (const entry of hot) {
		if (!meets(cell, entry.path, cells)) continue;
		if (entry.item) next = true;
		const goal = entry.goal;
		if (!goal) continue;
		if (!goal.finished) inFlight.set(goal.key, goal);
		else if (landedLately(goal, now) && (!landed || (goal.finished ?? "") > (landed.finished ?? ""))) landed = goal;
	}
	const loudness = (goal: Goal) => CELL_STATES.indexOf(cellStateOf(goal));
	const working = [...inFlight.values()].sort((a, b) => loudness(a) - loudness(b));
	cell.goals = working.map((goal) => goal.key);
	cell.agents = [...new Set(working.map((goal) => goal.agent))];
	if (landed) {
		cell.landed = { agent: landed.agent, at: landed.finished! };
		cell.goals.push(landed.key);
	}
	const loudest = working[0];
	if (loudest) cell.state = cellStateOf(loudest);
	else if (landed) cell.state = "landed";
	else if (next) cell.state = "next";
}

/** Cells grouped: each opened top-level folder, busiest first, then the rest of the repo. */
function clusterCells(cells: Cell[], open: Set<string>): CellCluster[] {
	const groups = new Map<string, Cell[]>();
	for (const cell of cells) {
		const top = segments(cell.path)[0] ?? "";
		const key = top && open.has(top) ? top : "";
		let group = groups.get(key);
		if (!group) groups.set(key, (group = []));
		group.push(cell);
	}
	const active = (group: Cell[]) => group.filter((cell) => cell.state !== "free").length;
	const busy = [...groups].filter(([key]) => key).sort(([a, x], [b, y]) => active(y) - active(x) || a.localeCompare(b));
	const clusters: CellCluster[] = busy.map(([key, group]) => {
		const agents = new Set(group.flatMap((cell) => cell.agents)).size;
		return {
			key,
			label: agents ? `${key}/ · ${agents === 1 ? "1 agent" : `${agents} agents`} at work` : `${key}/`,
			busy: true,
			cells: group,
		};
	});
	const rest = groups.get("");
	if (rest?.length)
		clusters.push({ key: "", label: clusters.length ? "the rest of the repo" : "the repo", busy: false, cells: rest });
	return clusters;
}

/** A short label for an agent's chip: its number ("agent-19" → 19), else its initials ("alice-claude" → AC). */
export function agentChip(agent: string): string {
	const number = /(\d+)$/.exec(agent);
	if (number) return number[1]!.slice(-3);
	const words = agent
		.replace(/^githive-/, "")
		.split(/[^A-Za-z]+/)
		.filter(Boolean);
	if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
	const word = words[0] ?? "?";
	return `${word[0]!.toUpperCase()}${word.slice(1, 2)}`;
}

/** The theme's claim hues no lamp means anything by: amber, green and red (claim-1, -5, -6) are left out. */
const QUIET_HUES = [0, 2, 3, 4, 7];

/** An agent's hue on its chip: one of the theme's (claim-0 … claim-7), the same wherever it shows. */
export function agentHue(agent: string): number {
	// FNV-1a, so names that differ by a letter land far apart.
	let hash = 0x811c9dc5;
	for (let index = 0; index < agent.length; index++) {
		hash ^= agent.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return QUIET_HUES[(hash >>> 0) % QUIET_HUES.length]!;
}

/** An agent's hue as a chip's ring: in SVG, and on a chip in the page. */
export const HUE_STROKE = [
	"stroke-claim-0",
	"stroke-claim-1",
	"stroke-claim-2",
	"stroke-claim-3",
	"stroke-claim-4",
	"stroke-claim-5",
	"stroke-claim-6",
	"stroke-claim-7",
];
export const HUE_BORDER = [
	"border-claim-0",
	"border-claim-1",
	"border-claim-2",
	"border-claim-3",
	"border-claim-4",
	"border-claim-5",
	"border-claim-6",
	"border-claim-7",
];

/**
 * A name cut to `fits` characters in the middle, so its end stays: "OrderSummary.tsx" → "Ord…mary.tsx". The start
 * keeps a short first word whole ("res.…File.js"), or else about a third; the end the rest, with the extension.
 */
export function middleCut(name: string, fits: number): string {
	if (name.length <= fits) return name;
	const room = fits - 1;
	const word = /^[^.\-_]{1,4}[.\-_]/.exec(name)?.[0];
	const head = word && room - word.length >= 6 ? word.length : Math.max(1, Math.floor(room * 0.3));
	return `${name.slice(0, head)}…${name.slice(name.length - (room - head))}`;
}

/**
 * Names drawn side by side, each cut to `fits`: in the middle, so the end stays, unless the end it keeps is another's
 * too and tells nothing ("res.…dges.js" for every file of a swarm); then at the end, where they differ
 * ("res.sendSta…").
 */
export function cellNames(names: string[], fits: number): string[] {
	return names.map((name, index) => {
		const middle = middleCut(name, fits);
		const end = middle.slice(middle.indexOf("…") + 1);
		const shared = middle !== name && names.some((other, at) => at !== index && other.endsWith(end));
		return shared ? `${name.slice(0, fits - 1)}…` : middle;
	});
}

/** Overpass's semibold lowercase letters' widths at 100px, a to z. */
const LOWER = [55, 57, 53, 57, 55, 35, 57, 58, 27, 27, 55, 28, 87, 58, 56, 57, 57, 41, 48, 39, 58, 54, 74, 56, 56, 53];

/** A letter's width at 1px: lowercase as measured, the rest by kind. */
function letterWidth(letter: string): number {
	const code = letter.charCodeAt(0) - 97;
	if (code >= 0 && code < 26) return LOWER[code]! / 100;
	if (letter === " ") return 0.25;
	if (/[.,:;'!|]/.test(letter)) return 0.25;
	if (/[MW]/.test(letter)) return 0.85;
	if (/[A-Z]/.test(letter)) return 0.68;
	if (/[0-9]/.test(letter)) return 0.62;
	if (letter === "…") return 1.02;
	return 0.6;
}

/** About how wide words are in the map's sans face at `size` px, semibold, a little over so they surely fit. */
export function sansWidth(text: string, size: number): number {
	let width = 0;
	for (const letter of text) width += letterWidth(letter);
	return width * size * 1.04;
}

/**
 * Words on up to as many lines as there's room for, each no wider than its room (`room[0]` for the first line, …):
 * broken at the space that fits best, evenly where it can, and cut short with "…" where nothing fits.
 */
export function fitLines(text: string, room: number[], width: (text: string) => number): string[] {
	if (width(text) <= room[0]! || room.length < 2) return [cutTo(text, room[0]!, width)];
	let best: { lines: string[]; uneven: number } | undefined;
	for (let at = text.indexOf(" "); at >= 0; at = text.indexOf(" ", at + 1)) {
		const lines = [text.slice(0, at), text.slice(at + 1)];
		const fits = lines.every((line, index) => width(line) <= room[index]!);
		const uneven = Math.abs(width(lines[0]!) - width(lines[1]!));
		if (fits && (!best || uneven < best.uneven)) best = { lines, uneven };
	}
	if (best) return best.lines;
	// Nothing fits: as many whole words on the first line as fit, the rest cut.
	let split = -1;
	for (let at = text.indexOf(" "); at >= 0; at = text.indexOf(" ", at + 1))
		if (width(text.slice(0, at)) <= room[0]!) split = at;
	if (split < 0) return [cutTo(text, room[0]!, width)];
	return [text.slice(0, split), cutTo(text.slice(split + 1), room[1]!, width)];
}

/** Text cut at its end with "…" until it fits. */
function cutTo(text: string, room: number, width: (text: string) => number): string {
	if (width(text) <= room) return text;
	let cut = text;
	while (cut.length > 1 && width(`${cut}…`) > room) cut = cut.slice(0, -1);
	return `${cut.trimEnd()}…`;
}
