import { href } from "./routes";

// A small Markdown reader for the Code tab: a README and the rest shown as formatted text. It reads CommonMark's
// common parts and GitHub's tables, task lists, strikethrough and bare links into a tree that Markdown.tsx draws as
// React elements. Raw HTML is never passed through: it stays text. A link goes somewhere only over http or https, or
// to a path in the repo (linkTarget).
//
// Agents write a repo's Markdown, so a file is read as untrusted: nothing in it is scanned again and again (no regular
// expression that can backtrack over a long run, and each paragraph's scans remembered in a Scan), quotes, lists,
// emphasis and links nest at most NESTING_MOST deep, and a file over FORMAT_MOST is shown as its source instead.

export type Inline =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string }
	| { kind: "em" | "strong" | "del"; children: Inline[] }
	| { kind: "link"; href: string; children: Inline[] }
	| { kind: "image"; src: string; alt: string }
	/** A task list item's box, ticked or not: first in its item's paragraph. */
	| { kind: "task"; checked: boolean }
	| { kind: "break" };

export type Align = "left" | "center" | "right" | null;

export type Block =
	| { kind: "heading"; level: number; children: Inline[] }
	| { kind: "paragraph"; children: Inline[] }
	| { kind: "code"; lang: string; text: string }
	| { kind: "list"; ordered: boolean; start: number; items: Block[][] }
	| { kind: "quote"; children: Block[] }
	/** Each row has the cells it was written with, up to the head's: any it lacks are empty. */
	| { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
	| { kind: "rule" };

/** The longest file formatted, in characters: a longer one is shown as its source. */
export const FORMAT_MOST = 100_000;

/** How deep quotes and lists nest, and emphasis and links: what's deeper is read as plain text. */
const NESTING_MOST = 16;

/** Reference links' targets, by their label as Markdown matches it: in any case, spaces collapsed. */
type Refs = Map<string, string>;

const refKey = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

/** The longest label a reference link may have (CommonMark's limit). */
const LABEL_MOST = 999;

// Each of these reads a line in one pass: no two parts can match the same run of characters, so a long run can't make
// one backtrack. Whatever needs more is done in code (fenceOf, headingText, isDelimiterRow).
const FENCE_MARKS = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const BULLET = /^( {0,3})([-*+])(?:([ \t]+)(.*))?$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])(?:([ \t]+)(.*))?$/;
const INDENTED = /^(?: {4})(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const DELIMITER_CELL = /^:?-+:?$/;
const DEFINITION = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const TASK = /^\[([ xX])\][ \t]+(?=\S)/;

const blank = (line: string) => line.trim() === "";
const indentOf = (line: string) => /^ */.exec(line)![0].length;

/** A document's text, over FORMAT_MOST or not, as blocks. */
export function parseMarkdown(source: string): Block[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n").map(expandTabs);
	const refs: Refs = new Map();
	let fenced = false;
	const kept = lines.filter((line) => {
		if (fenceOf(line)) fenced = !fenced;
		const definition = fenced ? null : DEFINITION.exec(line);
		if (!definition) return true;
		if (!refs.has(refKey(definition[1]!))) refs.set(refKey(definition[1]!), definition[2]!);
		return false;
	});
	return parseBlocks(kept, refs, 0);
}

/** Leading tabs as four spaces each, so indents measure in spaces. */
const expandTabs = (line: string) => line.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length));

/** A line that opens a fenced block: its marks, and its language (the first word after them). Null if it isn't one. */
function fenceOf(line: string): { marks: string; lang: string } | null {
	const open = FENCE_MARKS.exec(line);
	if (!open) return null;
	const marks = open[1]!;
	const info = line.slice(open[0].length);
	// After backticks, a backtick makes the line inline code instead.
	if (marks[0] === "`" && info.includes("`")) return null;
	return { marks, lang: /^\S*/.exec(info.trimStart())![0] };
}

/** Whether `line` closes a block fenced with `marks`: as many of the same, or more, and nothing else. */
function closesFence(line: string, marks: string): boolean {
	const close = FENCE_CLOSE.exec(line);
	return !!close && close[1]![0] === marks[0] && close[1]!.length >= marks.length;
}

