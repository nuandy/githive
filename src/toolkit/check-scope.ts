// Which changes the checks are for. A change that only touches documentation
// and other files no check reads (Markdown, docs/, licenses, images) merges
// without running them; anything else runs them. A file under a folder that
// tests read (test/, fixtures/, examples/...) always runs them, whatever it
// is: Express's tests render examples/markdown/views/index.md, say.
//
// Pure, with no imports: merge and the audit decide with it, and the
// dashboard shows it.

/** What a repo's checks skip unless its settings say otherwise ([] in settings: they never skip). */
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

/** A pattern's characters: a path's, and * for any run of them within a name. */
export const SKIP_PATTERN = /^[A-Za-z0-9._/*@+-]+$/;

const glob = (pattern: string) =>
	new RegExp(
		`^${pattern
			.split("*")
			.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("[^/]*")}$`,
	);

/**
 * Whether a pattern covers a file: "name/" a folder of that name anywhere, a
 * pattern with a slash otherwise a path from the top, and one without a name
 * anywhere (* for any run of characters within a name).
 */
export function skipsFile(pattern: string, file: string): boolean {
	const segments = file.split("/");
	if (pattern.endsWith("/")) return segments.slice(0, -1).includes(pattern.slice(0, -1));
	if (pattern.includes("/")) return glob(pattern).test(file);
	return glob(pattern).test(segments.at(-1)!);
}

/** Whether a change touching `files` merges without its checks: every file skipped, and none where tests read. */
export function skipsChecks(files: string[], patterns: string[] = DEFAULT_SKIP_CHECKS): boolean {
	if (!files.length || !patterns.length) return false;
	return files.every(
		(file) =>
			!file
				.split("/")
				.slice(0, -1)
				.some((dir) => ALWAYS_CHECKED_IN.includes(dir)) && patterns.some((p) => skipsFile(p, file)),
	);
}
