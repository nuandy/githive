// Which changes need the checks. A change that only touches files no check reads (Markdown, docs/, licenses,
// images) merges without running them. A file under a folder that tests read, such as test/ or examples/, always
// runs them; Express's tests, for example, render a Markdown file under examples/. The module has no imports so
// the dashboard can use it too.

// Markdown and other doc formats. Not *.txt: requirements.txt and CMakeLists.txt are code as far as the checks go.
const DOC_FILES = ["*.md", "*.mdx", "*.markdown", "*.rst", "*.adoc"];
const IMAGES = ["*.png", "*.jpg", "*.jpeg", "*.gif", "*.webp", "*.ico"];
const NOTICES = ["LICENSE", "LICENCE", "COPYING", "NOTICE", "AUTHORS"];

/**
 * Patterns the checks skip unless a repo's settings say otherwise, stored with a repo when it starts. [] in settings
 * means they never skip.
 */
export const DEFAULT_SKIP_CHECKS = [
	...DOC_FILES,
	// The top's docs only: a folder named docs deeper down (src/docs/render.ts) can be code.
	"/docs/",
	"/doc/",
	// These names, alone or with an extension or a suffix (LICENSE-MIT), but not as the start of a name
	// (NOTICEBoard.ts).
	...NOTICES.flatMap((name) => [name, `${name}.*`, `${name}-*`]),
	...IMAGES,
];

/**
 * What a repo started before it stored its own list skips, so its merges are judged, then and in the audit, by the
 * rule they merged under: docs/ and doc/ at any depth, and the notices' names as prefixes.
 */
export const FIRST_SKIP_CHECKS = [...DOC_FILES, "docs/", "doc/", ...NOTICES.map((name) => `${name}*`), ...IMAGES];

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
 * Whether `pattern` covers `file`. "/name/" matches a folder at the top and "name/" a folder anywhere, a pattern
 * with a slash matches a path from the top, and any other pattern matches a file name anywhere.
 */
export function skipsFile(pattern: string, file: string): boolean {
	const segments = file.split("/");
	if (pattern.startsWith("/")) return fromTheTop(pattern.slice(1), file);
	if (pattern.endsWith("/")) return segments.slice(0, -1).includes(pattern.slice(0, -1));
	if (pattern.includes("/")) return glob(pattern).test(file);
	return glob(pattern).test(segments.at(-1)!);
}

// A pattern from the top: a folder there (docs/), or a path (docs/*.md). "/" alone covers nothing.
function fromTheTop(pattern: string, file: string): boolean {
	if (!pattern) return false;
	return pattern.endsWith("/") ? file.startsWith(pattern) : glob(pattern).test(file);
}

/** Whether a change can skip its checks: every file is skipped and none is in a folder tests read. */
export function skipsChecks(files: string[], patterns: string[] = FIRST_SKIP_CHECKS): boolean {
	if (!files.length || !patterns.length) return false;
	return files.every((file) => !inAlwaysCheckedFolder(file) && patterns.some((pattern) => skipsFile(pattern, file)));
}

const inAlwaysCheckedFolder = (file: string) =>
	file
		.split("/")
		.slice(0, -1)
		.some((folder) => ALWAYS_CHECKED_IN.includes(folder));