/** A heading's text: trimmed, without a closing run of #s (which goes only after a space, or alone). */
function headingText(rest: string): string {
	const text = rest.trim();
	let end = text.length;
	while (end > 0 && text[end - 1] === "#") end--;
	if (end === text.length || (end > 0 && text[end - 1] !== " " && text[end - 1] !== "\t")) return text;
	return text.slice(0, end).trimEnd();
}

/** Whether a line is a table's delimiter row: cells of dashes, each with a colon at either end or not. */
function isDelimiterRow(line: string): boolean {
	if (indentOf(line) > 3) return false;
	return cellsOf(line).every((cell) => DELIMITER_CELL.test(cell));
}

/** Whether a line starts a block that ends a paragraph. */
function interrupts(line: string): boolean {
	if (fenceOf(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
	const bullet = BULLET.exec(line);
	if (bullet?.[4]?.trim()) return true;
	const ordered = ORDERED.exec(line);
	return !!ordered?.[5]?.trim() && ordered[2] === "1";
}

function parseBlocks(lines: string[], refs: Refs, depth: number): Block[] {
	// Past the deepest a quote or list nests, what's inside is its words.
	if (depth >= NESTING_MOST) {
		const words = lines
			.map((line) => line.trim())
			.filter(Boolean)
			.join("\n");
		return words ? [{ kind: "paragraph", children: [{ kind: "text", text: words }] }] : [];
	}
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (blank(line)) {
			i++;
			continue;
		}
		const fence = fenceOf(line);
		if (fence) {
			const body: string[] = [];
			const fenceIndent = indentOf(line);
			i++;
			while (i < lines.length) {
				if (closesFence(lines[i]!, fence.marks)) {
					i++;
					break;
				}
				const indent = Math.min(fenceIndent, indentOf(lines[i]!));
				body.push(lines[i]!.slice(indent));
				i++;
			}
			blocks.push({ kind: "code", lang: fence.lang, text: body.join("\n") });
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			const text = headingText(heading[2] ?? "");
			blocks.push({ kind: "heading", level: heading[1]!.length, children: parseInline(text, refs) });
			i++;
			continue;
		}
		if (RULE.test(line)) {
			blocks.push({ kind: "rule" });
			i++;
			continue;
		}
		if (QUOTE.test(line)) {
			const inner: string[] = [];
			while (i < lines.length) {
				const quoted = QUOTE.exec(lines[i]!);
				if (quoted) inner.push(quoted[1]!);
				// A line that goes on the quote's paragraph without its ">" (a lazy continuation).
				else if (!blank(lines[i]!) && !blank(inner.at(-1) ?? "") && !interrupts(lines[i]!)) inner.push(lines[i]!);
				else break;
				i++;
			}
			blocks.push({ kind: "quote", children: parseBlocks(inner, refs, depth + 1) });
			continue;
		}
		if (BULLET.test(line) || ORDERED.test(line)) {
			const [list, next] = parseList(lines, i, refs, depth);
			blocks.push(list);
			i = next;
			continue;
		}
		const indented = INDENTED.exec(line);
		if (indented) {
			const body: string[] = [];
			while (i < lines.length && (INDENTED.test(lines[i]!) || blank(lines[i]!))) {
				body.push(lines[i]!.slice(4));
				i++;
			}
			while (body.length && blank(body.at(-1)!)) body.pop();
			blocks.push({ kind: "code", lang: "", text: body.join("\n") });
			continue;
		}
		if (line.includes("|") && i + 1 < lines.length && lines[i + 1]!.includes("|") && isDelimiterRow(lines[i + 1]!)) {
			const [table, next] = parseTable(lines, i, refs);
			blocks.push(table);
			i = next;
			continue;
		}
		// A paragraph: lines up to a blank one or another block. Underlined with = or -, it's a heading. Each line keeps
		// the spaces at its end (two make a break) but the last.
		const text: string[] = [line.trimStart()];
		i++;
		let level = 0;
		while (i < lines.length && !blank(lines[i]!)) {
			const setext = SETEXT.exec(lines[i]!);
			if (setext) {
				level = setext[1]![0] === "=" ? 1 : 2;
				i++;
				break;
			}
			if (interrupts(lines[i]!)) break;
			text.push(lines[i]!.trimStart());
			i++;
		}
		const children = parseInline(text.join("\n").trimEnd(), refs);
		blocks.push(level ? { kind: "heading", level, children } : { kind: "paragraph", children });
	}
	return blocks;
}

interface Item {
	ordered: boolean;
	/** The bullet, or the ordered list's delimiter: a list goes on while its items have the same. */
	marker: string;
	start: number;
	/** Where the item's content starts: lines indented as far belong to it. */
	content: number;
	text: string;
}

function itemOf(line: string): Item | null {
	const bullet = BULLET.exec(line);
	if (bullet) {
		const [, indent = "", marker = "", space = " ", text = ""] = bullet;
		const gap = space.length > 4 || !text ? 1 : space.length;
		return { ordered: false, marker, start: 1, content: indent.length + 1 + gap, text };
	}
	const ordered = ORDERED.exec(line);
	if (ordered) {
		const [, indent = "", digits = "", marker = "", space = " ", text = ""] = ordered;
		const gap = space.length > 4 || !text ? 1 : space.length;
		return { ordered: true, marker, start: Number(digits), content: indent.length + digits.length + 1 + gap, text };
	}
	return null;
}

/** A list item's blocks, its box first in its paragraph where it starts "[ ] " or "[x] " (a task list's). */
function withTask(blocks: Block[]): Block[] {
	const [first] = blocks;
	const lead = first?.kind === "paragraph" ? first.children[0] : undefined;
	const task = lead?.kind === "text" ? TASK.exec(lead.text) : null;
	if (first?.kind !== "paragraph" || lead?.kind !== "text" || !task) return blocks;
	const rest = lead.text.slice(task[0].length);
	first.children.splice(0, 1, { kind: "task", checked: task[1] !== " " }, { kind: "text", text: rest });
	return blocks;
}

function parseList(lines: string[], from: number, refs: Refs, depth: number): [Block, number] {
	const first = itemOf(lines[from]!)!;
	const sameKind = (item: Item | null): item is Item =>
		!!item && item.ordered === first.ordered && item.marker === first.marker;
	const items: string[][] = [];
	let current = [first.text];
	let content = first.content;
	let i = from + 1;
	while (i < lines.length) {
		const line = lines[i]!;
		if (blank(line)) {
			let next = i + 1;
			while (next < lines.length && blank(lines[next]!)) next++;
			if (next >= lines.length) break;
			const after = lines[next]!;
			if (indentOf(after) >= content) {
				for (let gap = i; gap < next; gap++) current.push("");
				i = next;
				continue;
			}
			const item = itemOf(after);
			if (sameKind(item) && indentOf(after) < content) {
				items.push(current);
				current = [item.text];
				content = item.content;
				i = next + 1;
				continue;
			}
			break;
		}
		if (indentOf(line) >= content) {
			current.push(line.slice(content));
			i++;
			continue;
		}
		const item = itemOf(line);
		if (sameKind(item)) {
			items.push(current);
			current = [item.text];
			content = item.content;
			i++;
			continue;
		}
		// A line that goes on the item's paragraph without its indent (a lazy continuation).
		if (!item && !blank(current.at(-1) ?? "") && !interrupts(line)) {
			current.push(line.trim());
			i++;
			continue;
		}
		break;
	}
	items.push(current);
	const list: Block = {
		kind: "list",
		ordered: first.ordered,
		start: first.start,
		items: items.map((item) => withTask(parseBlocks(item, refs, depth + 1))),
	};
	return [list, i];
}

/** A table row's cells: split on pipes that aren't escaped, without the row's outer ones. */
function cellsOf(line: string): string[] {
	const row = line
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "");
	return row.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

function parseTable(lines: string[], from: number, refs: Refs): [Block, number] {
	const head = cellsOf(lines[from]!);
	const align = cellsOf(lines[from + 1]!).map((cell): Align => {
		const left = cell.startsWith(":");
		const right = cell.endsWith(":");
		return left && right ? "center" : right ? "right" : left ? "left" : null;
	});
	const width = head.length;
	// A row keeps the cells it has (those past the head's are dropped), so a wide head over many short rows can't make
	// cells the file never wrote.
	const fit = (cells: string[]) => cells.slice(0, width).map((cell) => parseInline(cell, refs));
	const rows: Inline[][][] = [];
	let i = from + 2;
	while (i < lines.length && !blank(lines[i]!) && !interrupts(lines[i]!)) {
		rows.push(fit(cellsOf(lines[i]!)));
		i++;
	}
	return [{ kind: "table", align: align.slice(0, width), head: fit(head), rows }, i];
}

// Inlines.

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	trade: "™",
	mdash: "—",
	ndash: "–",
	hellip: "…",
	middot: "·",
	times: "×",
	laquo: "«",
	raquo: "»",
	rarr: "→",
	larr: "←",
	check: "✓",
};

