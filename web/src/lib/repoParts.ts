// What each kind of change from a repo's live feed (see liveFeed.ts) touches on its page, so a message reads again
// only those parts. A kept view rebuilt touches only itself; awareness only adds events, which the hive's feed shows
// as they come. Any other kind, or "missed", touches everything.

/** A part of a repo's page that's read on its own. */
export type RepoPart = "snapshot" | "audit" | "change";

const EVERYTHING: RepoPart[] = ["snapshot", "audit", "change"];

const TOUCHES: Record<string, RepoPart[]> = {
	records: EVERYTHING,
	pushed: ["snapshot", "change"],
	landing: EVERYTHING,
	awareness: [],
	"view:snapshot": ["snapshot"],
	"view:audit": ["audit"],
};

function partsOf(kind: string): RepoPart[] {
	if (kind.startsWith("view:change:")) return ["change"];
	// A branch's history is read by its own tab, as it's shown.
	if (kind.startsWith("view:history:")) return [];
	return TOUCHES[kind] ?? EVERYTHING;
}

/** The parts of a repo's page these kinds of change touch. */
export function touchedBy(kinds: string[]): Set<RepoPart> {
	return new Set(kinds.flatMap(partsOf));
}
