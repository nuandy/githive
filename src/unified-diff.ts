import { linesOf, matched } from "./diff3";

// A file's change as `git diff` shows it: hunks of lines kept, removed and added, each with a few lines of context
// around it, for the change page's Files tab. The common lines are diff3's (Myers' diff), looked for through more
// edits than a merge's markers need: past that it stays right, only coarser.

/** One hunk: where it starts on each side and how many lines it spans there, as "@@ -a,b +c,d @@" says. */
export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	/**
	 * Its lines, each marked: " " kept, "-" removed, "+" added, without its line ending. A line with no newline at the
	 * end of its file is followed by "\ No newline at end of file", as git writes it.
	 */
	lines: string[];
}

/** How many inserted or deleted lines a file's diff looks through for common ones. */
export const DIFF_MOST_EDITS = 1000;

export const NO_NEWLINE = "\\ No newline at end of file";

type Op = { mark: " " | "-" | "+"; line: string; a: number; b: number };

/** The hunks between `before` and `after`, and how many lines it adds and removes. */
export function unifiedDiff(
	before: string,
	after: string,
	{ context = 3, mostEdits = DIFF_MOST_EDITS }: { context?: number; mostEdits?: number } = {},
): { hunks: DiffHunk[]; added: number; removed: number } {
	const [a, b] = [linesOf(before), linesOf(after)];
	const kept = matched(a, b, mostEdits);
	// Every line in order, a and b being how many of each side's lines come before it.
	const ops: Op[] = [];
	let [i, j] = [0, 0];
	while (i < a.length || j < b.length) {
		if (i < a.length && kept[i] === j) ops.push({ mark: " ", line: b[j]!, a: i++, b: j++ });
		else if (i < a.length && kept[i] === -1) ops.push({ mark: "-", line: a[i]!, a: i++, b: j });
		else ops.push({ mark: "+", line: b[j]!, a: i, b: j++ });
	}
	const changed = ops.flatMap((op, index) => (op.mark === " " ? [] : [index]));
	const hunks: DiffHunk[] = [];
	for (let first = 0; first < changed.length;) {
		// Changes no more than twice the context apart share a hunk.
		let last = first;
		while (last + 1 < changed.length && changed[last + 1]! - changed[last]! <= 2 * context + 1) last++;
		const from = Math.max(0, changed[first]! - context);
		const to = Math.min(ops.length, changed[last]! + context + 1);
		hunks.push(hunkOf(ops.slice(from, to), ops[from]!));
		first = last + 1;
	}
	return {
		hunks,
		added: ops.filter((op) => op.mark === "+").length,
		removed: ops.filter((op) => op.mark === "-").length,
	};
}

function hunkOf(ops: Op[], start: Op): DiffHunk {
	const oldLines = ops.filter((op) => op.mark !== "+").length;
	const newLines = ops.filter((op) => op.mark !== "-").length;
	return {
		// A side with no lines here starts at the line before, as git counts it.
		oldStart: oldLines ? start.a + 1 : start.a,
		oldLines,
		newStart: newLines ? start.b + 1 : start.b,
		newLines,
		lines: ops.flatMap((op) => {
			const shown = `${op.mark}${op.line.replace(/\r?\n$/, "")}`;
			return op.line.endsWith("\n") ? [shown] : [shown, NO_NEWLINE];
		}),
	};
}
