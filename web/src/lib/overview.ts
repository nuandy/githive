import type { RepoSnapshot } from "../api";
import { claimAgent, claimTitle } from "./claimStatus";
import { type ClaimState, changeState, type StateContext } from "./status";
import { normalizePath } from "./tree";

// The repo's overview, drawn as a signal box's track plan: the changes landing
// on the project's branch, and the territory (the tree) with the parts
// agents hold lit by where their change is. A lamp is its change's state, in
// the colors, glyphs and patterns it has everywhere (status.ts).

type Claim = RepoSnapshot["claims"][number];

/** Where a claim's change is, most urgent first (the order a cell held by several shows): its state in force. */
export const LAMPS = [
	"needs-person",
	"changes-requested",
	"checks-failed",
	"abandoned",
	"landing",
	"approved",
	"in-review",
	"building",
] as const satisfies readonly ClaimState[];
export type Lamp = (typeof LAMPS)[number];

/**
 * What else a lamp reads: what's being checked to land, the votes (for when a change went back to its agent), who
 * may vote as each role, and the time.
 */
export type LampContext = StateContext;

/**
 * Where a claim's change is (see status.ts): waiting on a person, abandoned by its agent (see staleness.ts: the
 * toolkit frees it the same way), being checked to land, sent back, approved, pushed for review, or still being
 * built.
 */
export function lampOf(claim: Claim, context: LampContext = {}): Lamp {
	return changeState(claim, { ...context, now: context.now ?? Date.now() });
}

/** How many claims show each lamp. */
export function lampCounts(claims: Claim[], context: LampContext = {}): Record<Lamp, number> {
	const counts = Object.fromEntries(LAMPS.map((lamp) => [lamp, 0])) as Record<Lamp, number>;
	for (const claim of claims) counts[lampOf(claim, context)]++;
	return counts;
}

/** A claim as the territory shows it. */
export interface Holder {
	change: string;
	title: string;
	agent: string;
	lamp: Lamp;
}

/** A cell of the territory: a folder or file one level inside a top-level folder (or a top-level file). */
export interface Cell {
	name: string;
	path: string;
	/** Claims on it or inside it, the most urgent first. */
	holders: Holder[];
	/** A folder (else a file). */
	folder?: boolean;
	/** Not in the tree yet: a claim on something a change will create. */
	planned?: boolean;
}

/** A top-level folder, or "" for the files at the top. */
export interface Region {
	name: string;
	files: number;
	cells: Cell[];
	/** A claim on the whole folder. */
	whole: Holder[];
}

/** The most cells a region draws; past that, it says how many more. */
export const MAX_CELLS = 400;

const rank = (lamp: Lamp) => LAMPS.indexOf(lamp);
const byUrgency = (a: Holder, b: Holder) => rank(a.lamp) - rank(b.lamp) || a.change.localeCompare(b.change);

/**
 * The territory: the tree's top-level folders (and its top-level files as
 * one region), each split into what's one level inside it, with every claim
 * placed on the cell it covers. A claim on a whole folder lights all of it.
 */
export function territory(files: string[], claims: Claim[], context: LampContext = {}): Region[] {
	const regions = new Map<string, Region>();
	const cells = new Map<string, Cell>();
	const regionOf = (name: string) => {
		let region = regions.get(name);
		if (!region) regions.set(name, (region = { name, files: 0, cells: [], whole: [] }));
		return region;
	};
	const cellOf = (region: Region, name: string, planned: boolean) => {
		const path = region.name ? `${region.name}/${name}` : name;
		let cell = cells.get(path);
		if (!cell) {
			cells.set(path, (cell = { name, path, holders: [], ...(planned ? { planned: true } : {}) }));
			region.cells.push(cell);
		}
		return cell;
	};
	for (const file of files) {
		const parts = normalizePath(file).split("/");
		const [first = "", second] = parts;
		const region = regionOf(second === undefined ? "" : first);
		region.files++;
		const cell = cellOf(region, second ?? first, false);
		if (parts.length > 2) cell.folder = true;
	}
	for (const claim of claims) {
		const holder: Holder = {
			change: claim.change,
			title: claimTitle(claim),
			agent: claimAgent(claim),
			lamp: lampOf(claim, context),
		};
		for (const claimed of claim.paths) {
			const parts = normalizePath(claimed).split("/").filter(Boolean);
			const [first, second] = parts;
			if (first === undefined) {
				// The whole repo.
				for (const region of regions.values()) region.whole.push(holder);
				continue;
			}
			const isFolder = claimed.endsWith("/") || parts.length > 1 || regions.has(first);
			const region = regionOf(isFolder ? first : "");
			if (isFolder && parts.length === 1) region.whole.push(holder);
			else {
				// Here a folder claim has a second segment naming its cell, and a file claim has only its first.
				const cellName = second ?? first;
				const cellPath = isFolder ? `${first}/${cellName}` : first;
				const cell = cellOf(region, cellName, !cells.has(cellPath));
				if (isFolder && (parts.length > 2 || claimed.endsWith("/"))) cell.folder = true;
				if (!cell.holders.some((other) => other.change === holder.change)) cell.holders.push(holder);
			}
		}
	}
	for (const region of regions.values()) {
		region.whole.sort(byUrgency);
		region.cells.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
		for (const cell of region.cells) cell.holders.sort(byUrgency);
	}
	// Folders first, alphabetically; the top-level files last.
	const foldersFirst = (a: Region, b: Region) => Number(!a.name) - Number(!b.name) || a.name.localeCompare(b.name);
	return [...regions.values()].sort(foldersFirst);
}

/** The lamp a cell shows: its own most urgent claim's, else its folder's. */
export function cellLamp(cell: Cell, region: Region): Lamp | undefined {
	return (cell.holders[0] ?? region.whole[0])?.lamp;
}