/** Named and numbered character references as the characters they name; others as written. */
function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,31});/gi, (whole, name: string) => {
		if (name[0] !== "#") return Object.hasOwn(ENTITIES, name) ? ENTITIES[name]! : whole;
		const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
		const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
		return valid ? String.fromCodePoint(code) : "�";
	});
}

const space = (char: string | undefined) => char === undefined || /\s/.test(char);
const wordChar = (char: string | undefined) => !!char && /[\p{L}\p{N}]/u.test(char);

/** How many of `char` there are in a row from `at`. */
function runOf(src: string, at: number, char: string): number {
	let end = at;
	while (src[end] === char) end++;
	return end - at;
}

/**
 * What reading one stretch of inline text (a paragraph, a heading, a cell, or what's inside emphasis or a link) learns
 * as it goes, so that nothing in it is scanned over and over: a hostile file can't make the reader quadratic.
 */
interface Scan {
	src: string;
	refs: Refs;
	/** Inside a link, nothing else links. */
	inLink: boolean;
	/** How deep in emphasis and links this is. */
	depth: number;
	/** Where runs of backticks start, by their length, in order: worked out when first needed. */
	ticks?: Map<number, number[]>;
	/** Where each "[" a scan has met closes, or -1 if it doesn't. */
	brackets: Map<number, number>;
	/** Where a link's destination starting after each "(" a scan has met ends. */
	parens: Map<number, number>;
	/** Emphasis by its character and length: the earliest point from which nothing closes it. */
	unclosed: Map<string, number>;
	/** The last search for each character: from where, and where it was found (-1: nowhere after). */
	found: Map<string, { from: number; at: number }>;
}

