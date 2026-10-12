import { compact, type Declaration, type FileFacts } from "./extract";
import { resolvesTo } from "./resolve";

export type Change = "interface" | "removed" | "no longer exported" | "now exported";

/** An exported name whose interface changed between two versions of a file. */
export type AlteredName = {
	/** "loadSettings", or "Store.get" for a class member. */
	name: string;
	change: Change;
	/** The signature before (absent for nothing) and after (absent when removed). */
	before?: string;
	after?: string;
	/** The file's default export, or a member of it: importers name it "default". */
	default?: true;
};

/** A deleted file's facts: compared with them, every exported name is removed. */
export const NO_FILE: FileFacts = { declarations: [], imports: [] };

/**
 * The exported names that changed shape from `before` to `after`, in the order `before` declares them: a changed
 * signature (comments and whitespace aside), a removal, or an export toggled. Body-only changes and added names
 * give nothing; a rename is the old name removed. When either side didn't parse (null) nothing is known, so nothing
 * is reported. Pass NO_FILE for a side where the file doesn't exist.
 */
export function alteredNames(before: FileFacts | null, after: FileFacts | null): AlteredName[] {
	if (!before || !after) return [];
	const news = new Map(after.declarations.map((d) => [d.name, d]));
	const out: AlteredName[] = [];
	for (const o of before.declarations) {
		const n = news.get(o.name);
		const altered = compare(o, n);
		if (altered) out.push(altered);
	}
	// A class removed or toggled speaks for its members: drop theirs.
	const whole = new Set(out.filter((a) => a.change !== "interface" && !a.name.includes(".")).map((a) => a.name));
	return out.filter((a) => !(a.name.includes(".") && a.change !== "interface" && whole.has(ownerOf(a.name))));
}

function compare(o: Declaration, n: Declaration | undefined): AlteredName | null {
	let altered: AlteredName | null = null;
	if (!n) altered = o.exported ? { name: o.name, change: "removed", before: o.signature } : null;
	else if (o.exported !== n.exported)
		altered = {
			name: o.name,
			change: o.exported ? "no longer exported" : "now exported",
			before: o.signature,
			after: n.signature,
		};
	else if (o.exported && compact(o.signature) !== compact(n.signature))
		altered = { name: o.name, change: "interface", before: o.signature, after: n.signature };
	if (altered && (o.default || n?.default)) altered.default = true;
	return altered;
}

const ownerOf = (name: string) => name.split(".")[0]!;

/** The name importers use for an altered name: "default", its class for a member ("Store.get" -> "Store"), or itself. */
export function importedName(altered: { name: string; default?: true }): string {
	return altered.default ? "default" : ownerOf(altered.name);
}

/** Where a file uses one name of another file. */
export type Use = { file: string; name: string; lines: number[] };

/**
 * The names of the file at `path` that `facts` (another file's) uses, and on which lines: through named, default and
 * namespace imports (`ns.Store` is a use of Store; `ns` alone is a use of "*", any name of the file). Only relative
 * imports resolve, and without the tree "./a" counts as both a.ts and a/index.ts.
 */
export function usesOf(facts: Pick<FileFacts, "imports">, path: string): Use[] {
	const found = new Map<string, Set<number>>();
	const add = (name: string, lines: number[]) => {
		if (lines.length === 0) return;
		let all = found.get(name);
		if (!all) found.set(name, (all = new Set()));
		for (const l of lines) all.add(l);
	};
	for (const imp of facts.imports) {
		if (imp.resolved === undefined || !resolvesTo(imp.resolved, path)) continue;
		for (const n of imp.names) add(n.imported, n.uses);
		for (const u of imp.namespace?.uses ?? []) add(u.name, u.lines);
	}
	return [...found].map(([name, lines]) => ({ file: path, name, lines: [...lines].sort((a, b) => a - b) }));
}

/** The uses (from usesOf on the altered name's file) that reach an altered name: by its imported name, or "*". */
export function usesOfAltered(altered: AlteredName, uses: Use[]): Use[] {
	const name = importedName(altered);
	return uses.filter((u) => u.name === name || u.name === "*");
}
