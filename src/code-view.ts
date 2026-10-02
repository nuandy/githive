export interface ChangedTextFile {
	path: string;
	before: string | null;
	after: string | null;
}

export interface BoundedDiff {
	unified: string;
	files: string[];
	omitted: string[];
}

// Keep both the work performed by Myers and the response bounded. In particular,
// check input byte lengths before splitting into lines or constructing the edit
// graph: lockfiles and generated bundles should not get that far.
const MAX_FILE_INPUT_BYTES = 32 * 1024;
const MAX_FILE_LINES = 256;
const MAX_FILE_DIFF_BYTES = 64 * 1024;
const MAX_TOTAL_DIFF_BYTES = 256 * 1024;
const MAX_NOTICE_BYTES = 2 * 1024;
const encoder = new TextEncoder();

interface Line {
	text: string;
	terminated: boolean;
}

type Edit =
	| { type: "equal"; line: Line; oldLine: number; newLine: number }
	| { type: "delete"; line: Line; oldLine: number; newLine: number }
	| { type: "insert"; line: Line; oldLine: number; newLine: number };

function byteLength(text: string) {
	return encoder.encode(text).byteLength;
}

function lineCount(text: string | null) {
	if (text === null || text === "") return 0;
	let count = 1;
	for (const character of text) if (character === "\n") count++;
	if (text.endsWith("\n")) count--;
	return count;
}

function lines(text: string | null): Line[] {
	if (text === null || text === "") return [];
	const terminated = text.endsWith("\n");
	const parts = text.split("\n");
	if (terminated) parts.pop();
	return parts.map((part, index) => ({ text: part, terminated: index < parts.length - 1 || terminated }));
}

/** Myers' O((N + M)D) shortest-edit script over lines. */
function editScript(before: Line[], after: Line[]): Edit[] {
	const n = before.length;
	const m = after.length;
	const max = n + m;
	let frontier = new Map<number, number>([[1, 0]]);
	const trace: Map<number, number>[] = [];
	let distance = 0;

	search: for (let d = 0; d <= max; d++) {
		trace.push(new Map(frontier));
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))) {
				x = frontier.get(k + 1) ?? 0;
			} else {
				x = (frontier.get(k - 1) ?? 0) + 1;
			}
			let y = x - k;
			while (x < n && y < m && before[x].text === after[y].text && before[x].terminated === after[y].terminated) {
				x++;
				y++;
			}
			frontier.set(k, x);
			if (x >= n && y >= m) {
				distance = d;
				break search;
			}
		}
	}

	const reversed: { type: "equal" | "delete" | "insert"; line: Line }[] = [];
	let x = n;
	let y = m;
	for (let d = distance; d > 0; d--) {
		const previous = trace[d];
		const k = x - y;
		const previousK = k === -d || (k !== d && (previous.get(k - 1) ?? -1) < (previous.get(k + 1) ?? -1)) ? k + 1 : k - 1;
		const previousX = previous.get(previousK) ?? 0;
		const previousY = previousX - previousK;
		while (x > previousX && y > previousY) {
			reversed.push({ type: "equal", line: before[x - 1] });
			x--;
			y--;
		}
		if (x === previousX) {
			reversed.push({ type: "insert", line: after[y - 1] });
			y--;
		} else {
			reversed.push({ type: "delete", line: before[x - 1] });
			x--;
		}
	}
	while (x > 0 && y > 0) {
		reversed.push({ type: "equal", line: before[x - 1] });
		x--;
		y--;
	}
	while (x > 0) reversed.push({ type: "delete", line: before[--x] });
	while (y > 0) reversed.push({ type: "insert", line: after[--y] });

	const ordered = reversed.reverse();
	let oldLine = 1;
	let newLine = 1;
	return ordered.map((edit) => {
		const result = { ...edit, oldLine, newLine } as Edit;
		if (edit.type !== "insert") oldLine++;
		if (edit.type !== "delete") newLine++;
		return result;
	});
}

function lineText(prefix: string, line: Line) {
	return `${prefix}${line.text}\n${line.terminated ? "" : "\\ No newline at end of file\n"}`;
}

function formatRange(start: number, count: number) {
	return `${start}${count === 1 ? "" : `,${count}`}`;
}

