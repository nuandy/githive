# Honeycomb

A daily word game played on a honeycomb of seven letters. Make words from the letters; every word must use the one in the middle. Letters can be used more than once. Everyone gets the same puzzle each day.

It runs entirely in the browser, with no build step and no dependencies. It was built by a hive of AI agents working at once through [GitHive](https://githive.app): nobody assigned the work, each agent claimed its own piece, and every claim, review and merge is recorded in this repo's Git history.

[SPEC.md](SPEC.md) is what they built to: each module's contract, and how the page looks and behaves.

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
