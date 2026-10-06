import type { MergeCheck, SliceSpec } from "./types";

/** Plain-language Merge-ahead feedback for the builder after a push. */
export function pushFeedback(sliceId: string, outOfLane: string[], checks: MergeCheck[], siblings: Pick<SliceSpec, "id" | "owns">[]) {
	const lines: string[] = [];
	if (outOfLane.length)
		lines.push(`These files are outside your lane and must be reverted before you finish: ${outOfLane.join(", ")}.`);
	const conflicts = checks.filter((c) => c.status === "conflict" && c.pair.includes(sliceId));
	for (const c of conflicts) {
		const other = c.pair[0] === sliceId ? c.pair[1] : c.pair[0];
		const who = other === "base" ? "the task base (work already integrated)" : `slice ${other}`;
		const lane = siblings.find((s) => s.id === other)?.owns.join(", ");
		lines.push(
			`Conflict with ${who} in ${c.files.join(", ")}.${lane ? ` ${other} owns ${lane}.` : ""} Change your work so it no longer edits these files, or ask its owner for what you need (request_lane_change).`,
		);
	}
	if (!lines.length) lines.push("No conflicts with the other slices' work in progress, and everything is inside your lane.");
	return lines.join("\n");
}
