import { href } from "./routes";

// A small Markdown reader for the Code tab: a README and the rest shown as formatted text. It reads CommonMark's
// common parts and GitHub's tables, strikethrough and bare links into a tree that Markdown.tsx draws as React
// elements. Raw HTML is never passed through: it stays text. A link goes somewhere only over http or https, or to a
// path in the repo (linkTarget).

export type Inline =
	| { kind: "text"; text: string }
	| { kind: "code"; text: string }
	| { kind: "em" | "strong" | "del"; children: Inline[] }
	| { kind: "link"; href: string; children: Inline[] }
	| { kind: "image"; src: string; alt: string }
	| { kind: "break" };

export type Align = "left" | "center" | "right" | null;

export type Block =
	| { kind: "heading"; level: number; children: Inline[] }
	| { kind: "paragraph"; children: Inline[] }
	| { kind: "code"; lang: string; text: string }
	| { kind: "list"; ordered: boolean; start: number; items: Block[][] }
	| { kind: "quote"; children: Block[] }
	| { kind: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
	| { kind: "rule" };

/** Reference links' targets, by their label as Markdown matches it: in any case, spaces collapsed. */
type Refs = Map<string, string>;

const refKey = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const BULLET = /^( {0,3})([-*+])(?:([ \t]+)(.*))?$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])(?:([ \t]+)(.*))?$/;
const INDENTED = /^(?: {4})(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const DEFINITION = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;

const blank = (line: string) => line.trim() === "";
const indentOf = (line: string) => /^ */.exec(line)![0].length;

/** A Markdown document as blocks. */
export function parseMarkdown(source: string): Block[] {
	const lines = source.replace(/\r\n?/g, "\n").split("\n").map(expandTabs);
	const refs: Refs = new Map();
	let fenced = false;
	const kept = lines.filter((line) => {
		if (FENCE.test(line)) fenced = !fenced;
		const definition = fenced ? null : DEFINITION.exec(line);
		if (!definition) return true;
		if (!refs.has(refKey(definition[1]!))) refs.set(refKey(definition[1]!), definition[2]!);
		return false;
	});
	return parseBlocks(kept, refs);
}

/** Leading tabs as four spaces each, so indents measure in spaces. */
const expandTabs = (line: string) => line.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length));

/** Whether a line starts a block that ends a paragraph. */
function interrupts(line: string): boolean {
	if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
	const bullet = BULLET.exec(line);
	if (bullet?.[4]?.trim()) return true;
	const ordered = ORDERED.exec(line);
	return !!ordered?.[5]?.trim() && ordered[2] === "1";
}

function parseBlocks(lines: string[], refs: Refs): Block[] {
	const blocks: Block[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i]!;
		if (blank(line)) {
			i++;
			continue;
		}
		const fence = FENCE.exec(line);
		if (fence) {
			const [, marks = "", lang = ""] = fence;
			const body: string[] = [];
			const fenceIndent = indentOf(line);
			i++;
			while (i < lines.length) {
				const closing = new RegExp(`^ {0,3}${marks[0] === "`" ? "`" : "~"}{${marks.length},}[ \\t]*$`);
				if (closing.test(lines[i]!)) {
					i++;
					break;
				}
				body.push(lines[i]!.replace(new RegExp(`^ {0,${fenceIndent}}`), ""));
				i++;
			}
			blocks.push({ kind: "code", lang, text: body.join("\n") });
			continue;
		}
		const heading = HEADING.exec(line);
		if (heading) {
			blocks.push({ kind: "heading", level: heading[1]!.length, children: parseInline(heading[2] ?? "", refs) });
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
			blocks.push({ kind: "quote", children: parseBlocks(inner, refs) });
			continue;
		}
		if (BULLET.test(line) || ORDERED.test(line)) {
			const [list, next] = parseList(lines, i, refs);
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
		if (line.includes("|") && i + 1 < lines.length && lines[i + 1]!.includes("|")) {
			const delimiter = lines[i + 1]!;
			if (DELIMITER_ROW.test(delimiter)) {
				const [table, next] = parseTable(lines, i, refs);
				blocks.push(table);
				i = next;
				continue;
			}
		}
		// A paragraph: lines up to a blank one or another block. Underlined with = or -, it's a heading.
		const text: string[] = [line.trim()];
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
			text.push(lines[i]!.trim());
			i++;
		}
		const children = parseInline(text.join("\n"), refs);
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

function parseList(lines: string[], from: number, refs: Refs): [Block, number] {
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
		items: items.map((item) => parseBlocks(item, refs)),
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
	const fit = (cells: string[]) => Array.from({ length: width }, (_, index) => parseInline(cells[index] ?? "", refs));
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
	nbsp: " ",
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
		if (name[0] !== "#") return ENTITIES[name] ?? whole;
		const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
		const valid = code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);
		return valid ? String.fromCodePoint(code) : "�";
	});
}

const space = (char: string | undefined) => char === undefined || /\s/.test(char);
const wordChar = (char: string | undefined) => !!char && /[\p{L}\p{N}]/u.test(char);

