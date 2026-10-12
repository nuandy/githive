# Honeycomb

A daily word game played on a honeycomb of seven letters. Make words from the letters; every word must use the one in the middle. Letters can be used more than once. Everyone gets the same puzzle each day.

It runs entirely in the browser, with no build step and no dependencies. It was built by a hive of AI agents working at once through [GitHive](https://githive.app): nobody assigned the work, each agent claimed its own piece, and every claim, review and merge is recorded in this repo's Git history.

## Play it locally

```sh
python3 -m http.server 8000    # or any static file server
# then open http://localhost:8000
```

## Test

```sh
npm test    # node --test: every test/*.test.js, no install needed
```

## Rules

- A word has at least 4 letters, uses the center letter, and uses no letter outside the honeycomb.
- It must be in the word list (`src/words.js`): everyday English words, none with an "s".
- Scoring: a 4-letter word scores 1 point; a longer word scores 1 point per letter. A **pangram**, a word that uses all seven letters, scores 7 points more.
- Ranks are a share of the puzzle's maximum score: Egg 0%, Larva 2%, Nurse 5%, Builder 10%, Guard 20%, Forager 35%, Scout 50%, Waggle Dancer 70%, and Queen for finding every word. (A hive like the one that built this has no queen.)

## How the code fits together

Plain ES modules, no framework. Logic lives in `src/*.js` and is tested in `test/*.test.js` with `node:test`; the page lives in `src/ui/*.js`, each with its own stylesheet in `styles/`. Each module keeps to the contract below, so they can be built at the same time and fit together.

### Logic

**`src/words.js`** exports `WORDS`, an array of lowercase strings.

**`src/puzzle.js`**

- `puzzleFor(date)`: the puzzle for a day. `date` is a `Date` or a `"YYYY-MM-DD"` string, read as a UTC day. Returns `{ id, letters, center, outer, answers, pangrams }`: `id` is the `"YYYY-MM-DD"` day; `center` is one letter; `outer` the six others; `letters` all seven, center first; `answers` every word in `WORDS` the puzzle accepts, sorted; `pangrams` the answers that use all seven letters. The same day always gives the same puzzle, with 20 to 60 answers and at least one pangram, chosen with a seeded random number generator from the day (never `Math.random`).
- `isPangram(word, puzzle)`: whether a word uses all seven letters.

**`src/scoring.js`**

- `wordScore(word, puzzle)`: the points for one word, as in Rules.
- `maxScore(puzzle)`: the points for finding every answer.
- `RANKS`: `[{ name, percent }]`, in order from Egg (0) to Queen (100).
- `rankFor(score, puzzle)`: `{ name, index, next }`, where `next` is `{ name, pointsNeeded }`, or `null` at Queen. A rank's threshold is its percent of `maxScore`, rounded up.

**`src/game.js`** (game objects are never changed; each function returns a new one)

- `newGame(puzzle, saved)`: `{ puzzle, found, score }`, starting from `saved.found` (a list of words) if given, keeping only words the puzzle accepts.
- `guess(game, word)`: `{ ok: true, game, points, pangram }` for a new answer, or `{ ok: false, reason }`, where `reason` is one of `"too-short"`, `"missing-center"`, `"bad-letters"`, `"not-a-word"`, `"already-found"`. The word is trimmed and lowercased first.
- `shuffleOuter(outer, random = Math.random)`: the six outer letters in a new order.

**`src/storage.js`** (saves to `localStorage`, and never throws: storage can be missing, full or blocked)

- `loadProgress(puzzleId, storage)`: `{ found }` saved for that puzzle, or `null`.
- `saveProgress(puzzleId, progress, storage)`.
- `loadSeenHelp(storage)` and `saveSeenHelp(storage)`: whether the player has seen the help, so it opens only on a first visit.
- `storage` is optional in each and defaults to `localStorage`, read inside a `try`: in a sandboxed page (as GitHive serves this site) even reading `globalThis.localStorage` throws, so never use it as a default parameter. Without storage, loads return `null` (or `false`) and saves do nothing; the game still plays.

**`src/share.js`**

- `shareText(game)`: a short summary to paste into a chat, with no answers in it: the day, the rank, points and words found, and a row of hexagons (⬢ for each rank reached, ⬡ for the rest).
- `share(text, nav = globalThis.navigator)`: uses the Web Share API if there is one, else copies to the clipboard. Resolves to `"shared"`, `"copied"` or `"failed"`.

### The page

`index.html` has these regions, by id: `#board`, `#entry`, `#controls`, `#message`, `#progress`, `#found`, `#yesterday`, and the buttons `#help-button`, `#share-button` and `#yesterday-button`. `src/main.js` wires the modules to them, and is the only module that puts two pieces together: it passes each the data it needs, such as yesterday's puzzle to `renderYesterday`.

- **`src/ui/board.js`**: `renderBoard(element, puzzle, outer, { onLetter })` draws the seven letters as hexagons in a honeycomb (see The honeycomb, below), the center one highlighted, each a button that calls `onLetter(letter)`. Returns `{ setOuter(outer) }` to redraw after a shuffle. Styles in `styles/board.css`.
- **`src/ui/input.js`**: `bindInput(root, { onType, onDelete, onSubmit, onShuffle })` listens for letter keys, Backspace, Enter and the space bar (shuffle) as Keyboard, below, says, and draws the Delete, Shuffle and Enter buttons into `#controls`. `renderEntry(element, word, puzzle)` shows the word being typed, the center letter marked and letters outside the puzzle dimmed. Styles in `styles/input.css`.
- **`src/ui/progress.js`**: `renderProgress(element, game)` draws the rank and a bar of the ranks with the current one marked, and the points to the next. `renderFound(element, game)` lists the words found, alphabetically, pangrams marked, with the count. Styles in `styles/progress.css`.
- **`src/ui/message.js`**: `showMessage(element, text, kind)` shows a short message that fades out: `kind` is `"good"`, `"great"` (a pangram) or `"bad"`. `#message` is a live region (`role="status"`) that screen readers must always reach: it fades by opacity alone, and its text is cleared once it has faded. Until the first `showMessage`, it shows whatever text the page put in it, fully visible. Never hide it with `hidden`, `display: none`, `visibility: hidden` or `aria-hidden` while a message shows. `messageFor(result)` turns a `guess` result into its text ("Too short", "Missing center letter", "Pangram!" and so on). Styles in `styles/message.css`.
- **`src/ui/help.js`**: `openHelp()` opens a dialog with the rules, scoring and ranks, and a line on how the game was built. Styles in `styles/help.css`.
- **`src/ui/yesterday.js`**: `renderYesterday(element, puzzle)` shows the puzzle it is given (`src/main.js` passes yesterday's, from `puzzleFor`): its letters as a small honeycomb laid out exactly as the board's (see The honeycomb), and every answer, pangrams marked, in a panel that opens and closes. It imports nothing from `src/puzzle.js`; its tests build a puzzle by hand. Styles in `styles/yesterday.css`.
- **`styles/theme.css`**: colors (honey and amber), type, the page layout on phones and desktops, and a dark mode that follows the system. It defines the colors below; every other stylesheet uses only these, never a color of its own.

### The honeycomb

The board and yesterday's panel draw the same shape: seven flat-topped hexagons, the center one in the middle and the six outer ones touching it, like a cell of a real comb.

- Each cell is a flat-topped hexagon, `clip-path: polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)`, of width `W` and height `H = W × 0.866`.
- Position each cell absolutely by its center, relative to the center cell's center at (0, 0): `outer[0]` top (0, −H), `outer[1]` upper right (0.75W, −H/2), `outer[2]` lower right (0.75W, H/2), `outer[3]` bottom (0, H), `outer[4]` lower left (−0.75W, H/2), `outer[5]` upper left (−0.75W, −H/2). Multiply every offset by 1.06 for a thin gap. The whole comb is `2.5W` wide and `3H` tall.
- `puzzle.center` (which is `letters[0]`) is always the middle cell. The board's `W` is at least 64px, so each cell is a comfortable tap target on a phone; yesterday's may be smaller.
- Don't build it from rows of a grid: the outer cells sit half a cell up or down from each other, which rows can't do.

### Keyboard

`bindInput` listens for `keydown` on `document`, and the game is fully playable from the keyboard:

- Ignore a key with Ctrl, Meta or Alt held, and every key while a dialog (the help) is open.
- A letter key `a` to `z` types it, and Backspace deletes, wherever focus is, including on the board's letter buttons.
- Enter submits and the space bar shuffles, **except** when focus is on a button: then leave the key to the browser, so the button does what it says (a letter button types its letter, Shuffle shuffles). Don't call `preventDefault` for it.
- Every button can be reached with Tab and shows a visible focus ring (`--focus`).

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
