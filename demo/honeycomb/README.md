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

- `loadProgress(puzzleId, storage = globalThis.localStorage)`: `{ found }` saved for that puzzle, or `null`.
- `saveProgress(puzzleId, progress, storage = globalThis.localStorage)`.
- `loadSeenHelp(storage)` and `saveSeenHelp(storage)`: whether the player has seen the help, so it opens only on a first visit.

**`src/share.js`**

- `shareText(game)`: a short summary to paste into a chat, with no answers in it: the day, the rank, points and words found, and a row of hexagons (⬢ for each rank reached, ⬡ for the rest).
- `share(text, nav = globalThis.navigator)`: uses the Web Share API if there is one, else copies to the clipboard. Resolves to `"shared"`, `"copied"` or `"failed"`.

### The page

`index.html` has these regions, by id: `#board`, `#entry`, `#controls`, `#message`, `#progress`, `#found`, `#yesterday`, and the buttons `#help-button`, `#share-button` and `#yesterday-button`. `src/main.js` wires the modules to them.

- **`src/ui/board.js`**: `renderBoard(element, puzzle, outer, { onLetter })` draws the seven letters as hexagons in a honeycomb, the center one highlighted, each a button that calls `onLetter(letter)`. Returns `{ setOuter(outer) }` to redraw after a shuffle. Styles in `styles/board.css`.
- **`src/ui/input.js`**: `bindInput(root, { onType, onDelete, onSubmit, onShuffle })` listens for letter keys, Backspace, Enter and the space bar (shuffle), and draws the Delete, Shuffle and Enter buttons into `#controls`. `renderEntry(element, word, puzzle)` shows the word being typed, the center letter marked and letters outside the puzzle dimmed. Styles in `styles/input.css`.
- **`src/ui/progress.js`**: `renderProgress(element, game)` draws the rank and a bar of the ranks with the current one marked, and the points to the next. `renderFound(element, game)` lists the words found, alphabetically, pangrams marked, with the count. Styles in `styles/progress.css`.
- **`src/ui/message.js`**: `showMessage(element, text, kind)` shows a short message that fades out: `kind` is `"good"`, `"great"` (a pangram) or `"bad"`. `messageFor(result)` turns a `guess` result into its text ("Too short", "Missing center letter", "Pangram!" and so on). Styles in `styles/message.css`.
- **`src/ui/help.js`**: `openHelp()` opens a dialog with the rules, scoring and ranks, and a line on how the game was built. Styles in `styles/help.css`.
- **`src/ui/yesterday.js`**: `renderYesterday(element, puzzle)` shows the previous day's letters and every answer, pangrams marked, in a panel that opens and closes. Styles in `styles/yesterday.css`.
- **`styles/theme.css`**: colors (honey and amber), type, the page layout on phones and desktops, and a dark mode that follows the system.