/** The end of a code span opened by a run of `length` backticks, or -1. */
function codeSpanEnd(src: string, from: number, length: number): number {
	for (let at = from; at < src.length;) {
		if (src[at] !== "`") {
			at++;
			continue;
		}
		const run = /^`+/.exec(src.slice(at))![0].length;
		if (run === length) return at;
		at += run;
	}
	return -1;
}

/**
 * Where emphasis opened by `length` of `char` at `from` closes: the end of a run of the char that can close it (no
 * space before it; for _, no letter after it), taking the last `length` of a longer run. -1 if nothing closes it.
 */
function closingDelimiter(src: string, from: number, char: string, length: number): number {
	for (let at = from; at < src.length;) {
		const c = src[at]!;
		if (c === "\\") {
			at += 2;
			continue;
		}
		if (c === "`") {
			const run = /^`+/.exec(src.slice(at))![0].length;
			const end = codeSpanEnd(src, at + run, run);
			at = end < 0 ? at + run : end + run;
			continue;
		}
		if (c !== char) {
			at++;
			continue;
		}
		const run = new RegExp(`^\\${char}+`).exec(src.slice(at))![0].length;
		const fits = length === 1 ? run !== 2 : run >= length;
		const closes = !space(src[at - 1]) && (char !== "_" || !wordChar(src[at + run]));
		if (fits && closes) return at + run - length;
		at += run;
	}
	return -1;
}

/** Emphasis, strong emphasis or strikethrough opening at `at`, and where it ends; null if it doesn't. */
function readEmphasis(src: string, at: number, refs: Refs, inLink: boolean): { node: Inline; end: number } | null {
	const char = src[at]!;
	const run = new RegExp(`^\\${char}+`).exec(src.slice(at))![0].length;
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
		const close = closingDelimiter(src, at + length + 1, char, length);
		if (close < 0) continue;
		const inner = src.slice(at + length, close);
		if (!inner.trim()) continue;
		return { node: { kind, children: parseInline(inner, refs, inLink) }, end: close + length };
	}
	return null;
}

/** A link's destination in its parentheses, from `at` (just inside them), and where they close. */
function destination(src: string, at: number): { url: string; end: number } | null {
	let i = at;
	while (src[i] === " " || src[i] === "\n") i++;
	let url = "";
	if (src[i] === "<") {
		const close = src.indexOf(">", i);
		if (close < 0) return null;
		url = src.slice(i + 1, close);
		i = close + 1;
	} else {
		let depth = 0;
		const start = i;
		while (i < src.length && !/\s/.test(src[i]!)) {
			if (src[i] === "\\") i++;
			else if (src[i] === "(") depth++;
			else if (src[i] === ")") {
				if (depth === 0) break;
				depth--;
			}
			i++;
		}
		url = src.slice(start, i);
	}
	while (src[i] === " " || src[i] === "\n") i++;
	// A title, which nothing shows.
	const title = /^(?:"[^"]*"|'[^']*'|\([^)]*\))/.exec(src.slice(i));
	if (title) i += title[0].length;
	while (src[i] === " " || src[i] === "\n") i++;
	if (src[i] !== ")") return null;
	return { url: url.replace(/\\([^\w\s])/g, "$1"), end: i + 1 };
}

/** A link or image's label and target from its "[" at `at`, inline or by reference; null if it isn't one. */
function readLink(src: string, at: number, refs: Refs): { label: string; url: string; end: number } | null {
	let depth = 0;
	let close = -1;
	for (let i = at; i < src.length; i++) {
		const c = src[i];
		if (c === "\\") i++;
		else if (c === "`") {
			const run = /^`+/.exec(src.slice(i))![0].length;
			const end = codeSpanEnd(src, i + run, run);
			i = end < 0 ? i + run - 1 : end + run - 1;
		} else if (c === "[") depth++;
		else if (c === "]" && --depth === 0) {
			close = i;
			break;
		}
	}
	if (close < 0) return null;
	const label = src.slice(at + 1, close);
	if (src[close + 1] === "(") {
		const target = destination(src, close + 2);
		return target ? { label, url: target.url, end: target.end } : null;
	}
	if (src[close + 1] === "[") {
		const end = src.indexOf("]", close + 2);
		if (end < 0) return null;
		const url = refs.get(refKey(src.slice(close + 2, end) || label));
		return url ? { label, url, end: end + 1 } : null;
	}
	const url = refs.get(refKey(label));
	return url ? { label, url, end: close + 1 } : null;
}

/** Inlines' text alone: an image's alt from its label. */
function plainText(inlines: Inline[]): string {
	return inlines
		.map((inline) => {
			if (inline.kind === "text" || inline.kind === "code") return inline.text;
			if (inline.kind === "image") return inline.alt;
			if (inline.kind === "break") return " ";
			return plainText(inline.children);
		})
		.join("");
}

/** A paragraph's or a heading's text as inlines. Inside a link (`inLink`), nothing else links. */
export function parseInline(src: string, refs: Refs = new Map(), inLink = false): Inline[] {
	const out: Inline[] = [];
	let text = "";
	const flush = () => {
		if (!text) return;
		const last = out.at(-1);
		if (last?.kind === "text") last.text += decodeEntities(text);
		else out.push({ kind: "text", text: decodeEntities(text) });
		text = "";
	};
	const push = (inline: Inline) => {
		flush();
		out.push(inline);
	};
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		const rest = src.slice(i);
		if (c === "\\") {
			const next = src[i + 1];
			if (next === "\n") {
				push({ kind: "break" });
				i += 2;
			} else if (next && PUNCTUATION.test(next)) {
				// An escaped character, kept out of the entity decoding too.
				flush();
				const last = out.at(-1);
				if (last?.kind === "text") last.text += next;
				else out.push({ kind: "text", text: next });
				i += 2;
			} else {
				text += c;
				i++;
			}
			continue;
		}
		if (c === "\n") {
			// Two spaces or more before a line's end break it; otherwise it goes on as a space would.
			const hard = / {2,}$/.test(text);
			text = text.replace(/ +$/, "");
			if (hard) push({ kind: "break" });
			else text += "\n";
			i++;
			continue;
		}
		if (c === "`") {
			const run = /^`+/.exec(rest)![0].length;
			const end = codeSpanEnd(src, i + run, run);
			if (end >= 0) {
				let code = src.slice(i + run, end).replace(/\n/g, " ");
				if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
				push({ kind: "code", text: code });
				i = end + run;
			} else {
				text += "`".repeat(run);
				i += run;
			}
			continue;
		}
		if (c === "!" && src[i + 1] === "[") {
			const image = readLink(src, i + 1, refs);
			if (image) {
				push({ kind: "image", src: image.url, alt: plainText(parseInline(image.label, refs, true)) });
				i = image.end;
				continue;
			}
		}
		if (c === "[" && !inLink) {
			const link = readLink(src, i, refs);
			if (link) {
				push({ kind: "link", href: link.url, children: parseInline(link.label, refs, true) });
				i = link.end;
				continue;
			}
		}
		if (c === "<" && !inLink) {
			const auto = /^<(https?:\/\/[^\s<>]+)>/i.exec(rest);
			if (auto) {
				push({ kind: "link", href: auto[1]!, children: [{ kind: "text", text: auto[1]! }] });
				i += auto[0].length;
				continue;
			}
		}
		if ((c === "h" || c === "H") && !inLink && (i === 0 || /[\s(]/.test(src[i - 1]!))) {
			const bare = /^https?:\/\/[^\s<]+/i.exec(rest);
			if (bare) {
				// Punctuation that ends a sentence isn't the link's.
				const url = bare[0].replace(/[.,:;!?"'*_~)\]]+$/, "");
				push({ kind: "link", href: url, children: [{ kind: "text", text: url }] });
				i += url.length;
				continue;
			}
		}
		if (c === "*" || c === "_" || c === "~") {
			const emphasis = readEmphasis(src, i, refs, inLink);
			if (emphasis) {
				push(emphasis.node);
				i = emphasis.end;
				continue;
			}
			// A run that opens nothing is text, all of it.
			const run = new RegExp(`^\\${c}+`).exec(rest)![0];
			text += run;
			i += run.length;
			continue;
		}
		text += c;
		i++;
	}
	flush();
	return out;
}

// Where things go.

/** Whether a file is Markdown, by its extension. */
export const isMarkdown = (path: string) => /[^/]\.(md|markdown|mdown|mkd)$/i.test(path);

/**
 * Where a Markdown link goes from a file in `dir` of `repo` at `ref`: http and https outside the dashboard, a path
 * (relative to the file, or from the repo's top with a "/") to the Code tab, and nowhere for anything else: another
 * scheme (javascript:, data:, mailto:…), a link to another host without one (//host), a fragment alone, or a path
 * out of the repo. Null where it goes nowhere: the link is shown as its words.
 */
export function linkTarget(
	url: string,
	{ repo, dir, ref }: { repo: string; dir: string; ref: string | undefined },
): { href: string; external: boolean } | null {
	// What a browser would read: it drops spaces and control characters inside a scheme.
	const read = url.replace(/[\u0000- \u007f]/g, "");
	if (!read) return null;
	const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(read);
	if (scheme) return /^https?$/i.test(scheme[1]!) ? { href: read, external: true } : null;
	if (read.startsWith("//") || read.startsWith("\\\\")) return null;
	const path = read.split(/[?#]/)[0]!;
	if (!path) return null;
	const at = path.startsWith("/") ? [] : dir.split("/").filter(Boolean);
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (!at.length) return null;
			at.pop();
			continue;
		}
		let name = segment;
		try {
			name = decodeURIComponent(segment);
		} catch {
			// Kept as written.
		}
		at.push(name);
	}
	return { href: href.code(repo, at.join("/"), ref), external: false };
}
