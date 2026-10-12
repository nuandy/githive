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

/** What's happening in a cell, loudest first. */
export const CELL_STATES = [
	"asking",
	"revising",
	"landing",
	"approved",
	"review",
	"building",
	"landed",
	"next",
	"free",
] as const;
export type CellState = (typeof CELL_STATES)[number];

const CELL_STATE_OF: Partial<Record<Goal["state"], CellState>> = {
	asking: "asking",
	revising: "revising",
	landing: "landing",
	approved: "approved",
	"in-review": "review",
	building: "building",
};

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
	const loudness = (goal: Goal) => CELL_STATES.indexOf(CELL_STATE_OF[goal.state] ?? "free");
	const working = [...inFlight.values()].sort((a, b) => loudness(a) - loudness(b));
	cell.goals = working.map((goal) => goal.key);
	cell.agents = [...new Set(working.map((goal) => goal.agent))];
	if (landed) {
		cell.landed = { agent: landed.agent, at: landed.finished! };
		cell.goals.push(landed.key);
	}
	const loudest = working[0];
	if (loudest) cell.state = CELL_STATE_OF[loudest.state] ?? "building";
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
