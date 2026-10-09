import type { RepoLine, RepoSnapshot } from "../api";
import { abandoned } from "../../../src/toolkit/staleness";
import { claimAgent, claimTitle } from "./claimStatus";
import { normalizePath } from "./tree";

// The repo's overview, drawn as a signal box's track plan: the line of merges
// into the project's branch, and the territory (the tree) with the parts
// agents hold lit by where their change is. A lamp means the same thing
// everywhere: amber while work is under way, green once it passed, red when
// it failed or waits on a person.

type Claim = RepoSnapshot["claims"][number];

/** Where a claim's change is, most urgent first (the order a cell held by several shows). */
export const LAMPS = ["attention", "abandoned", "checking", "passed", "approved", "review", "building"] as const;
export type Lamp = (typeof LAMPS)[number];

/** How each lamp reads, in a sentence's words. */
export const LAMP_WORDS: Record<Lamp, string> = {
	attention: "needs a person",
	abandoned: "abandoned, free to take",
	checking: "checking in line",
	passed: "passed, landing",
	approved: "approved",
	review: "waiting for review",
	building: "being built",
};

/** Which of the three lamp colors a state shows. */
export const lampColor = (lamp: Lamp): "red" | "amber" | "green" => (lamp === "attention" ? "red" : lamp === "passed" || lamp === "approved" ? "green" : "amber");

/** What else a lamp reads: the line, the votes (for when a change's turn came back to its agent), and the time. */
export interface LampContext {
	line?: Pick<RepoLine, "entries"> & Partial<Pick<RepoLine, "left">>;
	votes?: RepoSnapshot["votes"];
	now?: number;
}

/** How a line's leaving hands a change back to its agent (as the toolkit counts it). */
const LEFT_TO_AGENT = new Set(["failed", "gave up", "went quiet"]);

/**
 * Where a claim's change is: waiting on a person, abandoned by its agent (see
 * staleness.ts: the toolkit frees it the same way), in line, approved, pushed
 * for review, or still being built.
 */
export function lampOf(claim: Claim, context: LampContext = {}): Lamp {
	if (claim.attention || claim.approval.vetoedBy.length) return "attention";
	const { line, votes = [], now = Date.now() } = context;
	const inLine = line?.entries.find((e) => e.change === claim.change);
	const left = claim.head ? line?.left?.filter((l) => l.change === claim.change && l.head === claim.head && LEFT_TO_AGENT.has(l.how)).at(-1) : undefined;
	const onHead = claim.head ? votes.filter((v) => v.commit === claim.head && v.reviewer !== claim.agent) : [];
	const signs = { active: claim.active, head: claim.head, votes: onHead.map((v) => ({ verdict: v.verdict, at: v.at })), approved: claim.approval.approved, inLine: !!inLine, asked: false, ...(left ? { leftLineAt: left.at } : {}) };
	if (abandoned(signs, now).abandoned) return "abandoned";
	if (inLine) return inLine.status === "passed" ? "passed" : "checking";
	if (claim.approval.approved) return "approved";
	return claim.head ? "review" : "building";
}

/** How many claims show each lamp. */
export function lampCounts(claims: Claim[], context: LampContext = {}): Record<Lamp, number> {
	const counts = Object.fromEntries(LAMPS.map((l) => [l, 0])) as Record<Lamp, number>;
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
		const region = regionOf(parts.length > 1 ? parts[0] : "");
		region.files++;
		const cell = cellOf(region, parts.length > 1 ? parts[1] : parts[0], false);
		if (parts.length > 2) cell.folder = true;
	}
	for (const claim of claims) {
		const holder: Holder = { change: claim.change, title: claimTitle(claim), agent: claimAgent(claim), lamp: lampOf(claim, context) };
		for (const claimed of claim.paths) {
			const parts = normalizePath(claimed).split("/").filter(Boolean);
			if (!parts.length) {
				// The whole repo.
				for (const region of regions.values()) region.whole.push(holder);
				continue;
			}
			const isFolder = claimed.endsWith("/") || parts.length > 1 || regions.has(parts[0]);
			const region = regionOf(isFolder ? parts[0] : "");
			if (isFolder && parts.length === 1) region.whole.push(holder);
			else {
				const cell = cellOf(region, isFolder ? parts[1] : parts[0], !cells.has(isFolder ? `${parts[0]}/${parts[1]}` : parts[0]));
				if (isFolder && (parts.length > 2 || claimed.endsWith("/"))) cell.folder = true;
				if (!cell.holders.some((h) => h.change === holder.change)) cell.holders.push(holder);
			}
		}
	}
	for (const region of regions.values()) {
		region.whole.sort(byUrgency);
		region.cells.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
		for (const cell of region.cells) cell.holders.sort(byUrgency);
	}
	// Folders first, alphabetically; the top-level files last.
	return [...regions.values()].sort((a, b) => Number(!a.name) - Number(!b.name) || a.name.localeCompare(b.name));
}

/** The lamp a cell shows: its own most urgent claim's, else its folder's. */
export function cellLamp(cell: Cell, region: Region): Lamp | undefined {
	return (cell.holders[0] ?? region.whole[0])?.lamp;
}
