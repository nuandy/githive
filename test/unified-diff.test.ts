import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/unified-diff";

// A file's change as the change page's Files tab shows it: hunks of lines kept, removed and added, with a few lines
// of context around each, as `git diff` writes them.

const lines = (count: number, from = 1) =>
	Array.from({ length: count }, (_, index) => `line ${from + index}\n`).join("");

describe("a file's unified diff", () => {
	it("is nothing for the same text", () => {
		expect(unifiedDiff("a\nb\n", "a\nb\n")).toEqual({ hunks: [], added: 0, removed: 0 });
	});

	it("shows a changed line with three lines of context on each side, and counts it", () => {
		const before = lines(10);
		const after = before.replace("line 5\n", "line five\n");
		expect(unifiedDiff(before, after)).toEqual({
			added: 1,
			removed: 1,
			hunks: [
				{
					oldStart: 2,
					oldLines: 7,
					newStart: 2,
					newLines: 7,
					lines: [" line 2", " line 3", " line 4", "-line 5", "+line five", " line 6", " line 7", " line 8"],
				},
			],
		});
	});

	it("keeps changes far apart in hunks of their own, and joins near ones", () => {
		const before = lines(30);
		const far = before.replace("line 3\n", "line three\n").replace("line 25\n", "line 25\nline 25½\n");
		const hunks = unifiedDiff(before, far).hunks;
		expect(hunks.map(({ oldStart, oldLines, newStart, newLines }) => [oldStart, oldLines, newStart, newLines])).toEqual(
			[
				[1, 6, 1, 6],
				[23, 6, 23, 7],
			],
		);
		const near = before.replace("line 3\n", "line three\n").replace("line 9\n", "line nine\n");
		expect(unifiedDiff(before, near).hunks).toHaveLength(1);
	});

	it("starts a new file at -0,0 and an emptied one at +0,0", () => {
		expect(unifiedDiff("", "a\nb\n")).toEqual({
			added: 2,
			removed: 0,
			hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+a", "+b"] }],
		});
		expect(unifiedDiff("a\n", "")).toEqual({
			added: 0,
			removed: 1,
			hunks: [{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0, lines: ["-a"] }],
		});
	});

	it("says where a side has no newline at its end", () => {
		expect(unifiedDiff("a\nb", "a\nb\n").hunks[0]!.lines).toEqual([" a", "-b", "\\ No newline at end of file", "+b"]);
		expect(unifiedDiff("a\nb", "a\nc").hunks[0]!.lines).toEqual([
			" a",
			"-b",
			"\\ No newline at end of file",
			"+c",
			"\\ No newline at end of file",
		]);
	});

	it("puts a line added after the last at the line before, with no lines of the old side", () => {
		expect(unifiedDiff(lines(5), lines(6), { context: 0 }).hunks).toEqual([
			{ oldStart: 5, oldLines: 0, newStart: 6, newLines: 1, lines: ["+line 6"] },
		]);
	});

	it("drops a line's carriage return with its newline", () => {
		expect(unifiedDiff("a\r\n", "b\r\n").hunks[0]!.lines).toEqual(["-a", "+b"]);
	});

	it("stays right, if coarser, when the sides differ by more lines than it looks through", () => {
		const before = lines(40);
		const after = lines(40).replace(/line (\d+)\n/g, (line, n: string) => (Number(n) % 2 ? `odd ${n}\n` : line));
		const { added, removed, hunks } = unifiedDiff(before, after, { mostEdits: 4 });
		const marked = (mark: string) => hunks.flatMap((hunk) => hunk.lines).filter((line) => line.startsWith(mark));
		expect([added, removed]).toEqual([marked("+").length, marked("-").length]);
		expect(removed).toBeGreaterThanOrEqual(20);
		// Each side is still what the hunks say it is.
		const side = (drop: string) =>
			hunks.flatMap((hunk) => hunk.lines.filter((line) => !line.startsWith(drop)).map((line) => line.slice(1)));
		expect(side("-").join("\n")).toBe(after.trimEnd());
		expect(side("+").join("\n")).toBe(before.trimEnd());
	});
});