/** Where `char` is next at or after `from`, remembering the answer for the searches after it. */
function nextIndex(scan: Scan, char: string, from: number): number {
	const last = scan.found.get(char);
	if (last && from >= last.from && (last.at < 0 || last.at >= from)) return last.at;
	const at = scan.src.indexOf(char, from);
	scan.found.set(char, { from, at });
	return at;
}

/** Each run of backticks in `src`, by its length: where each starts, in order. */
function backtickRuns(src: string): Map<number, number[]> {
	const runs = new Map<number, number[]>();
	for (let at = src.indexOf("`"); at >= 0;) {
		const length = runOf(src, at, "`");
		const starts = runs.get(length);
		if (starts) starts.push(at);
		else runs.set(length, [at]);
		at = src.indexOf("`", at + length);
	}
	return runs;
}

/** The end of a code span opened by a run of `length` backticks: the next run of as many from `from`, or -1. */
function codeSpanEnd(scan: Scan, from: number, length: number): number {
	scan.ticks ??= backtickRuns(scan.src);
	const starts = scan.ticks.get(length) ?? [];
	let low = 0;
	let high = starts.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (starts[middle]! < from) low = middle + 1;
		else high = middle;
	}
	return starts[low] ?? -1;
}

/**
 * Where emphasis opened by `length` of `char` at `from` closes: the end of a run of the char that can close it (no
 * space before it; for _, no letter after it), taking the last `length` of a longer run. -1 if nothing closes it, which
 * the scan remembers: nothing closes such emphasis from any later point either.
 */
function closingDelimiter(scan: Scan, from: number, char: string, length: number): number {
	const key = `${char}${length}`;
	const none = scan.unclosed.get(key);
	if (none !== undefined && from >= none) return -1;
	const { src } = scan;
	for (let at = from; at < src.length;) {
		const c = src[at]!;
		if (c === "\\") {
			at += 2;
			continue;
		}
		if (c === "`") {
			const run = runOf(src, at, "`");
			const end = codeSpanEnd(scan, at + run, run);
			at = end < 0 ? at + run : end + run;
			continue;
		}
		if (c !== char) {
			at++;
			continue;
		}
		const run = runOf(src, at, char);
		const fits = length === 1 ? run !== 2 : run >= length;
		const closes = !space(src[at - 1]) && (char !== "_" || !wordChar(src[at + run]));
		if (fits && closes) return at + run - length;
		at += run;
	}
	scan.unclosed.set(key, Math.min(from, none ?? from));
	return -1;
}

