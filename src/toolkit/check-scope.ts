// Which changes need the checks. A change that only touches files no check reads (Markdown, docs/, licenses,
// images) merges without running them. A file under a folder that tests read, such as test/ or examples/, always
// runs them; Express's tests, for example, render a Markdown file under examples/. The module has no imports so
// the dashboard can use it too.

/** Patterns the checks skip unless a repo's settings say otherwise. [] in settings means they never skip. */
export const DEFAULT_SKIP_CHECKS = [
	"*.md",
	"*.mdx",
	"*.markdown",
	"*.rst",
	"*.adoc",
	// Not *.txt: requirements.txt and CMakeLists.txt are code as far as the checks go.
	"docs/",
	"doc/",
	"LICENSE*",
	"LICENCE*",
	"COPYING*",
	"NOTICE*",
	"AUTHORS*",
	"*.png",
	"*.jpg",
	"*.jpeg",
	"*.gif",
	"*.webp",
	"*.ico",
];

/** Folders whose files tests may read: a change inside one always runs the checks. */
export const ALWAYS_CHECKED_IN = ["test", "tests", "__tests__", "spec", "specs", "fixtures", "examples", "example"];

/** A path's characters, plus * for any run of them within a name. */
export const SKIP_PATTERN = /^[A-Za-z0-9._/*@+-]+$/;

function glob(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("[^/]*");
	return new RegExp(`^${source}$`);
}

/**
 * Whether `pattern` covers `file`. "name/" matches a folder anywhere, a pattern with a slash matches a path from
 * the top, and any other pattern matches a file name anywhere.
 */
export function skipsFile(pattern: string, file: string): boolean {
	const segments = file.split("/");
	if (pattern.endsWith("/")) return segments.slice(0, -1).includes(pattern.slice(0, -1));
	if (pattern.includes("/")) return glob(pattern).test(file);
	return glob(pattern).test(segments.at(-1)!);
}

/** Whether a change can skip its checks: every file is skipped and none is in a folder tests read. */
export function skipsChecks(files: string[], patterns: string[] = DEFAULT_SKIP_CHECKS): boolean {
	if (!files.length || !patterns.length) return false;
	return files.every((file) => !inAlwaysCheckedFolder(file) && patterns.some((pattern) => skipsFile(pattern, file)));
}

const inAlwaysCheckedFolder = (file: string) =>
	file
		.split("/")
		.slice(0, -1)
		.some((folder) => ALWAYS_CHECKED_IN.includes(folder));
