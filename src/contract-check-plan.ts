// Pure parts of the planner's contract check: which tsconfig checks which
// contract file, and which compiler errors count. Kept separate so they can
// be tested without containers.

/** Errors that only mean an implementation doesn't exist yet, which contracts expect. */
const EXPECTED_WHILE_UNBUILT = new Set([
	2307, // Cannot find module
	2305, // Module has no exported member
	2614, // Module has no exported member (did you mean default import)
	2724, // Module has no exported member named ... Did you mean ...
]);

export interface TscError {
	file: string;
	line: number;
	code: number;
	message: string;
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** The tsconfig.json nearest to a file, walking up from its directory; null if none. */
export function nearestConfig(file: string, configs: string[]): string | null {
	const available = new Set(configs);
	let dir = dirOf(file);
	for (;;) {
		const candidate = dir ? `${dir}/tsconfig.json` : "tsconfig.json";
		if (available.has(candidate)) return candidate;
		if (!dir) return null;
		dir = dirOf(dir);
	}
}

/**
 * Group TypeScript contract files by the config that should check them, with
 * paths relative to that config's directory. Files with no config are listed
 * separately as unchecked.
 */
export function contractGroups(files: string[], configs: string[]) {
	const groups = new Map<string, string[]>();
	const unchecked: string[] = [];
	for (const file of files.filter((f) => /\.(ts|tsx|mts|cts)$/.test(f))) {
		const config = nearestConfig(file, configs);
		if (!config) {
			unchecked.push(file);
			continue;
		}
		const base = dirOf(config);
		const relative = base ? file.slice(base.length + 1) : file;
		groups.set(config, [...(groups.get(config) ?? []), relative]);
	}
	return { groups, unchecked };
}

/** Parse `tsc --pretty false` output; paths are as tsc prints them (relative to the working directory). */
export function parseTsc(output: string): TscError[] {
	const errors: TscError[] = [];
	for (const line of output.split("\n")) {
		const m = /^(.+?)\((\d+),\d+\): error TS(\d+): (.*)$/.exec(line.trim());
		if (m) errors.push({ file: m[1], line: Number(m[2]), code: Number(m[3]), message: m[4] });
	}
	return errors;
}

/** Errors that are real mistakes in the contracts themselves. */
export function contractErrors(errors: TscError[], contracts: string[]) {
	const wanted = new Set(contracts);
	const seen = new Set<string>();
	return errors.filter((e) => {
		const key = `${e.file}:${e.line}:${e.code}:${e.message}`;
		if (!wanted.has(e.file) || EXPECTED_WHILE_UNBUILT.has(e.code) || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
