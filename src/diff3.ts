// A small three-way merge of text, line by line, writing git's conflict markers where both sides changed the same
// lines. It shows an agent what conflicted (see Workspace.tryMerge); git itself does the real merge, so this needn't
// match git's choices exactly, only never call a conflict clean. Bounded: past MOST_EDITS a diff gives up on
// finding common lines, which makes its conflicts coarser, never wrong.

/** How many inserted or deleted lines a diff looks through for common ones before treating the rest as changed. */
const MOST_EDITS = 200;
const MARKER = 7;

/** A merged text, and where its conflicts are, as [first line, line after] in the merged lines. */
export interface Merged {
	lines: string[];
	conflicts: [number, number][];
}

/** The lines of `text`, each keeping its line ending. */
export const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/**
 * `base` changed one way in `ours` and another in `theirs`, merged, with markers labelled as `labels` say: `ours`
 * first, as git writes them for the branch it's on.
 */
export function merge3(base: string, ours: string, theirs: string, labels: { ours: string; theirs: string }): Merged {
	const [o, a, b] = [linesOf(base), linesOf(ours), linesOf(theirs)];
	const inA = matched(o, a);
	const inB = matched(o, b);
	const lines: string[] = [];
	const conflicts: [number, number][] = [];
	let [i, j, k] = [0, 0, 0];
	while (i < o.length || j < a.length || k < b.length) {
		// A base line both sides kept where they stand now.
		if (i < o.length && inA[i] === j && inB[i] === k) {
			lines.push(o[i]!);
			[i, j, k] = [i + 1, j + 1, k + 1];
			continue;
		}
		// The next base line both sides kept, or the ends.
		let p = i;
		while (p < o.length && (inA[p] === -1 || inB[p] === -1)) p++;
		const [ja, kb] = p < o.length ? [inA[p]!, inB[p]!] : [a.length, b.length];
		const was = o.slice(i, p);
		const mine = a.slice(j, ja);
		const theirsNow = b.slice(k, kb);
		if (same(mine, was)) lines.push(...theirsNow);
		else if (same(theirsNow, was) || same(mine, theirsNow)) lines.push(...mine);
		else {
			const start = lines.length;
			lines.push(`${"<".repeat(MARKER)} ${labels.ours}\n`, ...ended(mine), `${"=".repeat(MARKER)}\n`);
			lines.push(...ended(theirsNow), `${">".repeat(MARKER)} ${labels.theirs}\n`);
			conflicts.push([start, lines.length]);
		}
		[i, j, k] = [p, ja, kb];
	}
	return { lines, conflicts };
}

const same = (x: string[], y: string[]) => x.length === y.length && x.every((line, index) => line === y[index]);

// A side's lines inside a conflict, the last ended so the marker after it starts a line.
const ended = (lines: string[]) =>
	lines.length && !lines.at(-1)!.endsWith("\n") ? [...lines.slice(0, -1), `${lines.at(-1)}\n`] : lines;

/**
 * For each line of `from`, the line of `to` it's kept as in a longest common run of lines, or -1. Past `mostEdits`
 * inserted or deleted lines it stops looking for common ones, and the rest count as changed.
 */
export function matched(from: string[], to: string[], mostEdits = MOST_EDITS): number[] {
	const kept = new Array<number>(from.length).fill(-1);
	let start = 0;
	while (start < from.length && start < to.length && from[start] === to[start]) kept[start] = start++;
	let [endFrom, endTo] = [from.length, to.length];
	while (endFrom > start && endTo > start && from[endFrom - 1] === to[endTo - 1]) kept[--endFrom] = --endTo;
	for (const [x, y] of commonLines(from.slice(start, endFrom), to.slice(start, endTo), mostEdits))
		kept[start + x] = start + y;
	return kept;
}

/**
 * The pairs of lines `a` and `b` keep in common, by Myers' O(ND) diff, or none when they differ by more than
 * `most` lines. Each step keeps only its own diagonals, so the memory is about most² / 2 numbers at most.
 */
function commonLines(a: string[], b: string[], most: number): [number, number][] {
	const [n, m] = [a.length, b.length];
	if (!n || !m) return [];
	const trace: Int32Array[] = [];
	for (let d = 0; d <= Math.min(n + m, most); d++) {
		const before = trace[d - 1];
		// The furthest x on diagonal k after d edits, at v[k + d].
		const v = new Int32Array(2 * d + 1);
		const at = (k: number) => before![k + d - 1]!;
		for (let k = -d; k <= d; k += 2) {
			let x = d === 0 ? 0 : k === -d || (k !== d && at(k - 1) < at(k + 1)) ? at(k + 1) : at(k - 1) + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) [x, y] = [x + 1, y + 1];
			v[k + d] = x;
			if (x >= n && y >= m) return backtrack([...trace, v], n, m);
		}
		trace.push(v);
	}
	return [];
}

function backtrack(trace: Int32Array[], n: number, m: number): [number, number][] {
	const pairs: [number, number][] = [];
	let [x, y] = [n, m];
	for (let d = trace.length - 1; d > 0; d--) {
		const before = trace[d - 1]!;
		const at = (k: number) => before[k + d - 1]!;
		const k = x - y;
		const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
		const fromK = down ? k + 1 : k - 1;
		const fromX = at(fromK);
		// The run of common lines this step ended with.
		const runFrom = down ? fromX : fromX + 1;
		while (x > runFrom && y > runFrom - k) pairs.push([--x, --y]);
		[x, y] = [fromX, fromX - fromK];
	}
	while (x > 0 && y > 0) pairs.push([--x, --y]);
	return pairs.reverse();
}
