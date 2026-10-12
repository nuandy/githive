import type { RepoAudit, RepoSnapshot } from "../../src/api.ts";
import { DEFAULT_SKIP_CHECKS } from "../../../src/toolkit/check-scope.ts";
import { DAY_MINUTES, ago, daysAgo } from "./clock.ts";
import { sha } from "./ids.ts";
import { type RepoFixture, landingOf, summaryOf } from "./repo.ts";
import { type Story, buildHive, landedLongAgo, snapshotVotes } from "./stories.ts";

// The quieter repos: acme/docs (its last stretch of work just landed), robin/notes (the admin's own, at work),
// oss-friend/tiny-lib (someone else's public repo, long quiet) and acme/new-thing (made, not started).

const day = (days: number, minutes = 0) => days * DAY_MINUTES + minutes;
const noAudit = (merges: number): RepoAudit => ({ merges, open: 0, violations: [] });

/** A repo's snapshot with the settings most small repos keep. */
function snapshotOf(
	repo: string,
	fields: Partial<RepoSnapshot> & Pick<RepoSnapshot, "claims" | "votes">,
): RepoSnapshot {
	return {
		repo,
		branch: "main",
		skipChecks: DEFAULT_SKIP_CHECKS,
		branches: [],
		policy: { required: 1, vetoes: [] },
		verify: ["npm test"],
		verified: true,
		sharding: "on demand",
		votesSharding: "on demand",
		...fields,
	};
}

// acme/docs

const DOCS = "acme/docs";
const DOCS_FILES = [
	".github/workflows/publish.yml",
	"README.md",
	"docs/getting-started.md",
	"docs/guides/agents.md",
	"docs/guides/branches.md",
	"docs/guides/reviews.md",
	"docs/img/hive.png",
	"docs/index.md",
	"docs/reference/api.md",
	"docs/reference/cli.md",
	"mkdocs.yml",
];

const docsStories: Story[] = [
	landedLongAgo(
		"docs-skeleton",
		"robin/builder",
		"Set up the docs site: MkDocs, a getting-started page and the publish workflow.",
		["mkdocs.yml", "docs/index.md", "docs/getting-started.md", ".github/workflows/publish.yml"],
		day(30, 200),
		[],
	),
	landedLongAgo(
		"agents-guide",
		"mara/claude",
		"Write the guide to connecting agents.",
		["docs/guides/agents.md"],
		day(9, 70),
		[["devon/codex", "review", "Followed it with a fresh token: Claude Code and Codex both connect."]],
	),
	landedLongAgo(
		"reviews-guide",
		"ines/claude",
		"Explain how reviews and blocking roles work, with the storefront's settings as the example.",
		["docs/guides/reviews.md", "docs/img/hive.png"],
		day(4, 310),
		[["mara/claude", "review", "Matches the settings tab word for word; the diagram's roles are right."]],
	),
	{
		change: "guide-branches",
		agent: "mara/claude",
		intent: "Document branches: making one from the dashboard, and how changes land on it.",
		paths: ["docs/guides/branches.md"],
		claimed: 105,
		steps: [
			{ kind: "push", at: 96, message: "Add the branches guide" },
			{
				kind: "vote",
				at: 92,
				reviewer: "devon/codex",
				role: "review",
				verdict: "approve",
				evidence: "Made release/test from the dashboard following it; every step matches.",
			},
			{ kind: "merging", at: 90 },
			{ kind: "landed", at: 88 },
		],
	},
	{
		change: "cli-flags",
		agent: "devon/codex",
		intent: "Fix the CLI reference: --branch and --into were swapped.",
		paths: ["docs/reference/cli.md"],
		claimed: 102,
		steps: [
			{ kind: "push", at: 94, message: "Swap --branch and --into back" },
			{
				kind: "vote",
				at: 89,
				reviewer: "mara/claude",
				role: "review",
				verdict: "approve",
				evidence: "Checked against githive --help: now they match.",
			},
			{ kind: "merging", at: 86 },
			{ kind: "landed", at: 84 },
		],
	},
	{
		change: "api-examples",
		agent: "mara/claude",
		intent: "Add request and response examples to the API reference.",
		paths: ["docs/reference/api.md"],
		claimed: 99,
		steps: [
			{ kind: "push", at: 91, message: "Add examples to the API reference" },
			{
				kind: "vote",
				at: 87,
				reviewer: "devon/codex",
				role: "review",
				verdict: "approve",
				evidence: "Ran each curl example against staging; the responses match.",
			},
			{ kind: "merging", at: 82 },
			{ kind: "landed", at: 80 },
		],
	},
];

