// The backlog's record: adding pieces to it, adding what a piece waits on, and taking pieces out. Every write is a
// compare-and-swap on the backlog's log, like the claims' and votes'.
import type { CasLog } from "../record-log";
import { appendRecord } from "./records";
import type { Work, WorkItem } from "./work";

/** Adds an item to the backlog, refused if its id is taken. */
export function addWork(log: CasLog<Work>, input: Omit<WorkItem, "at">) {
	return appendRecord<Work, string>(
		log,
		input.by,
		() => ({ items: [] }),
		(state) => {
			if (state.items.some((item) => item.id === input.id)) return { refused: `${input.id} is in the backlog already` };
			return {
				state: { items: [...state.items, { ...input, at: new Date().toISOString() }] },
				text: `${input.by} adds ${input.id} to the backlog: ${input.title}`,
			};
		},
	);
}

/** Adds several items in one write. Items whose ids are taken are left alone and returned in `already`. */
export async function addWorks(log: CasLog<Work>, by: string, items: Omit<WorkItem, "at" | "by">[]) {
	let already: string[] = [];
	const outcome = await appendRecord<Work, string>(
		log,
		by,
		() => ({ items: [] }),
		(state) => {
			const taken = (item: { id: string }) => state.items.some((existing) => existing.id === item.id);
			already = items.filter(taken).map((item) => item.id);
			const fresh = items.filter((item) => !already.includes(item.id));
			if (!fresh.length) return { refused: "all of them are in the backlog already" };
			const at = new Date().toISOString();
			return {
				state: { items: [...state.items, ...fresh.map((item) => ({ ...item, by, at }))] },
				text: `${by} adds ${fresh.map((item) => item.id).join(", ")} to the backlog`,
			};
		},
	);
	const added = outcome.ok ? items.map((item) => item.id).filter((id) => !already.includes(id)) : [];
	return { ok: outcome.ok, added, already };
}

/**
 * Adds to what a piece already in the backlog waits on (`after`) or lands after (`landsAfter`). Refused for a piece
 * that isn't there, and for one that would wait on itself through others, which would never be offered.
 */
export function addDependencies(
	log: CasLog<Work>,
	by: string,
	input: { piece: string; after: string[]; landsAfter: string[] },
) {
	return appendRecord<Work, string>(
		log,
		by,
		() => ({ items: [] }),
		(state) => {
			const item = state.items.find((each) => each.id === input.piece);
			if (!item) return { refused: `${input.piece} isn't in the backlog` };
			const after = [...new Set([...(item.after ?? []), ...input.after])];
			const landsAfter = [...new Set([...(item.landsAfter ?? []), ...input.landsAfter])];
			const updated: WorkItem = { ...item, after, landsAfter };
			if (!after.length) delete updated.after;
			if (!landsAfter.length) delete updated.landsAfter;
			const items = state.items.map((each) => (each.id === input.piece ? updated : each));
			const loop = loopThrough(items, input.piece);
			if (loop) return { refused: `${input.piece} would wait on itself: ${loop.join(" waits on ")}` };
			const named = [...input.after, ...input.landsAfter].join(", ");
			return { state: { items }, text: `${by} makes ${input.piece} wait on ${named}` };
		},
	);
}

/** A chain of pieces from `start` that waits back on it, or undefined. */
function loopThrough(items: WorkItem[], start: string): string[] | undefined {
	const byId = new Map(items.map((item) => [item.id, item]));
	const seen = new Set<string>();
	const walk = (id: string, path: string[]): string[] | undefined => {
		const item = byId.get(id);
		for (const dependency of [...(item?.after ?? []), ...(item?.landsAfter ?? [])]) {
			if (dependency === start) return [...path, dependency];
			if (seen.has(dependency)) continue;
			seen.add(dependency);
			const found = walk(dependency, [...path, dependency]);
			if (found) return found;
		}
		return undefined;
	};
	return walk(start, [start]);
}

/** Takes every piece `by` added out of the backlog, with the reason; nothing to take is no write. */
export function withdrawWork(log: CasLog<Work>, by: string, reason: string) {
	return appendRecord<Work, string>(
		log,
		by,
		() => ({ items: [] }),
		(state) => {
			const kept = state.items.filter((item) => item.by !== by);
			if (kept.length === state.items.length) return { refused: `${by} has nothing in the backlog` };
			return { state: { items: kept }, text: `${by} takes its pieces out of the backlog: ${reason}` };
		},
	);
}
