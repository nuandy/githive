// The pieces a Honeycomb demo run's agents build, in the backlog each agent picks from (see demo-run.ts). Every
// piece keeps to the contract in the template's SPEC.md, so they can be built at once and fit together. `landsAfter`
// names the pieces one merges after, though it's built alongside them.

export interface DemoPiece {
	id: string;
	title: string;
	intent: string;
	paths: string[];
	landsAfter?: string[];
}

export const BACKLOG: DemoPiece[] = [
	{
		id: "puzzle",
		title: "Daily puzzle generation",
		intent:
			"src/puzzle.js: puzzleFor(date) and isPangram(word, puzzle) as SPEC.md describes. Pick the day's " +
			"seven letters from the letter sets of WORDS' pangrams, and the center letter, with a small seeded " +
			"random number generator (mulberry32 or similar) seeded from the UTC day, trying candidates until " +
			"one gives 20 to 60 answers; it must be deterministic and fast (under 50 ms). Keep to the contract " +
			"in SPEC.md, which other agents build against at the same time. Plain ES module, no dependencies. " +
			"Write thorough tests with node:test in the test file and run `npm test` before pushing (it's fast " +
			"and needs no install). Test determinism, the answer range, that every answer uses the center and " +
			"only the seven letters, and that pangrams are found.",
		paths: ["src/puzzle.js", "test/puzzle.test.js"],
	},
	{
		id: "scoring",
		title: "Scoring and ranks",
		intent:
			"src/scoring.js: wordScore, maxScore, RANKS and rankFor as SPEC.md describes: 1 point for a 4-letter " +
			"word, its length for a longer one, 7 more for a pangram; the nine bee ranks from Egg to Queen. Keep " +
			"to the contract in SPEC.md, which other agents build against at the same time. Plain ES module, no " +
			"dependencies. Write thorough tests with node:test in the test file and run `npm test` before " +
			"pushing (it's fast and needs no install).",
		paths: ["src/scoring.js", "test/scoring.test.js"],
	},
	{
		id: "game",
		title: "Game rules",
		intent:
			"src/game.js: newGame, guess and shuffleOuter as SPEC.md describes, with each guess result's reason. " +
			"Game objects are never changed. Points come from the scoreWord function passed in; it imports " +
			"nothing from src/scoring.js, so it needn't wait for it. Keep to the contract in SPEC.md, which " +
			"other agents build against at the same time. Plain ES module, no dependencies. Write thorough tests " +
			"with node:test in the test file and run `npm test` before pushing (it's fast and needs no install). " +
			"Tests can build a small puzzle object by hand.",
		paths: ["src/game.js", "test/game.test.js"],
	},
	{
		id: "storage",
		title: "Saving progress",
		intent:
			"src/storage.js: loadProgress, saveProgress, loadSeenHelp and saveSeenHelp as SPEC.md describes, " +
			"keyed per puzzle day, never throwing when storage is missing, full or blocked, and ignoring stored " +
			"data that doesn't parse. Keep to the contract in SPEC.md, which other agents build against at the " +
			"same time. Plain ES module, no dependencies. Write thorough tests with node:test in the test file " +
			"and run `npm test` before pushing (it's fast and needs no install). Test with a fake storage object.",
		paths: ["src/storage.js", "test/storage.test.js"],
	},
	{
		id: "share",
		title: "Sharing a result",
		intent:
			"src/share.js: shareText and share as SPEC.md describes. The text never gives away an answer. The " +
			"rank and RANKS are passed in; it imports nothing from src/scoring.js, so it needn't wait for it. " +
			"Keep to the contract in SPEC.md, which other agents build against at the same time. Plain ES " +
			"module, no dependencies. Write thorough tests with node:test in the test file and run `npm test` " +
			"before pushing (it's fast and needs no install). Test share() with fake navigator objects for each " +
			"path.",
		paths: ["src/share.js", "test/share.test.js"],
	},
	{
		id: "board",
		title: "The honeycomb board",
		intent:
			"src/ui/board.js: renderBoard as SPEC.md describes: seven hexagon buttons in a honeycomb (the center " +
			"one in honey, the others paler), large and easy to tap on a phone, with a short press animation; " +
			"setOuter redraws after a shuffle with a gentle transition. Keep to the contract in SPEC.md, which " +
			"other agents build against at the same time. Plain DOM code, no framework or dependencies, working " +
			"in current browsers without a build step; import other modules with relative paths ending in .js. " +
			"Make it accessible: real buttons, labels, focus states, and keyboard use. Keep its styles in its " +
			"own stylesheet, using only the theme colors SPEC.md lists (Colors and contrast), always in their " +
			"text-and-background pairs. Export combLayout and draw the comb from it, as SPEC.md (The honeycomb) " +
			"says, and test it in its test file with node:test: no overlapping cells, every outer cell touching " +
			"the center one. Run `npm test` before pushing.",
		paths: ["src/ui/board.js", "styles/board.css", "test/board.test.js"],
	},
	{
		id: "input",
		title: "Typing and controls",
		intent:
			"src/ui/input.js: bindInput and renderEntry as SPEC.md describes: the Delete, Shuffle and Enter " +
			"buttons, keyboard input (ignoring keys while a dialog is open or a modifier is held), and the word " +
			"being typed with a blinking caret, the center letter in honey and letters outside the puzzle " +
			"dimmed. Keep to the contract in SPEC.md, which other agents build against at the same time. Plain " +
			"DOM code, no framework or dependencies, working in current browsers without a build step; import " +
			"other modules with relative paths ending in .js. Make it accessible: real buttons, labels, focus " +
			"states, and keyboard use. Keep its styles in its own stylesheet, using only the theme colors " +
			"SPEC.md lists (Colors and contrast), always in their text-and-background pairs.",
		paths: ["src/ui/input.js", "styles/input.css"],
	},
	{
		id: "progress",
		title: "Rank and words found",
		intent:
			"src/ui/progress.js: renderProgress and renderFound as SPEC.md describes: the rank name, a bar of " +
			"the nine ranks as small hexagons with the current one filled, the points to the next rank, and the " +
			"words found in columns, pangrams in bold, with a count. The rank and RANKS are passed in; it " +
			"imports nothing from src/scoring.js, so it needn't wait for it. Keep to the contract in SPEC.md, " +
			"which other agents build against at the same time. Plain DOM code, no framework or dependencies, " +
			"working in current browsers without a build step; import other modules with relative paths ending " +
			"in .js. Make it accessible: real buttons, labels, focus states, and keyboard use. Keep its styles " +
			"in its own stylesheet, using only the theme colors SPEC.md lists (Colors and contrast), always in " +
			"their text-and-background pairs.",
		paths: ["src/ui/progress.js", "styles/progress.css"],
	},
	{
		id: "message",
		title: "Feedback messages",
		intent:
			"src/ui/message.js: showMessage and messageFor as SPEC.md describes: friendly text for each guess " +
			'result (a new word shows its points, like "Nice! +5"; a pangram "Pangram! +14"), shown briefly and ' +
			"faded out, with a small shake for a bad guess. Keep to the contract in SPEC.md, which other agents " +
			"build against at the same time. Plain DOM code, no framework or dependencies, working in current " +
			"browsers without a build step; import other modules with relative paths ending in .js. Make it " +
			"accessible: real buttons, labels, focus states, and keyboard use. Keep its styles in its own " +
			"stylesheet, using only the theme colors SPEC.md lists (Colors and contrast), always in their " +
			"text-and-background pairs.",
		paths: ["src/ui/message.js", "styles/message.css"],
	},
	{
		id: "help",
		title: "How to play",
		intent:
			"src/ui/help.js: openHelp(ranks) as SPEC.md describes: a <dialog> with the rules, how scoring works " +
			"with an example, the nine ranks it's given (RANKS, passed in by src/main.js, so it imports nothing " +
			"from src/scoring.js), and a closing line: built by a hive of AI agents through GitHive " +
			"(https://githive.app), each claiming its own piece, with no queen assigning the work. Closes with " +
			"Escape, a close button or a click on the backdrop outside the dialog, never a click inside it. Keep " +
			"to the contract in SPEC.md, which other agents build against at the same time. Plain DOM code, no " +
			"framework or dependencies, working in current browsers without a build step; import other modules " +
			"with relative paths ending in .js. Make it accessible: real buttons, labels, focus states, and " +
			"keyboard use. Keep its styles in its own stylesheet, using only the theme colors SPEC.md lists " +
			"(Colors and contrast), always in their text-and-background pairs.",
		paths: ["src/ui/help.js", "styles/help.css"],
	},
	{
		id: "yesterday",
		title: "Yesterday's answers",
		intent:
			"src/ui/yesterday.js: renderYesterday as SPEC.md describes, for the puzzle it's given, which " +
			"src/main.js gets from puzzleFor for the day before: its letters as a small honeycomb, and every " +
			"answer in columns with pangrams marked, in a panel that opens and closes. It imports nothing from " +
			"src/puzzle.js, so it needn't wait for it. Its tests run under Node, with no page: they cover " +
			"combLayout and its other pure functions with a puzzle built by hand, not what it draws (see " +
			"SPEC.md, The honeycomb). Keep to the contract in SPEC.md, which other agents build against at the " +
			"same time. Plain DOM code, no framework or dependencies, working in current browsers without a " +
			"build step; import other modules with relative paths ending in .js. Make it accessible: real " +
			"buttons, labels, focus states, and keyboard use. Keep its styles in its own stylesheet, using only " +
			"the theme colors SPEC.md lists (Colors and contrast), always in their text-and-background pairs. " +
			"Export combLayout and draw the comb from it, as SPEC.md (The honeycomb) says, and test it in its " +
			"test file with node:test: no overlapping cells, every outer cell touching the center one. Run `npm " +
			"test` before pushing.",
		paths: ["src/ui/yesterday.js", "styles/yesterday.css", "test/yesterday.test.js"],
	},
	{
		id: "theme",
		title: "Look and layout",
		intent:
			"styles/theme.css: the game's look: every custom property SPEC.md lists under Colors and contrast, " +
			"each text-and-background pair at 4.5:1 or more, in a warm honey-and-amber light theme and a dark " +
			"theme that follows prefers-color-scheme, a clean system font stack, the header, and the page " +
			"layout: the board and controls centered, with rank and words found beside it on wide screens and " +
			"below it on phones. Keep to styles/theme.css; other stylesheets style their own components. Keep to " +
			"the contract in SPEC.md, which other agents build against at the same time.",
		paths: ["styles/theme.css"],
	},
	{
		id: "app",
		title: "Wire up the game",
		intent:
			"src/main.js: put the game together as SPEC.md describes: today's puzzle, progress loaded and saved " +
			"after every word, the board, typing and controls, feedback messages, rank and words found, the help " +
			"(opened on a first visit), the share button, and yesterday's answers. It's built while the other " +
			"pieces are, so write it against the contract, not against their code. Before you finish, fetch " +
			"main: for every module that has landed by then, read it and check src/main.js uses it as it is, " +
			"fixing any mismatch in src/main.js rather than in other pieces. It merges only once every other " +
			"piece has. Keep to the contract in SPEC.md, which other agents build against at the same time. To " +
			"reviewers: the pieces it lands after may not have landed when its commit was made, so a module they " +
			"build can be missing from its checkout. That's expected, not a fault: review src/main.js against " +
			"SPEC.md, since it merges only once every one of them has, and the landing runs the tests with them " +
			"all.",
		paths: ["src/main.js", "index.html"],
		landsAfter: [
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