const docsHive = buildHive({
	repo: DOCS,
	branch: "main",
	policy: { required: 1, vetoes: [] },
	baseHead: sha(`${DOCS}:base`),
	stories: docsStories,
	logReach: 300,
	files: DOCS_FILES,
});
const docsStretch = { landed: 3, failed: 0, agents: 2, from: ago(105), to: ago(80) };
const docsSnapshot = snapshotOf(DOCS, {
	claims: docsHive.claims,
	votes: snapshotVotes(docsHive.votes),
	verify: [],
	sharding: "never",
	votesSharding: "never",
});
const docsAudit = noAudit(docsHive.landed.length);

export const DOCS_REPO: RepoFixture = {
	fullName: DOCS,
	id: "r-docs",
	visibility: "private",
	createdAt: daysAgo(31),
	level: "admin",
	branch: "main",
	heads: { main: docsHive.head },
	files: DOCS_FILES,
	hive: {
		snapshot: docsSnapshot,
		audit: docsAudit,
		events: docsHive.events,
		landings: { main: landingOf(docsHive, "main", docsStretch) },
		histories: { main: { branch: "main", total: docsHive.landed.length, changes: docsHive.landed } },
		changes: docsHive.changes,
	},
	hosted: null,
	collaborators: [],
	summary: summaryOf(docsSnapshot, docsAudit, docsHive.lastActivity, docsStretch),
};

// robin/notes

const NOTES = "robin/notes";
const NOTES_FILES = [
	".gitignore",
	"README.md",
	"package.json",
	"src/export/html.ts",
	"src/export/markdown.ts",
	"src/index.ts",
	"src/notes.ts",
	"src/search.ts",
	"src/storage.ts",
	"src/tags.ts",
	"test/notes.test.ts",
	"test/search.test.ts",
	"tsconfig.json",
];

const notesStories: Story[] = [
	landedLongAgo(
		"notes-init",
		"robin/builder",
		"Start the notes app: notes in local storage, a list and an editor.",
		["src/index.ts", "src/notes.ts", "src/storage.ts", "package.json"],
		day(12, 400),
		[],
	),
	landedLongAgo(
		"markdown-export",
		"robin/builder",
		"Export a note as Markdown, with its tags as front matter.",
		["src/export/markdown.ts"],
		day(6, 30),
		[["robin/reviewer", "review", "Round-trips: export then import gives the same note and tags."]],
	),
	landedLongAgo(
		"fuzzy-search",
		"robin/builder",
		"Fuzzy search over titles and bodies.",
		["src/search.ts", "test/search.test.ts"],
		day(2, 500),
		[["robin/reviewer", "review", "Typos within two letters still find the note; 2,000 notes search in under 10 ms."]],
	),
	{
		change: "notes-sort",
		agent: "robin/builder",
		intent: "Sort the note list by last edited, title or created.",
		paths: ["src/notes.ts", "test/notes.test.ts"],
		claimed: 190,
		steps: [
			{ kind: "push", at: 170, message: "Sort notes by last edited, title or created" },
			{
				kind: "vote",
				at: 160,
				reviewer: "robin/reviewer",
				role: "review",
				verdict: "approve",
				evidence: "The order is kept per device; titles sort case-insensitively.",
			},
			{ kind: "merging", at: 152 },
			{ kind: "landed", at: 150 },
		],
	},
	{
		change: "tag-search",
		agent: "robin/builder",
		intent: "Search notes by tag: #tag in the search box narrows to notes with it.",
		paths: ["src/search.ts", "src/tags.ts", "test/search.test.ts"],
		claimed: 70,
		active: 40,
		steps: [{ kind: "push", at: 40, message: "Narrow search to #tags" }],
	},
	{
		change: "export-pdf",
		agent: "robin/builder",
		intent: "Export a note as PDF, through the HTML exporter.",
		paths: ["src/export/pdf.ts", "src/export/html.ts"],
		claimed: 20,
		active: 6,
		steps: [],
	},
];

const notesHive = buildHive({
	repo: NOTES,
	branch: "main",
	policy: { required: 1, vetoes: [] },
	baseHead: sha(`${NOTES}:base`),
	stories: notesStories,
	logReach: 300,
	files: NOTES_FILES,
});
const notesStretch = { landed: 1, failed: 0, agents: 1, from: ago(190), to: ago(150) };
const notesSnapshot = snapshotOf(NOTES, { claims: notesHive.claims, votes: snapshotVotes(notesHive.votes) });
const notesAudit = noAudit(notesHive.landed.length);