/** Emphasis, strong emphasis or strikethrough opening at `at`, and where it ends; null if it doesn't. */
function readEmphasis(scan: Scan, at: number): { node: Inline; end: number } | null {
	const { src } = scan;
	const char = src[at]!;
	const run = runOf(src, at, char);
	// It opens only before something other than a space, and an underscore not inside a word.
	if (space(src[at + run]) || (char === "_" && wordChar(src[at - 1]))) return null;
	const tries: [number, "em" | "strong" | "del"][] =
		char === "~"
			? run >= 2
				? [[2, "del"]]
				: []
			: run >= 2
				? [
						[2, "strong"],
						[1, "em"],
					]
				: [[1, "em"]];
	for (const [length, kind] of tries) {
		const close = closingDelimiter(scan, at + length + 1, char, length);
		if (close < 0) continue;
		const inner = src.slice(at + length, close);
		if (!inner.trim()) continue;
		const children = parseInline(inner, scan.refs, scan.inLink, scan.depth + 1);
		return { node: { kind, children }, end: close + length };
	}
	return null;
}

/**
 * Where a destination that starts at `start` (just inside a link's parentheses) ends: at a space, or at the ")" that
 * closes them. Each "(" met on the way is remembered with where a destination after it would end.
 */
function destinationEnd(scan: Scan, start: number): number {
	const { src, parens } = scan;
	const open: number[] = [];
	let i = start;
	while (i < src.length && !/\s/.test(src[i]!)) {
		const c = src[i];
		if (c === "\\") i++;
		else if (c === "(") open.push(i);
		else if (c === ")") {
			if (!open.length) break;
			parens.set(open.pop()!, i);
		}
		i++;
	}
	for (const each of open) parens.set(each, i);
	return i;
}

/** A link's destination in its parentheses, from `at` (just inside them), and where they close. */
function destination(scan: Scan, at: number): { url: string; end: number } | null {
	const { src } = scan;
	let i = at;
	while (src[i] === " " || src[i] === "\n") i++;
	let url = "";
	if (src[i] === "<") {
		// Up to its ">", on one line, without another "<".
		let close = i + 1;
		while (close < src.length && src[close] !== ">" && src[close] !== "<" && src[close] !== "\n")
			close += src[close] === "\\" ? 2 : 1;
		if (src[close] !== ">") return null;
		url = src.slice(i + 1, close);
		i = close + 1;
	} else {
		const start = i;
		i = (i === at ? scan.parens.get(at - 1) : undefined) ?? destinationEnd(scan, start);
		url = src.slice(start, i);
	}
	while (src[i] === " " || src[i] === "\n") i++;
	// A title, which nothing shows.
	const opener = src[i];
	const closer = opener === "(" ? ")" : opener === '"' || opener === "'" ? opener : undefined;
	if (closer) {
		const end = nextIndex(scan, closer, i + 1);
		if (end >= 0) i = end + 1;
	}
	while (src[i] === " " || src[i] === "\n") i++;
	if (src[i] !== ")") return null;
	return { url: url.replace(/\\([^\w\s])/g, "$1"), end: i + 1 };
}

/**
 * Where the "[" at `at` closes, or -1. A scan from one records every "[" it meets inside, so one that's nested is
 * known without another.
 */
function closingBracket(scan: Scan, at: number): number {
	const known = scan.brackets.get(at);
	if (known !== undefined) return known;
	const { src, brackets } = scan;
	const open: number[] = [];
	for (let i = at; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") i++;
		else if (c === "`") {
			const run = runOf(src, i, "`");
			const end = codeSpanEnd(scan, i + run, run);
			i = end < 0 ? i + run - 1 : end + run - 1;
		} else if (c === "[") open.push(i);
		else if (c === "]") {
			brackets.set(open.pop()!, i);
			if (!open.length) return i;
		}
	}
	for (const each of open) brackets.set(each, -1);
	return -1;
}

