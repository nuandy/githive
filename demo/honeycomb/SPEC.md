# Honeycomb: the spec

What every piece of Honeycomb keeps to, so the pieces can be built at the same time and fit together. [README.md](README.md) has the game's rules; this file is how the code meets them.

## How the code fits together

Plain ES modules, no framework. Logic lives in `src/*.js` and is tested in `test/*.test.js` with `node:test`; the page lives in `src/ui/*.js`, each with its own stylesheet in `styles/`. Each module keeps to the contract below, so they can be built at the same time and fit together.

### Logic

**`src/words.js`** exports `WORDS`, an array of lowercase strings.

**`src/puzzle.js`**

- `puzzleFor(date)`: the puzzle for a day. `date` is a `Date` or a `"YYYY-MM-DD"` string, read as a UTC day. Returns `{ id, letters, center, outer, answers, pangrams }`: `id` is the `"YYYY-MM-DD"` day; `center` is one letter; `outer` the six others; `letters` all seven, center first; `answers` every word in `WORDS` the puzzle accepts, sorted; `pangrams` the answers that use all seven letters. The same day always gives the same puzzle, with 20 to 60 answers and at least one pangram, chosen with a seeded random number generator from the day (never `Math.random`). A date outside the years 2000 to 2999, or one that isn't a real day, throws a `RangeError`.
- `isPangram(word, puzzle)`: whether a word uses all seven letters.

**`src/scoring.js`**

- `wordScore(word, puzzle)`: the points for one word, as the Rules in README.md say.
- `maxScore(puzzle)`: the points for finding every answer.
- `RANKS`: `[{ name, percent }]`, in order from Egg (0) to Queen (100).
- `rankFor(score, puzzle)`: `{ name, index, next }`, where `next` is `{ name, pointsNeeded }`, or `null` at Queen. A rank's threshold is its percent of `maxScore`, rounded up.

**`src/game.js`** (game objects are never changed; each function returns a new one)

- `newGame(puzzle, saved, scoreWord)`: `{ puzzle, found, score }`, starting from `saved.found` (a list of words) if given, keeping only words the puzzle accepts. `scoreWord(word, puzzle)` gives a word's points: `src/main.js` passes `wordScore` from `src/scoring.js`, and tests pass any function they like.
- `guess(game, word, scoreWord)`: `{ ok: true, game, points, pangram }` for a new answer, or `{ ok: false, reason }`, where `reason` is one of `"too-short"`, `"missing-center"`, `"bad-letters"`, `"not-a-word"`, `"already-found"`. The word is trimmed and lowercased first.
- `shuffleOuter(outer, random = Math.random)`: the six outer letters in a new order.

**`src/storage.js`** (saves to `localStorage`, and never throws: storage can be missing, full or blocked)

- `loadProgress(puzzleId, storage)`: `{ found }` saved for that puzzle, or `null`.
- `saveProgress(puzzleId, progress, storage)`.
- `loadSeenHelp(storage)` and `saveSeenHelp(storage)`: whether the player has seen the help, so it opens only on a first visit.
- `storage` is optional in each and defaults to `localStorage`, read inside a `try`: in a sandboxed page (as GitHive serves this site) even reading `globalThis.localStorage` throws, so never use it as a default parameter. Without storage, loads return `null` (or `false`) and saves do nothing; the game still plays.

**`src/share.js`**

- `shareText(game, rank, ranks)`: a short summary to paste into a chat, with no answers in it: the day, the rank, points and words found, and a row of hexagons (⬢ for each rank reached, ⬡ for the rest). `rank` is what `rankFor` returns and `ranks` is `RANKS`, both passed in by `src/main.js`.
- `share(text, nav = globalThis.navigator)`: uses the Web Share API if there is one, else copies to the clipboard. Resolves to `"shared"`, `"copied"` or `"failed"`.

### The page

