// The server's decision log speaks in internal terms (slices, lanes, the gate,
// quorum, the task base). People read changes, claims, checks, reviews and
// the project's branch (main, master, ...). Change ids are protected so a
// change named, say, "fix-gate" keeps its name.

const REPLACEMENTS = (branch: string): [RegExp, string][] => [
	[/integrated into the task base/g, `merged into ${branch}`],
	[/\bthe task base\b/g, branch],
	[/\btask base\b/g, branch],
	[/\bMerge-ahead:\s*/g, ""],
	[/\b[Mm]erge-ahead\b/g, "conflict check"],
	[/\bintegrated\b/g, "merged"],
	[/\bIntegrated\b/g, "Merged"],
	[/\bintegrate\b/g, "merge"],
	[/\bintegration\b/g, "merge"],
	[/\bSlices\b/g, "Changes"],
	[/\bslices\b/g, "changes"],
	[/\bSlice\b/g, "Change"],
	[/\bslice\b/g, "change"],
	[/\b[Cc]ross-lane\b/g, "cross-claim"],
	[/\bout of lane\b/g, "outside its claim"],
	[/\blanes\b/g, "claims"],
	[/\blane\b/g, "claim"],
	[/\bquorum (approved|rejected|vetoed|waived|pending)\b/g, "review $1"],
	[/\bquorum\b/g, "review"],
	[/\bgate passed\b/g, "checks passed"],
	[/\bgate failed\b/g, "checks failed"],
	[/\bgate re-run\b/g, "checks re-run"],
	[/\bthe gate re-runs\b/g, "the checks run again"],
	[/\bgate result\b/g, "check result"],
	[/\bgating\b/g, "running checks"],
	[/\bgate\b/g, "checks"],
	[/\bneeds a human\b/g, "needs you"],
	[/\bservice token\s+/g, ""],
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Rewrite internal vocabulary for people, leaving the given change ids untouched. `branch` is the project's branch. */
export function humanizeText(text: string, protectedIds: string[] = [], branch = "main"): string {
	const ids = [...new Set(protectedIds.filter(Boolean))].sort((a, b) => b.length - a.length);
	const saved: string[] = [];
	let out = text;
	if (ids.length) {
		const pattern = new RegExp(`(^|[^A-Za-z0-9_-])(${ids.map(escape).join("|")})(?![A-Za-z0-9_-])`, "g");
		out = out.replace(pattern, (_match, before: string, id: string) => {
			saved.push(id);
			return `${before}\u0000${saved.length - 1}\u0000`;
		});
	}
	for (const [pattern, replacement] of REPLACEMENTS(branch)) out = out.replace(pattern, replacement);
	return out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => saved[Number(index)]);
}

/** Whether a log line names this change id as a whole word (hyphens count as part of a word). */
export function mentionsChange(text: string, id: string): boolean {
	if (!id) return false;
	return new RegExp(`(^|[^A-Za-z0-9_-])${escape(id)}(?![A-Za-z0-9_-])`).test(text);
}