export const NOTES_REPO: RepoFixture = {
	fullName: NOTES,
	id: "r-notes",
	visibility: "private",
	createdAt: daysAgo(13),
	level: "admin",
	branch: "main",
	heads: { main: notesHive.head },
	files: NOTES_FILES,
	hive: {
		snapshot: notesSnapshot,
		audit: notesAudit,
		events: notesHive.events,
		landings: { main: landingOf(notesHive, "main", notesStretch) },
		histories: { main: { branch: "main", total: notesHive.landed.length, changes: notesHive.landed } },
		changes: notesHive.changes,
	},
	hosted: null,
	collaborators: [],
	summary: summaryOf(notesSnapshot, notesAudit, notesHive.lastActivity, notesStretch),
};

// oss-friend/tiny-lib

const TINY = "oss-friend/tiny-lib";
const TINY_FILES = [
	".github/workflows/test.yml",
	"LICENSE",
	"README.md",
	"package.json",
	"src/debounce.ts",
	"src/index.ts",
	"src/memo.ts",
	"src/once.ts",
	"src/throttle.ts",
	"test/debounce.test.ts",
	"test/memo.test.ts",
	"test/throttle.test.ts",
	"tsconfig.json",
];

const tinyStories: Story[] = [
	landedLongAgo(
		"debounce",
		"oss-friend/claude",
		"debounce(fn, ms) with leading and trailing options.",
		["src/debounce.ts", "test/debounce.test.ts", "src/index.ts"],
		day(30),
		[],
	),
	landedLongAgo(
		"throttle",
		"oss-friend/codex",
		"throttle(fn, ms) built on debounce's timer handling.",
		["src/throttle.ts", "test/throttle.test.ts"],
		day(21, 300),
		[["oss-friend/claude", "review", "Fires at most once per window under a 1 ms event loop in the tests."]],
	),
	landedLongAgo(
		"memo",
		"oss-friend/claude",
		"memo(fn) with an LRU of a given size.",
		["src/memo.ts", "test/memo.test.ts"],
		day(16, 60),
		[["oss-friend/codex", "review", "Evicts least recently used first; hits don't allocate."]],
	),
	landedLongAgo(
		"once",
		"oss-friend/codex",
		"once(fn): call it at most once, then return the first result.",
		["src/once.ts", "src/index.ts"],
		day(9, 70),
		[["oss-friend/claude", "review", "Rethrows the first error on later calls, as documented."]],
	),
	landedLongAgo("readme-examples", "oss-friend/claude", "README: an example for each helper.", ["README.md"], day(9), [
		["oss-friend/codex", "review", "Every example runs as written in node 22."],
	]),
];

const tinyHive = buildHive({
	repo: TINY,
	branch: "main",
	policy: { required: 1, vetoes: [] },
	baseHead: sha(`${TINY}:base`),
	stories: tinyStories,
	// The log was dropped once the repo went quiet: nothing in it now.
	logReach: 0,
	files: TINY_FILES,
});
const tinyStretch = { landed: 2, failed: 0, agents: 2, from: daysAgo(9, 230), to: daysAgo(9) };
const tinySnapshot = snapshotOf(TINY, {
	claims: tinyHive.claims,
	votes: snapshotVotes(tinyHive.votes),
	github: { repo: "oss-friend/tiny-lib", sync: "mirror", trust: false, inbound: false, pull: null },
});
const tinyAudit = noAudit(tinyHive.landed.length);

export const TINY_LIB: RepoFixture = {
	fullName: TINY,
	id: "r-tiny-lib",
	visibility: "public",
	createdAt: daysAgo(31),
	level: "read",
	others: true,
	branch: "main",
	heads: { main: tinyHive.head },
	files: TINY_FILES,
	hive: {
		snapshot: tinySnapshot,
		audit: tinyAudit,
		events: tinyHive.events,
		landings: { main: landingOf(tinyHive, "main", tinyStretch) },
		histories: { main: { branch: "main", total: tinyHive.landed.length, changes: tinyHive.landed } },
		changes: tinyHive.changes,
	},
	hosted: null,
	collaborators: [],
	summary: summaryOf(tinySnapshot, tinyAudit, daysAgo(9), tinyStretch),
};

// acme/new-thing: made a few minutes ago, with no commits, and GitHive not started on it.

export const NEW_THING: RepoFixture = {
	fullName: "acme/new-thing",
	id: "r-new-thing",
	visibility: "private",
	createdAt: ago(25),
	level: "admin",
	branch: null,
	heads: {},
	files: [],
	hive: null,
	hosted: null,
	collaborators: [],
	summary: null,
};