`index.html` has these regions, by id: `#board`, `#entry`, `#controls`, `#message`, `#progress`, `#found`, `#yesterday`, and the buttons `#help-button`, `#share-button` and `#yesterday-button`. `src/main.js` wires the modules to them, and is the only module that puts two pieces together: it passes each the data it needs, such as yesterday's puzzle to `renderYesterday`, `wordScore` to the game, and the rank and `RANKS` to whatever shows them. No other module imports another piece's module (`src/words.js`, a starting file, is fine), so every piece can be built and tested on its own.

- **`src/ui/board.js`**: `renderBoard(element, puzzle, outer, { onLetter })` draws the seven letters as hexagons in a honeycomb (see The honeycomb, below), the center one highlighted, each a button that calls `onLetter(letter)`. Returns `{ setOuter(outer) }` to redraw after a shuffle. Styles in `styles/board.css`.
- **`src/ui/input.js`**: `bindInput(root, { onType, onDelete, onSubmit, onShuffle })` listens for letter keys, Backspace, Enter and the space bar (shuffle) as Keyboard, below, says, and draws the Delete, Shuffle and Enter buttons into `#controls`. `renderEntry(element, word, puzzle)` shows the word being typed, the center letter marked and letters outside the puzzle dimmed. Styles in `styles/input.css`.
- **`src/ui/progress.js`**: `renderProgress(element, game, rank, ranks)` draws the rank and a bar of the ranks with the current one marked, and the points to the next (`rank` is what `rankFor` returns and `ranks` is `RANKS`). `renderFound(element, game)` lists the words found, alphabetically, pangrams (from `game.puzzle.pangrams`) marked, with the count. Styles in `styles/progress.css`.
- **`src/ui/message.js`**: `showMessage(element, text, kind)` shows a short message that fades out: `kind` is `"good"`, `"great"` (a pangram) or `"bad"`. `#message` is a live region (`role="status"`) that screen readers must always reach: it fades by opacity alone, and its text is cleared once it has faded. Until the first `showMessage`, it shows whatever text the page put in it, fully visible. Never hide it with `hidden`, `display: none`, `visibility: hidden` or `aria-hidden` while a message shows. `messageFor(result)` turns a `guess` result into its text ("Too short", "Missing center letter", "Pangram!" and so on). Styles in `styles/message.css`.
- **`src/ui/help.js`**: `openHelp(ranks)` opens a dialog with the rules, scoring and the ranks (`ranks` is `RANKS`, passed in), and a line on how the game was built. Escape, its close button, or a click on the backdrop outside the dialog's box closes it; a click inside the box never does. Styles in `styles/help.css`.
- **`src/ui/yesterday.js`**: `renderYesterday(element, puzzle)` shows the puzzle it is given (`src/main.js` passes yesterday's, from `puzzleFor`): its letters as a small honeycomb laid out exactly as the board's (see The honeycomb), and every answer, pangrams marked, in a panel that opens and closes. It imports nothing from `src/puzzle.js`; its tests build a puzzle by hand. Styles in `styles/yesterday.css`.
- **`styles/theme.css`**: colors (honey and amber), type, the page layout on phones and desktops, and a dark mode that follows the system. It defines the colors below; every other stylesheet uses only these, never a color of its own.

### The honeycomb

The board and yesterday's panel draw the same shape: seven flat-topped hexagons, the center one in the middle and the six outer ones touching it, like a cell of a real comb.

- Each cell is a flat-topped hexagon, `clip-path: polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)`, of width `W` and height `H = W × 0.866`.
- Position each cell absolutely by its center, relative to the center cell's center at (0, 0): `outer[0]` top (0, −H), `outer[1]` upper right (0.75W, −H/2), `outer[2]` lower right (0.75W, H/2), `outer[3]` bottom (0, H), `outer[4]` lower left (−0.75W, H/2), `outer[5]` upper left (−0.75W, −H/2). Multiply every offset by 1.06 for a thin gap. The whole comb is `2.5W` wide and `3H` tall.
- `puzzle.center` (which is `letters[0]`) is always the middle cell. The board's `W` is at least 64px, so each cell is a comfortable tap target on a phone; yesterday's may be smaller.
- Don't build it from rows of a grid: the outer cells sit half a cell up or down from each other, which rows can't do.

So that the shape can be tested without a browser, `src/ui/board.js` and `src/ui/yesterday.js` each export `combLayout(width)`, a pure function: given `W` in pixels, it returns `{ width, height, cells }`, the comb's box and its seven cells in the order center, `outer[0]` to `outer[5]`, each `{ left, top, width, height }` in pixels from the box's top-left corner. Each module imports without a DOM (it touches `document` only inside functions), and draws exactly what `combLayout` says:

- the comb is `position: relative` with the box's `width` and `height`;
- each cell is `position: absolute` with its `left`, `top`, `width` and `height` set as inline styles, and no margin, transform, grid or flex that moves it;
- each cell is a `<button>` clipped to its hexagon (the `clip-path` above, on the button itself), so a tap or click lands only on the letter it shows: an unclipped button is a rectangle, and neighbouring rectangles overlap. The cell's colors are drawn by an element inside it, a hexagon inset 3px on every side (`position: absolute; inset: 3px` and the same `clip-path`), so a 3px hexagonal border of the button's own background shows around it. That border is the focus ring: the button's background is transparent, and `var(--focus)` on `:focus-visible`. Don't use `outline` or `box-shadow` for it; the `clip-path` cuts them off.

Their tests (`test/board.test.js`, `test/yesterday.test.js`) check `combLayout` for a few widths: the center cell is in the middle of the box; every outer cell's center is `1.06 × H` from the center cell's, in the direction above; no two cells' centers are closer than `H`, so no hexagons overlap; and every cell lies inside the box.

### Keyboard

`bindInput` listens for `keydown` on `document`, and the game is fully playable from the keyboard:

- Ignore a key with Ctrl, Meta or Alt held, and every key while a dialog (the help) is open.
- A letter key `a` to `z` types it, and Backspace deletes, wherever focus is, including on the board's letter buttons.
- Enter submits and the space bar shuffles, **except** when focus is on a button: then leave the key to the browser, so the button does what it says (a letter button types its letter, Shuffle shuffles). Don't call `preventDefault` for it.
- Every button can be reached with Tab and shows a visible focus ring (`--focus`); the board's cells show it as their hexagonal border (see The honeycomb).

### Colors and contrast

`styles/theme.css` defines these custom properties on `:root`, and again for dark mode inside `@media (prefers-color-scheme: dark)`:

| Property | Use |
| --- | --- |
| `--bg`, `--surface` | the page, and panels and dialogs on it |
| `--ink`, `--muted` | text on `--bg` and `--surface` |
| `--honey`, `--on-honey` | the center cell, and text on it |
| `--amber`, `--on-amber` | outer cells and highlights, and text on them |
| `--line` | borders |
| `--good`, `--bad` | message colors, used as text on `--bg` |
| `--focus` | focus rings |

Text and its background always come as one of these pairs, in both modes: `--ink` or `--muted` on `--bg` or `--surface`, `--on-honey` on `--honey`, `--on-amber` on `--amber`, and `--good` or `--bad` on `--bg`. Every pair has a contrast ratio of at least 4.5:1 in light mode and in dark mode. Don't put `--ink` on `--honey` or `--amber`: in dark mode it disappears.

### Every piece

A piece is done when:

- it keeps to its part of the contract above, and its tests (for logic) pass with `npm test`;
- the page loads with no errors in the console, with the files served from a folder of their own: every URL is relative (`src/...`, never `/src/...`);
- it works with storage blocked and in a sandboxed page;
- it follows Keyboard, Colors and contrast, and, for anything drawn, The honeycomb;
- motion respects `prefers-reduced-motion`.