/** Quote a path using Git/C-style escapes before it enters a structural header. */
function quoteGitPath(path: string): string {
	const hasControl = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
	const needsQuote = /[\s"\\]/u.test(path) || hasControl.test(path);
	if (!needsQuote) return path;
	const encoded: string[] = [];
	for (const character of path) {
		switch (character) {
			case "\\": encoded.push("\\\\"); break;
			case '"': encoded.push('\\"'); break;
			case "\t": encoded.push("\\t"); break;
			case "\n": encoded.push("\\n"); break;
			case "\v": encoded.push("\\v"); break;
			case "\f": encoded.push("\\f"); break;
			case "\r": encoded.push("\\r"); break;
			default:
				if (hasControl.test(character)) {
					// Octal-escaped UTF-8 bytes follow Git's C-style pathname quoting and
					// avoid emitting invisible/control characters into a header.
					for (const byte of encoder.encode(character)) encoded.push("\\" + byte.toString(8).padStart(3, "0"));
				} else encoded.push(character);
		}
	}
	return `"${encoded.join("")}"`;
}

function fileDiff(file: ChangedTextFile): string {
	const before = lines(file.before);
	const after = lines(file.after);
	const edits = editScript(before, after);
	if (!edits.some((edit) => edit.type !== "equal") && file.before !== null && file.after !== null) return "";

	const changes: { start: number; end: number }[] = [];
	for (let index = 0; index < edits.length; index++) {
		if (edits[index].type === "equal") continue;
		const start = Math.max(0, index - 3);
		const end = Math.min(edits.length, index + 4);
		const last = changes[changes.length - 1];
		if (last && start <= last.end) last.end = Math.max(last.end, end);
		else changes.push({ start, end });
	}

	const oldPath = quoteGitPath(`a/${file.path}`);
	const newPath = quoteGitPath(`b/${file.path}`);
	const output = [`diff --git ${oldPath} ${newPath}\n`];
	if (file.before === null) output.push("new file mode 100644\n");
	if (file.after === null) output.push("deleted file mode 100644\n");
	output.push(`--- ${file.before === null ? "/dev/null" : oldPath}\n`);
	output.push(`+++ ${file.after === null ? "/dev/null" : newPath}\n`);

	for (const hunk of changes) {
		const chunk = edits.slice(hunk.start, hunk.end);
		const oldCount = chunk.filter((edit) => edit.type !== "insert").length;
		const newCount = chunk.filter((edit) => edit.type !== "delete").length;
		const first = chunk[0];
		const oldStart = oldCount ? first.oldLine : first.oldLine - 1;
		const newStart = newCount ? first.newLine : first.newLine - 1;
		output.push(`@@ -${formatRange(oldStart, oldCount)} +${formatRange(newStart, newCount)} @@\n`);
		for (const edit of chunk) {
			const prefix = edit.type === "equal" ? " " : edit.type === "delete" ? "-" : "+";
			output.push(lineText(prefix, edit.line));
		}
	}
	return output.join("");
}

function omissionNotice(omitted: string[]): string {
	const heading = `\n[Blueprint diff notice: diff content omitted for ${omitted.length} changed file${omitted.length === 1 ? "" : "s"} because per-file or total diff limits were reached.`;
	let notice = `${heading} Omitted paths: `;
	for (const path of omitted) {
		const next = `${notice}${notice.endsWith(" ") ? "" : ", "}${quoteGitPath(path)}`;
		if (byteLength(`${next}, …]`) > MAX_NOTICE_BYTES) {
			notice += `${notice.endsWith(" ") ? "" : ", "}…`;
			break;
		}
		notice = next;
	}
	return `${notice}]\n`;
}

/** Generate a size-bounded Git-style diff and retain the complete changed-path list. */
export function boundedUnifiedDiff(input: ChangedTextFile[]): BoundedDiff {
	const changed = input
		.filter((file) => file.before !== file.after)
		.slice()
		.sort((a, b) => a.path.localeCompare(b.path));
	const files = changed.map((file) => file.path);
	const omitted: string[] = [];
	const chunks: string[] = [];
	let outputBytes = 0;
	let aggregateFull = false;
	const contentBudget = MAX_TOTAL_DIFF_BYTES - MAX_NOTICE_BYTES;

	for (const file of changed) {
		if (
			aggregateFull ||
			byteLength(file.before ?? "") + byteLength(file.after ?? "") > MAX_FILE_INPUT_BYTES ||
			lineCount(file.before) > MAX_FILE_LINES ||
			lineCount(file.after) > MAX_FILE_LINES
		) {
			omitted.push(file.path);
			continue;
		}
		const rendered = fileDiff(file);
		if (!rendered) continue;
		const renderedBytes = byteLength(rendered);
		if (renderedBytes > MAX_FILE_DIFF_BYTES || renderedBytes > contentBudget - outputBytes) {
			omitted.push(file.path);
			// Files are sorted; once the total budget is exhausted, skip every
			// remaining diff rather than spending more time rendering it.
			if (renderedBytes > contentBudget - outputBytes) aggregateFull = true;
			continue;
		}
		chunks.push(rendered);
		outputBytes += renderedBytes;
	}

	if (omitted.length) chunks.push(omissionNotice(omitted));
	return { unified: chunks.join(""), files, omitted };
}

/** Format changed text files as readable Git-style unified diffs. */
export function unifiedDiff(files: ChangedTextFile[]): string {
	return boundedUnifiedDiff(files).unified;
}
