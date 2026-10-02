import type { Amendment, MergeCheck, Slice, Task } from "./types";

// The task's record in Git. Every decision the Coordinator makes is appended
// to the project repo as a commit on the notes ref refs/notes/blueprint/<task>:
// - The notes themselves hang on the commits the decisions are about (a vote
//   on the reviewed commit, a gate result on the gated commit), one line per
//   decision, so `git log --notes=blueprint/<task>` reads as an audit trail.
// - Each notes commit's message ends with a JSON merge patch (RFC 7386) of the
//   task state. Replaying the patches in order rebuilds the state exactly, so
//   the Durable Object's copy is a cache of what's in Git.

export const notesRef = (taskId: string) => `refs/notes/blueprint/${taskId}`;

/** The trailer that carries the state patch in a notes commit's message. */
export const STATE_TRAILER = "Blueprint-State: ";

/** One decision, noted on the commit it is about. */
export interface LedgerEntry {
	commit: string;
	text: string;
	at: string;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

/**
 * The recorded form of a task: what scheduling rebuilds on its own (the queue
 * and running agents) is left out, and lists are keyed by id so a patch
 * touches one entry instead of replacing the list.
 */
export interface LedgerDoc {
	task: JsonObject;
	slices: Record<string, JsonObject>;
	amendments: Record<string, JsonObject>;
	checks: Record<string, JsonObject>;
	order: { slices: string[]; amendments: string[]; checks: string[] };
	contracts: Record<string, string>;
}

const checkKey = (c: MergeCheck) => c.pair.join("|");
const plain = <T>(value: T): Json => JSON.parse(JSON.stringify(value ?? null));
const keyed = <T>(items: T[], key: (item: T) => string) => Object.fromEntries(items.map((i) => [key(i), plain(i) as JsonObject]));

export function toDoc(task: Task, contracts: Record<string, string>): LedgerDoc {
	const { queue: _queue, active: _active, slices, amendments = [], checks, ...rest } = task;
	return {
		task: plain(rest) as JsonObject,
		slices: keyed(slices, (s) => s.id),
		amendments: keyed(amendments, (a) => a.id),
		checks: keyed(checks, checkKey),
		order: { slices: slices.map((s) => s.id), amendments: amendments.map((a) => a.id), checks: checks.map(checkKey) },
		contracts: { ...contracts },
	};
}

export function fromDoc(doc: LedgerDoc): { task: Task; contracts: Record<string, string> } {
	const pick = <T>(map: Record<string, JsonObject>, order: string[]) => order.map((id) => map[id] as unknown as T);
	const task = {
		...(doc.task as unknown as Task),
		slices: pick<Slice>(doc.slices, doc.order.slices),
		amendments: pick<Amendment>(doc.amendments, doc.order.amendments),
		checks: pick<MergeCheck>(doc.checks, doc.order.checks),
		queue: [],
		active: { builders: [], reviewers: [] },
	};
	return { task, contracts: doc.contracts };
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** A JSON merge patch from `a` to `b`, or undefined when they are equal. Values never contain null. */
export function diff(a: unknown, b: unknown): Json | undefined {
	if (isObject(a) && isObject(b)) {
		const patch: JsonObject = {};
		for (const key of Object.keys(a)) if (!(key in b)) patch[key] = null;
		for (const [key, value] of Object.entries(b)) {
			const d = key in a ? diff(a[key], value) : value;
			if (d !== undefined) patch[key] = d;
		}
		return Object.keys(patch).length ? patch : undefined;
	}
	return JSON.stringify(a) === JSON.stringify(b) ? undefined : (b as Json);
}

/** Apply a JSON merge patch (RFC 7386). */
export function applyPatch(target: unknown, patch: Json): Json {
	if (!isObject(patch)) return patch;
	const out: JsonObject = isObject(target) ? { ...target } : {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete out[key];
		else out[key] = applyPatch(out[key], value);
	}
	return out;
}

/** A notes commit's message: the decisions as a summary, then the state patch. */
export function ledgerMessage(entries: LedgerEntry[], patch: Json | undefined) {
	const summary = entries.length ? entries.map((e) => `- ${firstLine(e.text)}`).join("\n") : "- state update";
	return `${entries.length ? firstLine(entries[0].text) : "State update"}\n\n${summary}\n\n${STATE_TRAILER}${JSON.stringify(patch ?? {})}\n`;
}

export function patchOf(message: string): Json {
	const line = message.split("\n").find((l) => l.startsWith(STATE_TRAILER));
	return line ? (JSON.parse(line.slice(STATE_TRAILER.length)) as Json) : {};
}

/** Replay notes commits' messages, oldest first, into a task document. */
export function replay(messages: string[]): LedgerDoc {
	return messages.reduce<Json>((doc, m) => applyPatch(doc, patchOf(m)), {}) as unknown as LedgerDoc;
}

/** A note line: when, then the decision. Multi-line text is indented under it. */
export function noteLine(entry: LedgerEntry) {
	const [first, ...rest] = entry.text.trim().split("\n");
	return [`${entry.at.slice(0, 19).replace("T", " ")}Z  ${first}`, ...rest.map((l) => `    ${l}`)].join("\n");
}

const firstLine = (text: string) => clipText(text.trim().split("\n")[0], 160);

export const clipText = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
