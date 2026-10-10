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
	for (let i = 0; i < agent.length; i++) {
		hash ^= agent.charCodeAt(i);
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
	const big = context.big ?? BIG_FOLDER;
	const tops = new Map<string, Folder>();
	let rootFiles = 0;
	for (const file of files) {
		const parts = segments(file);
		if (!parts.length) continue;
		if (parts.length === 1) {
			rootFiles++;
			continue;
		}
		let top = tops.get(parts[0]);
		if (!top) tops.set(parts[0], (top = { files: 0, direct: 0, subs: new Map() }));
		top.files++;
		if (parts.length === 2) top.direct++;
		else top.subs.set(parts[1], (top.subs.get(parts[1]) ?? 0) + 1);
	}

	const claimed = claims.flatMap((claim) =>
		claim.paths.map((raw) => ({ raw, parts: segments(raw), folder: raw.endsWith("/") })),
	);
	const claimedBelow = (top: string) => claimed.some((c) => c.parts.length >= 2 && c.parts[0] === top);
	const split = new Set(
		[...tops]
			.filter(([name, top]) => top.subs.size > 0 && (top.files > big || claimedBelow(name)))
			.map(([name]) => name),
	);

	const hexes = new Map<string, Hex>();
	const add = (hex: Hex) => {
		if (!hexes.has(hex.key)) hexes.set(hex.key, hex);
	};
	const filesHex = (top: string, count: number, planned: boolean): Hex => ({
		key: top ? `${top}/*` : "*",
		path: top,
		kind: "files",
		name: top ? "files" : "top-level files",
		...(top ? { parent: top } : {}),
		files: count,
		...(planned ? { planned: true } : {}),
		holders: [],
	});
	for (const [name, top] of tops) {
		if (!split.has(name)) {
			add({ key: name, path: name, kind: "folder", name, files: top.files, holders: [] });
			continue;
		}
		if (top.direct) add(filesHex(name, top.direct, false));
		for (const [sub, count] of top.subs)
			add({
				key: `${name}/${sub}`,
				path: `${name}/${sub}`,
				kind: "folder",
				name: sub,
				parent: name,
				files: count,
				holders: [],
			});
	}
	if (rootFiles) add(filesHex("", rootFiles, false));

	// Claims on what isn't there yet: a new folder, or a new file in a split folder or at the top.
	for (const { parts, folder } of claimed) {
		if (!parts.length) continue;
		const [first, second] = parts;
		const top = tops.get(first);
		const isFolderClaim = folder || parts.length > 1;
		if (!top) {
			if (isFolderClaim)
				add({ key: first, path: first, kind: "folder", name: first, files: 0, planned: true, holders: [] });
			else if (!hexes.has("*")) add(filesHex("", 0, true));
			continue;
		}
		if (!split.has(first) || parts.length < 2) continue;
		if (top.subs.has(second)) continue;
		if (parts.length > 2 || folder)
			add({
				key: `${first}/${second}`,
				path: `${first}/${second}`,
				kind: "folder",
				name: second,
				parent: first,
				files: 0,
				planned: true,
				holders: [],
			});
		else if (!hexes.has(`${first}/*`)) add(filesHex(first, 0, true));
	}

	const isSub = (top: string, name: string) =>
		hexes.has(`${top}/${name}`) && hexes.get(`${top}/${name}`)!.kind === "folder";
	const isTopFolder = (name: string) => hexes.get(name)?.kind === "folder" || tops.has(name);
	/** How a claimed path meets a cell: covering all of it, inside it, or not at all. */
	const meet = (hex: Hex, raw: string): "whole" | "part" | undefined => {
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
		if (hex.path ? parts[0] !== hex.path || isSub(hex.path, parts[1]) : isTopFolder(parts[0])) return undefined;
		return "part";
	};

	for (const claim of claims) {
		const base = {
			change: claim.change,
			title: claimTitle(claim),
			intent: claim.intent ?? "",
			agent: claimAgent(claim),
			since: claim.since,
			color: agentColor(claimAgent(claim)),
			lamp: lampOf(claim, context),
		};
		for (const hex of hexes.values()) {
			let whole: string | undefined;
			const inside: string[] = [];
			for (const raw of claim.paths) {
				const how = meet(hex, raw);
				if (how === "whole" && (whole === undefined || normalizePath(raw).length > normalizePath(whole).length))
					whole = raw;
				else if (how === "part") inside.push(raw);
			}
			if (whole !== undefined) hex.holders.push({ ...base, whole: true, paths: [whole] });
			else if (inside.length) hex.holders.push({ ...base, whole: false, paths: inside });
		}
	}

	for (const hex of hexes.values()) {
		hex.holders.sort(
			(a, b) =>
				Number(b.whole) - Number(a.whole) ||
				(a.whole ? normalizePath(b.paths[0]).length - normalizePath(a.paths[0]).length : 0) ||
				a.since.localeCompare(b.since) ||
				a.change.localeCompare(b.change),
		);
		const landing: HexLanding | undefined = hex.holders.some((h) => h.lamp === "checking")
			? "checking"
			: hex.holders.some((h) => h.lamp === "approved")
				? "queued"
				: undefined;
		if (landing) hex.landing = landing;
	}

	// Folders by name, each split one's cells together (its own files first); the top-level files last.
	const order = (hex: Hex) => (hex.parent ? [hex.parent, hex.kind === "files" ? "" : hex.name] : [hex.name, ""]);
	return [...hexes.values()].sort((a, b) => {
		if ((a.key === "*") !== (b.key === "*")) return a.key === "*" ? 1 : -1;
		const [a1, a2] = order(a);
		const [b1, b2] = order(b);
		return a1.localeCompare(b1, undefined, { numeric: true }) || a2.localeCompare(b2, undefined, { numeric: true });
	});
}

/** The agents holding cells, each with its color and changes, in name order. */
export function hiveAgents(
	claims: Claim[],
	context: LampContext = {},
): {
	agent: string;
	color: number;
	changes: { change: string; title: string; intent: string; since: string; lamp: Lamp }[];
}[] {
	const agents = new Map<
		string,
		{
			agent: string;
			color: number;
			changes: { change: string; title: string; intent: string; since: string; lamp: Lamp }[];
		}
	>();
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
	for (let i = 0; i < 6; i++) {
		const angle = (Math.PI / 180) * (60 * i - 90);
		corners.push(`${round(cx + radius * Math.cos(angle))},${round(cy + radius * Math.sin(angle))}`);
	}
	return corners.join(" ");
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Cell centers for `count` cells in rows of `columns`, every other row shifted half a cell, and the map's size. */
export function hexGrid(
	count: number,
	columns: number,
	radius: number,
): { centers: { x: number; y: number }[]; width: number; height: number } {
	const cols = Math.max(1, Math.min(columns, count || 1));
	const w = Math.sqrt(3) * radius;
	const rowHeight = 1.5 * radius;
	const rows = Math.max(1, Math.ceil(count / cols));
	const centers = Array.from({ length: count }, (_, i) => {
		const row = Math.floor(i / cols);
		const col = i % cols;
		return { x: round(w / 2 + col * w + (row % 2 ? w / 2 : 0)), y: round(radius + row * rowHeight) };
	});
	return {
		centers,
		width: round(cols * w + (rows > 1 ? w / 2 : 0)),
		height: round(2 * radius + (rows - 1) * rowHeight),
	};
}