/** A link or image's label and target from its "[" at `at`, inline or by reference; null if it isn't one. */
function readLink(scan: Scan, at: number): { label: string; url: string; end: number } | null {
	const { src, refs } = scan;
	const close = closingBracket(scan, at);
	if (close < 0) return null;
	const label = src.slice(at + 1, close);
	if (src[close + 1] === "(") {
		const target = destination(scan, close + 2);
		return target ? { label, url: target.url, end: target.end } : null;
	}
	const byReference = (name: string) => (name.length <= LABEL_MOST ? refs.get(refKey(name)) : undefined);
	if (!refs.size) return null;
	if (src[close + 1] === "[") {
		const end = nextIndex(scan, "]", close + 2);
		if (end < 0) return null;
		const url = byReference(src.slice(close + 2, end) || label);
		return url ? { label, url, end: end + 1 } : null;
	}
	const url = byReference(label);
	return url ? { label, url, end: close + 1 } : null;
}

/** Inlines' text alone: an image's alt from its label. */
function plainText(inlines: Inline[]): string {
	return inlines
		.map((inline) => {
			if (inline.kind === "text" || inline.kind === "code") return inline.text;
			if (inline.kind === "image") return inline.alt;
			if (inline.kind === "break") return " ";
			if (inline.kind === "task") return "";
			return plainText(inline.children);
		})
		.join("");
}

/** The characters that may start something other than text: everything up to the next one is text. */
const SPECIAL = /[\\\n`![<hH*_~]/g;

/** Punctuation that ends a sentence, not a bare link before it. */
const AFTER_LINK = ".,:;!?\"'*_~)]";

/** Takes the spaces off the end of text read so far (`parts`), and says how many there were. */
function trimSpaces(parts: string[]): number {
	let count = 0;
	while (parts.length) {
		const last = parts.at(-1)!;
		let end = last.length;
		while (end > 0 && last[end - 1] === " ") end--;
		count += last.length - end;
		if (end > 0) {
			parts[parts.length - 1] = last.slice(0, end);
			break;
		}
		parts.pop();
	}
	return count;
}

/**
 * A paragraph's or a heading's text as inlines. Inside a link (`inLink`), nothing else links; `depth` deep in
 * emphasis and links, what's deeper is its text.
 */
export function parseInline(src: string, refs: Refs = new Map(), inLink = false, depth = 0): Inline[] {
	if (depth >= NESTING_MOST) return src ? [{ kind: "text", text: src }] : [];
	// Plain words (most of a table's cells) need nothing more.
	SPECIAL.lastIndex = 0;
	if (!SPECIAL.test(src)) return src ? [{ kind: "text", text: decodeEntities(src) }] : [];
	const scan: Scan = {
		src,
		refs,
		inLink,
		depth,
		brackets: new Map(),
		parens: new Map(),
		unclosed: new Map(),
		found: new Map(),
	};
	const out: Inline[] = [];
	// Text read and not yet out, in pieces: joined once, never searched.
	let text: string[] = [];
	const flush = () => {
		if (!text.length) return;
		const decoded = decodeEntities(text.join(""));
		text = [];
		const last = out.at(-1);
		if (last?.kind === "text") last.text += decoded;
		else out.push({ kind: "text", text: decoded });
	};
	const push = (inline: Inline) => {
		flush();
		out.push(inline);
	};
	let i = 0;
	while (i < src.length) {
		SPECIAL.lastIndex = i;
		const next = SPECIAL.exec(src)?.index ?? src.length;
		if (next > i) {
			text.push(src.slice(i, next));
			i = next;
			continue;
		}
		const c = src[i]!;
		if (c === "\\") {
			const after = src[i + 1];
			if (after === "\n") {
				push({ kind: "break" });
				i += 2;
			} else if (after && PUNCTUATION.test(after)) {
				// An escaped character, kept out of the entity decoding too.
				flush();
				const last = out.at(-1);
				if (last?.kind === "text") last.text += after;
				else out.push({ kind: "text", text: after });
				i += 2;
			} else {
				text.push(c);
				i++;
			}
			continue;
		}
		if (c === "\n") {
			// Two spaces or more before a line's end break it; otherwise it goes on as a space would.
			if (trimSpaces(text) >= 2) push({ kind: "break" });
			else text.push("\n");
			i++;
			continue;
		}
		if (c === "`") {
			const run = runOf(src, i, "`");
			const end = codeSpanEnd(scan, i + run, run);
			if (end >= 0) {
				let code = src.slice(i + run, end).replace(/\n/g, " ");
				if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
				push({ kind: "code", text: code });
				i = end + run;
			} else {
				text.push(src.slice(i, i + run));
				i += run;
			}
			continue;
		}
		if (c === "!" && src[i + 1] === "[") {
			const image = readLink(scan, i + 1);
			if (image) {
				push({ kind: "image", src: image.url, alt: plainText(parseInline(image.label, refs, true, depth + 1)) });
				i = image.end;
				continue;
			}
		}
		if (c === "[" && !inLink) {
			const link = readLink(scan, i);
			if (link) {
				push({ kind: "link", href: link.url, children: parseInline(link.label, refs, true, depth + 1) });
				i = link.end;
				continue;
			}
		}
		if (c === "<" && !inLink) {
			const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i));
			if (auto) {
				push({ kind: "link", href: auto[1]!, children: [{ kind: "text", text: auto[1]! }] });
				i += auto[0].length;
				continue;
			}
		}
		if ((c === "h" || c === "H") && !inLink && (i === 0 || /[\s(]/.test(src[i - 1]!))) {
			const bare = /^https?:\/\/[^\s<]+/i.exec(src.slice(i));
			if (bare) {
				// Punctuation that ends a sentence isn't the link's.
				let end = bare[0].length;
				while (end > 0 && AFTER_LINK.includes(bare[0][end - 1]!)) end--;
				const url = bare[0].slice(0, end);
				push({ kind: "link", href: url, children: [{ kind: "text", text: url }] });
				i += url.length;
				continue;
			}
		}
		if (c === "*" || c === "_" || c === "~") {
			const emphasis = readEmphasis(scan, i);
			if (emphasis) {
				push(emphasis.node);
				i = emphasis.end;
				continue;
			}
			// A run that opens nothing is text, all of it.
			const run = runOf(src, i, c);
			text.push(src.slice(i, i + run));
			i += run;
			continue;
		}
		text.push(c);
		i++;
	}
	flush();
	return out;
}

