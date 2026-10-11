import type { ChangePush } from "./repo-cache";
import type { Settled } from "./toolkit/landing";

// The hive's recent events, for the dashboard's live feed: who claimed, pushed, voted and landed what, as it
// happened. The records in Git hold the truth; this is a short rolling log for watching, so losing it loses nothing.

export type HiveEventKind =
	| "claimed"
	| "released"
	| "pushed"
	| "voted"
	| "merging"
	| "landed"
	| "failed"
	| "asked"
	| "reverted"
	| "added"
	| "building"
	// Awareness (see docs/awareness.md): a landed change altered a name another change uses; two open changes each
	// alter a name the other uses; a merge conflicted with the branch.
	| "interface"
	| "heads_up"
	| "conflicted";

export interface HiveEvent {
	kind: HiveEventKind;
	/**
	 * Who did it. A push names only its change; the claim on the change says whose it is. For an interface change,
	 * who landed it (a commit GitHive didn't make, its author).
	 */
	agent?: string;
	/** For an interface change or a heads-up, the change it matters to. */
	change?: string;
	/** The commit pushed, voted on, landed or reverted. */
	commit?: string;
	/** A vote's verdict. */
	verdict?: "approve" | "reject";
	/**
	 * The other agent: whose change uses an interface that changed, or the other side of a heads-up. Without it,
	 * the claim on the change says.
	 */
	other?: string;
	/** The other side's change, for a heads-up: one agent's two changes are two heads-ups, kept apart. */
	otherChange?: string;
	/**
	 * A few words on it: the intent claimed, the role voted as, why a landing failed, the names an interface change
	 * or a heads-up is about, the files a merge conflicted on.
	 */
	detail?: string;
	at: string;
}

/** How many events the log keeps; the newest are kept. */
export const EVENTS_KEPT = 100;

/**
 * An event's key in the log: its time first, so keys sort oldest first, and the same for an event sent twice. It
 * leaves out `detail`, so two events that differ only there are kept as one: an emitter writes one event per
 * occurrence, such as one per change an interface change matters to.
 */
export const eventKey = (event: HiveEvent) =>
	[
		event.at,
		event.kind,
		event.agent,
		event.change,
		event.commit,
		...(event.other ? [event.other] : []),
		...(event.otherChange ? [event.otherChange] : []),
	].join(" ");

const textOf = (args: Record<string, unknown>, key: string) =>
	typeof args[key] === "string" ? (args[key] as string) : undefined;

/** The event for a tool call that wrote, or null for one the hive doesn't show (settings). */
export function toolEvent(name: string, args: Record<string, unknown>, caller?: string, now = new Date()) {
	const at = now.toISOString();
	const agent = textOf(args, "agent") ?? caller;
	const change = textOf(args, "change");
	const base = { ...(agent ? { agent } : {}), ...(change ? { change } : {}), at };
	switch (name) {
		case "claim":
			return event("claimed", base, textOf(args, "intent"));
		case "release":
			return event("released", base, textOf(args, "reason"));
		case "merge":
			return event("merging", base);
		case "ask_human":
			return event("asked", base, textOf(args, "reason"));
		case "build":
			return event("building", base, textOf(args, "intent"));
		case "revert":
			return event("reverted", { ...base, commit: textOf(args, "commit") ?? "" });
		case "add_work":
			return event("added", base, workAdded(args));
		case "vote":
			return voteEvent(args, caller, at);
		default:
			return null;
	}
}

function event(kind: HiveEventKind, base: Omit<HiveEvent, "kind">, detail?: string): HiveEvent {
	return { kind, ...base, ...(detail ? { detail } : {}) };
}

function voteEvent(args: Record<string, unknown>, caller: string | undefined, at: string): HiveEvent {
	const reviewer = textOf(args, "reviewer") ?? caller;
	const verdict = textOf(args, "verdict") === "approve" ? "approve" : "reject";
	const role = textOf(args, "role");
	const commit = textOf(args, "commit") ?? "";
	return {
		kind: "voted",
		...(reviewer ? { agent: reviewer } : {}),
		commit,
		verdict,
		...(role ? { detail: role } : {}),
		at,
	};
}

function workAdded(args: Record<string, unknown>) {
	const items = Array.isArray(args.items) ? args.items.length : 0;
	if (items === 1) return "1 piece of work";
	if (items) return `${items} pieces of work`;
	return textOf(args, "title");
}

/** The events for pushes to changes' branches. A deleted branch isn't shown. */
export function pushEvents(pushes: ChangePush[]): HiveEvent[] {
	return pushes.flatMap(({ change, head, at }) =>
		head ? [{ kind: "pushed" as const, change, commit: head, at: new Date(at).toISOString() }] : [],
	);
}

/** The events for a landing batch's outcomes. */
export function settledEvents(outcomes: Settled[]): HiveEvent[] {
	return outcomes.map((outcome) => {
		const landed = outcome.how === "landed";
		const reason = landed ? undefined : outcome.reasons?.[0];
		return {
			kind: landed ? "landed" : "failed",
			agent: outcome.agent,
			change: outcome.change,
			commit: outcome.commit ?? outcome.head,
			...(reason ? { detail: reason } : {}),
			at: outcome.at,
		};
	});
}
