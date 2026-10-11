// Relative import specifiers, resolved to repo paths the way TypeScript and bundlers do. Only relative specifiers:
// tsconfig paths, workspace packages and barrels come later.

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];
// An import written with .js often means the .ts file next to it (TypeScript's ESM style).
const JS_TO_TS: Record<string, string[]> = {
	".js": [".ts", ".tsx"],
	".jsx": [".tsx"],
	".mjs": [".mts"],
	".cjs": [".cts"],
};

/** `path` with "." and ".." segments folded and no empty ones; null when it climbs out of the repo. */
function normalize(path: string): string | null {
	const out: string[] = [];
	for (const segment of path.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment !== "..") out.push(segment);
		else if (out.pop() === undefined) return null;
	}
	return out.join("/");
}

/** Whether `spec` is relative ("./x", "../x", "." or ".."): the only kind resolved for now. */
export const isRelative = (spec: string) =>
	spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../");

/**
 * The repo path a relative specifier names from `fromFile`, before any extension or index lookup:
 * "../settings" from "src/jobs/sync.ts" is "src/settings". Null for a bare or absolute specifier, or one that
 * climbs out of the repo. The root itself is "".
 */
export function relativeTarget(fromFile: string, spec: string): string | null {
	if (!isRelative(spec)) return null;
	const dir = fromFile.split("/").slice(0, -1).join("/");
	return normalize(dir ? `${dir}/${spec}` : spec);
}

/** The files an import of `target` (from relativeTarget) may load, in the order they are tried. */
export function importTargets(target: string): string[] {
	const out: string[] = [];
	if (target) {
		out.push(target);
		const ext = /\.[^./]+$/.exec(target)?.[0] ?? "";
		for (const alt of JS_TO_TS[ext] ?? []) out.push(target.slice(0, -ext.length) + alt);
		for (const e of RESOLVE_EXTENSIONS) out.push(target + e);
	}
	for (const e of RESOLVE_EXTENSIONS) out.push(target ? `${target}/index${e}` : `index${e}`);
	return out;
}

/** Whether an import of `target` may load `file`. Without the tree, "./a" may be a.ts or a/index.ts. */
export const resolvesTo = (target: string, file: string) => importTargets(target).includes(file);

/** The file a relative import loads, given the files that exist; null when none does or `spec` isn't relative. */
export function resolveImport(fromFile: string, spec: string, exists: (path: string) => boolean): string | null {
	const target = relativeTarget(fromFile, spec);
	if (target === null) return null;
	return importTargets(target).find(exists) ?? null;
}
