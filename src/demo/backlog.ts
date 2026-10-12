// The pieces a Honeycomb demo run's agents build, in the backlog each agent picks from (see demo-run.ts). Every
// piece keeps to the contract in the template's README, so they can be built at once and fit together. `after` names
// the pieces a piece needs merged first.

export interface DemoPiece {
	id: string;
	title: string;
	intent: string;
	paths: string[];
	after?: string[];
}

export const BACKLOG: DemoPiece[] = [
	{
		id: "puzzle",
		title: "Daily puzzle generation",
		intent:
			"src/puzzle.js: puzzleFor(date) and isPangram(word, puzzle) as README.md describes. Pick the " +
			"day's seven letters from the letter sets of WORDS' pangrams, and the center letter, with a small" +
			" seeded random number generator (mulberry32 or similar) seeded from the UTC day, trying " +
			"candidates until one gives 20 to 60 answers; it must be deterministic and fast (under 50 ms). " +
			"Keep to the contract in README.md (How the code fits together), which other agents build against" +
			" at the same time. Plain ES module, no dependencies. Write thorough tests with node:test in the " +
			"test file and run `npm test` before pushing (it's fast and needs no install). Test determinism, " +
			"the answer range, that every answer uses the center and only the seven letters, and that " +
			"pangrams are found.",
		paths: ["src/puzzle.js", "test/puzzle.test.js"],
	},
	{
		id: "scoring",
		title: "Scoring and ranks",
		intent:
			"src/scoring.js: wordScore, maxScore, RANKS and rankFor as README.md describes: 1 point for a " +
			"4-letter word, its length for a longer one, 7 more for a pangram; the nine bee ranks from Egg to" +
			" Queen. Keep to the contract in README.md (How the code fits together), which other agents build" +
			" against at the same time. Plain ES module, no dependencies. Write thorough tests with node:test" +
			" in the test file and run `npm test` before pushing (it's fast and needs no install).",
		paths: ["src/scoring.js", "test/scoring.test.js"],
	},
	{
		id: "game",
		title: "Game rules",
		intent:
			"src/game.js: newGame, guess and shuffleOuter as README.md describes, with each guess result's " +
			"reason. Game objects are never changed. Use wordScore from src/scoring.js for points. Keep to " +
			"the contract in README.md (How the code fits together), which other agents build against at the " +
			"same time. Plain ES module, no dependencies. Write thorough tests with node:test in the test " +
			"file and run `npm test` before pushing (it's fast and needs no install). Tests can build a small" +
			" puzzle object by hand.",
		paths: ["src/game.js", "test/game.test.js"],
		after: ["scoring"],
	},
	{
		id: "storage",
		title: "Saving progress",
		intent:
			"src/storage.js: loadProgress, saveProgress, loadSeenHelp and saveSeenHelp as README.md " +
			"describes, keyed per puzzle day, never throwing when storage is missing, full or blocked, and " +
			"ignoring stored data that doesn't parse. Keep to the contract in README.md (How the code fits " +
			"together), which other agents build against at the same time. Plain ES module, no dependencies. " +
			"Write thorough tests with node:test in the test file and run `npm test` before pushing (it's " +
			"fast and needs no install). Test with a fake storage object.",
		paths: ["src/storage.js", "test/storage.test.js"],
	},
	{
		id: "share",
		title: "Sharing a result",
		intent:
			"src/share.js: shareText and share as README.md describes. The text never gives away an answer. " +
			"Keep to the contract in README.md (How the code fits together), which other agents build against" +
			" at the same time. Plain ES module, no dependencies. Write thorough tests with node:test in the " +
			"test file and run `npm test` before pushing (it's fast and needs no install). Test share() with " +
			"fake navigator objects for each path.",
		paths: ["src/share.js", "test/share.test.js"],
		after: ["scoring"],
	},
	{
		id: "board",
		title: "The honeycomb board",
		intent:
			"src/ui/board.js: renderBoard as README.md describes: seven hexagon buttons in a honeycomb (the " +
			"center one in honey, the others paler), large and easy to tap on a phone, with a short press " +
			"animation; setOuter redraws after a shuffle with a gentle transition. Keep to the contract in " +
			"README.md (How the code fits together), which other agents build against at the same time. Plain" +
			" DOM code, no framework or dependencies, working in current browsers without a build step; " +
			"import other modules with relative paths ending in .js. Make it accessible: real buttons, " +
			"labels, focus states, and keyboard use. Keep its styles in its own stylesheet, using the CSS " +
			"custom properties styles/theme.css defines (--honey, --amber, --ink, --paper, --muted and so on)" +
			" with sensible fallbacks.",
		paths: ["src/ui/board.js", "styles/board.css"],
	},
	{
		id: "input",
		title: "Typing and controls",
		intent:
			"src/ui/input.js: bindInput and renderEntry as README.md describes: the Delete, Shuffle and Enter" +
			" buttons, keyboard input (ignoring keys while a dialog is open or a modifier is held), and the " +
			"word being typed with a blinking caret, the center letter in honey and letters outside the " +
			"puzzle dimmed. Keep to the contract in README.md (How the code fits together), which other " +
			"agents build against at the same time. Plain DOM code, no framework or dependencies, working in " +
			"current browsers without a build step; import other modules with relative paths ending in .js. " +
			"Make it accessible: real buttons, labels, focus states, and keyboard use. Keep its styles in its" +
			" own stylesheet, using the CSS custom properties styles/theme.css defines (--honey, --amber, " +
			"--ink, --paper, --muted and so on) with sensible fallbacks.",
		paths: ["src/ui/input.js", "styles/input.css"],
	},
	{
		id: "progress",
		title: "Rank and words found",
		intent:
			"src/ui/progress.js: renderProgress and renderFound as README.md describes: the rank name, a bar " +
			"of the nine ranks as small hexagons with the current one filled, the points to the next rank, " +
			"and the words found in columns, pangrams in bold, with a count. Keep to the contract in " +
			"README.md (How the code fits together), which other agents build against at the same time. Plain" +
			" DOM code, no framework or dependencies, working in current browsers without a build step; " +
			"import other modules with relative paths ending in .js. Make it accessible: real buttons, " +
			"labels, focus states, and keyboard use. Keep its styles in its own stylesheet, using the CSS " +
			"custom properties styles/theme.css defines (--honey, --amber, --ink, --paper, --muted and so on)" +
			" with sensible fallbacks.",
		paths: ["src/ui/progress.js", "styles/progress.css"],
		after: ["scoring"],
	},
	{
		id: "message",
		title: "Feedback messages",
		intent:
			"src/ui/message.js: showMessage and messageFor as README.md describes: friendly text for each " +
			'guess result (a new word shows its points, like "Nice! +5"; a pangram "Pangram! +14"), shown ' +
			"briefly and faded out, with a small shake for a bad guess. Keep to the contract in README.md " +
			"(How the code fits together), which other agents build against at the same time. Plain DOM code," +
			" no framework or dependencies, working in current browsers without a build step; import other " +
			"modules with relative paths ending in .js. Make it accessible: real buttons, labels, focus " +
			"states, and keyboard use. Keep its styles in its own stylesheet, using the CSS custom properties" +
			" styles/theme.css defines (--honey, --amber, --ink, --paper, --muted and so on) with sensible " +
			"fallbacks.",
		paths: ["src/ui/message.js", "styles/message.css"],
	},
	{
		id: "help",
		title: "How to play",
		intent:
			"src/ui/help.js: openHelp() as README.md describes: a <dialog> with the rules, how scoring works " +
			"with an example, the nine ranks from RANKS, and a closing line: built by a hive of AI agents " +
			"through GitHive (https://githive.app), each claiming its own piece, with no queen assigning the " +
			"work. Closes with Escape, a close button or a click outside. Keep to the contract in README.md " +
			"(How the code fits together), which other agents build against at the same time. Plain DOM code," +
			" no framework or dependencies, working in current browsers without a build step; import other " +
			"modules with relative paths ending in .js. Make it accessible: real buttons, labels, focus " +
			"states, and keyboard use. Keep its styles in its own stylesheet, using the CSS custom properties" +
			" styles/theme.css defines (--honey, --amber, --ink, --paper, --muted and so on) with sensible " +
			"fallbacks.",
		paths: ["src/ui/help.js", "styles/help.css"],
		after: ["scoring"],
	},
	{
		id: "yesterday",
		title: "Yesterday's answers",
		intent:
			"src/ui/yesterday.js: renderYesterday as README.md describes, using puzzleFor for the day before:" +
			" its letters as a small honeycomb, and every answer in columns with pangrams marked, in a panel " +
			"that opens and closes. Keep to the contract in README.md (How the code fits together), which " +
			"other agents build against at the same time. Plain DOM code, no framework or dependencies, " +
			"working in current browsers without a build step; import other modules with relative paths " +
			"ending in .js. Make it accessible: real buttons, labels, focus states, and keyboard use. Keep " +
			"its styles in its own stylesheet, using the CSS custom properties styles/theme.css defines " +
			"(--honey, --amber, --ink, --paper, --muted and so on) with sensible fallbacks.",
		paths: ["src/ui/yesterday.js", "styles/yesterday.css"],
		after: ["puzzle"],
	},
	{
		id: "theme",
		title: "Look and layout",
		intent:
			"styles/theme.css: the game's look: CSS custom properties for the palette (--honey, --amber, " +
			"--ink, --paper, --muted, --good, --bad), a warm honey-and-amber light theme and a dark theme " +
			"that follows prefers-color-scheme, a clean system font stack, the header, and the page layout: " +
			"the board and controls centered, with rank and words found beside it on wide screens and below " +
			"it on phones. Keep to styles/theme.css; other stylesheets style their own components. Keep to " +
			"the contract in README.md (How the code fits together), which other agents build against at the " +
			"same time.",
		paths: ["styles/theme.css"],
	},
	{
		id: "app",
		title: "Wire up the game",
		intent:
			"src/main.js: put the game together as README.md describes: today's puzzle, progress loaded and " +
			"saved after every word, the board, typing and controls, feedback messages, rank and words found," +
			" the help (opened on a first visit), the share button, and yesterday's answers. Read every " +
			"module first, and fix any mismatch between them in src/main.js rather than in other pieces. " +
			"Check the page loads without errors by importing every module under node where you can, and walk" +
			" through the code paths carefully. Keep to the contract in README.md (How the code fits " +
			"together), which other agents build against at the same time.",
		paths: ["src/main.js", "index.html"],
		after: [
			"puzzle",
			"scoring",
			"game",
			"storage",
			"share",
			"board",
			"input",
			"progress",
			"message",
			"help",
			"yesterday",
			"theme",
		],
	},
];
