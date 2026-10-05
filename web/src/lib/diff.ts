// Split the server's Git-style unified diff into one block per file, with line
// numbers, for the Files changed tab.

export interface DiffLine {
	type: "context" | "add" | "del" | "hunk";
	text: string;
	oldNo?: number;
	newNo?: number;
}

export interface FileDiff {
	path: string;
	status: "added" | "deleted" | "modified";
	additions: number;
	deletions: number;
	lines: DiffLine[];
}

/** Git quotes unusual paths ("a/x y" with escapes); undo the simple cases. */
function unquote(path: string): string {
	if (path.startsWith('"') && path.endsWith('"')) {
		try {
			return JSON.parse(path) as string;
		} catch {
			return path.slice(1, -1);
		}
	}
	return path;
}

function stripPrefix(path: string): string {
	const clean = unquote(path.trim());
	return clean.replace(/^[ab]\//, "");
}

export function parseUnifiedDiff(unified: string): FileDiff[] {
	const files: FileDiff[] = [];
	let file: FileDiff | null = null;
	let oldNo = 0;
	let newNo = 0;
	for (const line of unified.split("\n")) {
		if (line.startsWith("diff --git ")) {
			file = { path: "", status: "modified", additions: 0, deletions: 0, lines: [] };
			files.push(file);
			const match = /^diff --git (".*?"|\S+) (".*?"|\S+)$/.exec(line);
			if (match) file.path = stripPrefix(match[2]);
			continue;
		}
		if (!file) continue;
		if (line.startsWith("new file mode")) file.status = "added";
		else if (line.startsWith("deleted file mode")) file.status = "deleted";
		else if (line.startsWith("--- ")) {
			if (!file.path && line.slice(4) !== "/dev/null") file.path = stripPrefix(line.slice(4));
		} else if (line.startsWith("+++ ")) {
			if (line.slice(4) !== "/dev/null") file.path = stripPrefix(line.slice(4));
		} else if (line.startsWith("@@")) {
			const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			oldNo = match ? Number(match[1]) : 0;
			newNo = match ? Number(match[2]) : 0;
			file.lines.push({ type: "hunk", text: line });
		} else if (line.startsWith("+")) {
			file.additions++;
			file.lines.push({ type: "add", text: line.slice(1), newNo: newNo++ });
		} else if (line.startsWith("-")) {
			file.deletions++;
			file.lines.push({ type: "del", text: line.slice(1), oldNo: oldNo++ });
		} else if (line.startsWith(" ")) {
			file.lines.push({ type: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
		} else if (line.startsWith("[Blueprint diff notice")) {
			file = null;
		}
	}
	return files.filter((f) => f.path);
}
