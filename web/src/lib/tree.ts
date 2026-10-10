// A repo's flat, sorted list of file paths, seen as folders and files.

export interface TreeNode {
	name: string;
	/** Full path; a folder's has no trailing slash. */
	path: string;
	kind: "dir" | "file";
	children: TreeNode[];
}

const byKindThenName = (a: TreeNode, b: TreeNode) =>
	a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1;

/** The folder tree of a list of file paths: folders first, then files, each by name. */
export function buildTree(files: string[]): TreeNode[] {
	const root: TreeNode = { name: "", path: "", kind: "dir", children: [] };
	const dirs = new Map<string, TreeNode>([["", root]]);
	for (const file of files) {
		const parts = file.split("/").filter(Boolean);
		let parent = root;
		for (let i = 0; i < parts.length; i++) {
			const path = parts.slice(0, i + 1).join("/");
			if (i === parts.length - 1) {
				parent.children.push({ name: parts[i], path, kind: "file", children: [] });
			} else {
				let dir = dirs.get(path);
				if (!dir) {
					dir = { name: parts[i], path, kind: "dir", children: [] };
					dirs.set(path, dir);
					parent.children.push(dir);
				}
				parent = dir;
			}
		}
	}
	const sort = (node: TreeNode) => {
		node.children.sort(byKindThenName);
		node.children.forEach(sort);
	};
	sort(root);
	return root.children;
}

export const normalizePath = (path: string) => path.split("/").filter(Boolean).join("/");

/** What a path names in the listing: a file, a folder, or nothing. */
export function pathKind(files: string[], path: string): "file" | "dir" | "missing" {
	const clean = normalizePath(path);
	if (!clean) return "dir";
	if (files.includes(clean)) return "file";
	return files.some((file) => file.startsWith(`${clean}/`)) ? "dir" : "missing";
}

/** One folder's entries (folders first), as the Code tab lists them. */
export function listDir(files: string[], path: string): TreeNode[] {
	const clean = normalizePath(path);
	const prefix = clean ? `${clean}/` : "";
	const entries = new Map<string, TreeNode>();
	for (const file of files) {
		if (!file.startsWith(prefix)) continue;
		const rest = file.slice(prefix.length);
		const [name, ...more] = rest.split("/");
		if (!name) continue;
		const kind = more.length ? "dir" : "file";
		if (!entries.has(name)) entries.set(name, { name, path: `${prefix}${name}`, kind, children: [] });
	}
	return [...entries.values()].sort(byKindThenName);
}

/** "src/stats/page.tsx" → [{name: "src", path: "src"}, {name: "stats", path: "src/stats"}, {name: "page.tsx", …}] */
export function pathCrumbs(path: string): { name: string; path: string }[] {
	const parts = normalizePath(path).split("/").filter(Boolean);
	return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join("/") }));
}