// Where things go.

/** Whether a file is Markdown, by its extension. */
export const isMarkdown = (path: string) => /[^/]\.(md|markdown|mdown|mkd)$/i.test(path);

/** A path's %-escapes as the characters they stand for; a % that starts none stays as it is. */
const decodePath = (path: string) =>
	path.replace(/(?:%[0-9a-f]{2})+/gi, (escapes) => {
		try {
			return decodeURIComponent(escapes);
		} catch {
			return escapes;
		}
	});

/**
 * Where a Markdown link goes from a file in `dir` of `repo` at `ref`: http and https outside the dashboard, a path
 * (relative to the file, or from the repo's top with a "/") to the Code tab, and nowhere for anything else: another
 * scheme (javascript:, data:, mailto:…), a link to another host without one (//host), a fragment alone, or a path
 * out of the repo, written plainly or %-escaped. Null where it goes nowhere: the link is shown as its words.
 */
export function linkTarget(
	url: string,
	{ repo, dir, ref }: { repo: string; dir: string; ref: string | undefined },
): { href: string; external: boolean } | null {
	// What a browser reads: without spaces and control characters at either end, or tabs and newlines anywhere.
	let start = 0;
	let end = url.length;
	while (start < end && url.charCodeAt(start) <= 0x20) start++;
	while (end > start && url.charCodeAt(end - 1) <= 0x20) end--;
	const read = url.slice(start, end).replace(/[\t\n\r]/g, "");
	if (!read) return null;
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(read);
	if (scheme) return /^https?$/i.test(scheme[1]!) ? { href: read, external: true } : null;
	if (read.startsWith("//") || read.startsWith("\\\\")) return null;
	const raw = read.split(/[?#]/)[0]!;
	if (!raw) return null;
	// Decoded before it's split and resolved, so "%2e%2e/" and "a%2f..%2f.." are the ".." they spell.
	const path = decodePath(raw);
	const at = path.startsWith("/") ? [] : dir.split("/").filter(Boolean);
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (!at.length) return null;
			at.pop();
			continue;
		}
		at.push(segment);
	}
	return { href: href.code(repo, at.join("/"), ref), external: false };
}
