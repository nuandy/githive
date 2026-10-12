import type { AlteredName, Overlap, RepoSnapshot, UseSite } from "../api";

// Where a change's footprint meets other open changes, as its page says it: what it alters that others use, and what
// it uses that others alter. The server finds them in the FootprintCache (docs/awareness.md, "Footprints and interface
// news"); these are the words for them. Advice only: nothing here decides anything.

/** How a change alters a name, said of the change doing it: "alters `x` (signature)", "removes `x`"… */
export const ALTERING: Record<AlteredName["change"], { verb: string; aside?: string }> = {
	interface: { verb: "alters", aside: "(signature)" },
	removed: { verb: "removes" },
	"no longer exported": { verb: "stops exporting" },
	"now exported": { verb: "exports" },
};

/** How another change alters a name this one uses, after the name: "which bob's c-9 removes", "whose signature …". */
export const ALTERED_BY: Record<AlteredName["change"], { lead: string; verb: string }> = {
	interface: { lead: "whose signature", verb: "alters" },
	removed: { lead: "which", verb: "removes" },
	"no longer exported": { lead: "which", verb: "stops exporting" },
	"now exported": { lead: "which", verb: "exports" },
};

/** The most use sites a line names; the rest are counted. */
export const SITES_SHOWN = 3;

/** "`src/jobs/sync.ts:4`": a use site as a line names it. */
export const siteName = (site: UseSite) => `${site.file}:${site.line}`;

/**
 * The overlaps with changes that hold a claim now, by the agent the footprint names: a footprint can outlive its
 * claim for a while (the cache drops it when it next looks). Two ways of using the same name of the same change (by
 * name and through the whole file) make one overlap, with the sites of both.
 */
export function openOverlaps(overlaps: Overlap[], claims: RepoSnapshot["claims"]): Overlap[] {
	const holders = new Map(claims.map((claim) => [claim.change, claim.agent]));
	const merged = new Map<string, Overlap>();
	for (const overlap of overlaps) {
		if (holders.get(overlap.other.change) !== overlap.other.by) continue;
		const key = [overlap.file, overlap.altered.name, overlap.other.change].join("\0");
		const known = merged.get(key);
		if (!known) {
			merged.set(key, { ...overlap, at: [...overlap.at] });
			continue;
		}
		const seen = new Set(known.at.map(siteName));
		known.at.push(...overlap.at.filter((site) => !seen.has(siteName(site))));
	}
	return [...merged.values()];
}
