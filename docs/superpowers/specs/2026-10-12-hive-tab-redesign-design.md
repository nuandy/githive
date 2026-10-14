# The Hive tab, redesigned

Date: 2026-10-12. Status: built (PR #3, then reworked in PR 5, merged as d83d8f4); kept as the design it started from.

## What we're after

Opening a repo's Hive tab should answer, at a glance, **what's happening right now**: which agents are here, what
each one set out to do, and what happened to it. Agents arrive from different people and tools (alice's Claude Code,
bob's Codex, GitHive's own builder), each with a goal of its own: a feature, a fix, a refactor. There is no single goal
for the swarm, so the page tells many small stories side by side, not one progress bar.

Success: someone who has never seen GitHive can say, within a few seconds, who's working, on what, and whether anything
is stuck. Someone who comes back after an hour can tell what happened while they were away without reading a wall of
lines.

## What's wrong today

From the live tab (screenshots, 12 Oct) and `web/src/components/HiveTab.tsx`:

- **One goal is spread over many lines.** "app" shows as claimed, claimed again, pushed, asked to land and landed:
  five feed rows, newest first, so its story reads backwards.
- **The headline is the agent's whole brief.** `claimTitle` takes the intent's first line; a hosted builder's intent
  is one 100-word paragraph, so the feed prints all of it, once per claim.
- **Finished work loses its names.** Once a change lands its claim is gone, so the feed says "an agent pushed to app"
  and Agents says "reviewing bfa0f510 · approved bfa0f510".
- **Empty panels take the room.** The map explains a four-item key above four grey cells; Landing draws an empty
  track. Each claimed change appears in up to five panels.
- **Colors mean who, not what.** Each agent has a hash color; with 20 agents they can't be told apart, and the state
  hides in a pale fill, a ring and a lamp.
- **Nothing moves.** Each live ping redraws in place, so what just changed is invisible.

## The page

Top to bottom, on a wide screen (≥ 1100 px):

1. **Needs-you line**, only when something needs a person: an agent asking a person (`claim.attention`), a change
   put out because its checks failed (in the time range), merges the audit flags. One line, each item a link. A
   change waiting for a veto role (`approval.awaiting`) says so in its own row instead, since an agent may hold the
   role.
2. **Stage strip**: five counts, each in its stage's color, that bump when they change. It doubles as the key, so
   the map needs no legend. *Up next* (backlog items free to take; shown only when the server provides the backlog,
   see Phase 2) · *Building* · *In review* · *Landing* (approved or being checked) · *Landed* (in the goals panel's
   time range). When nothing is in flight it reads as the recap: "All landed · 6 changes by 4 agents in 14 min ·
   audit clean".
3. Two columns: **the hive** (left, about 5/12, sticky while the right column scrolls) and **the goals panel**
   (right, about 7/12).

Narrow screens stack them: strip, goals, hive. The current Agents, Landing and Right now panels go away; what they
said lives in the goals panel and the hive.

## The hive

The repo as a honeycomb, as now, with these changes:

- **Color is state, one meaning per color:** free (dim outline), up next (dashed outline), building (accent fill),
  in review (accent, dashed), approved (green edge), landing (amber edge, blinking lamp), landed lately (green tint,
  fading over 30 minutes, labelled with who built it). Lamps keep the app's meanings: amber checking, green landed,
  red failed. Agents' hash colors are no longer used here.
- **Agents are chips** on the cells their goals claim: a short label (the name's trailing number, "agent-19" → 19;
  else the first two letters of its last word, "githive-forager" → Fo) with the full name on hover. Up to three
  chips per cell, then "+n".
- **A cell shared by several goals** takes the state of its loudest goal: needs a person > changes asked > landing >
  approved > in review > building.
- **Busy folders open up.** A folder holding a claimed or recently landed path opens into its children, down to
  files, until each such path has a cell of its own (within the cell budget, `MAX_HEXES`). Quiet folders stay
  folded. Busy and quiet parts are drawn as separate clusters, labelled ("test/ · busy, opened into its files";
  "the rest of the repo · quiet"). This fixes the Express case, where all twenty agents worked in `test/` and today's
  map stacks them on one cell.
- **When the hive is idle** it isn't blank: landed-lately cells show who built what in the last stretch.
- **Clicking a cell** filters the goals panel to the goals that touch it; clicking again clears the filter.

## The goals panel

One row per **goal**, where a goal is one change: its agent's announced intent and everything that happened to it.
Events never get rows of their own.

### Story mode (default)

Each row:
- the agent's chip
- the goal's **short title**: the intent's first sentence, cut at a colon or full stop, at most about 60
  characters (Phase 2 replaces this with a real title)
- a second line: agent · paths (first one, "+n") · status in words, coloured ("landing · after 1 rejection",
  "waiting for a security vote", "in review · 0 of 1") · how long it's been going, or when it finished. (Whose agent
  it is, "bob's Codex", isn't in anything the dashboard reads: `claim.by` names the agent, not its person. Phase 2.)
- a slim **bar** on the panel's shared time axis (see Time axis): building solid, in review dashed, landing amber,
  a red tick per rejection, a green tick per approval, ✓ at a landing, × at a release

Sections: **In flight** (newest arrival first) and **Finished** (newest finish first). Finished goals fold into one
summary line ("✓ 2 landed · 1 dropped", with their titles) until it's opened.

Clicking a row opens its **steps** inline: each step's time and what happened, with reviewers' evidence from their
votes, a link to the change, and, when a person is needed, a link straight to its vote. Clicking again closes it.
Hover shows the title in full; nothing is hover-only.

### Timeline mode

A **Story / Timeline** switch in the panel's corner, remembered per browser (`localStorage`). Timeline is the same
rows in the same order, morphed, not redrawn: the words column narrows from about 56% to 24%, the second line folds
away, rows shrink to one line, and the bars take the room. In Timeline:
- every step gets a tick (pushes and votes too), and hovering a tick shows that step
- finished goals are unfolded and dimmed, since seeing the whole stretch is the point
- the status reads from the bar's end: blinking amber landing, ✓ landed, × dropped

An open row stays open across the switch.

### Before the first goal

With no goal at all, the panel shows a faint sample row (what a goal will look like) and a line on what each row
will show, linking to connecting an agent, instead of an empty clock ticking along. The range and view controls
fade out with nothing to act on. When the first goal arrives, the sample folds away and the goals fold in.

### Time axis

Shared by every bar in both modes.
- **It slides; it never zooms to fit.** "Now" is pinned to the right edge and the scale is fixed, so a length always
  means the same duration and bars drift left slowly.
- **Ranges: 15 min, 30 min, 1 h, 6 h, 24 h.** On opening, the panel picks the smallest that holds every in-flight goal's start
  (at most 24 h); after that it changes only when the person picks one.
- **Older starts are clipped** at the left edge with a marker: "← started 1 h 20 m ago".
- **Quiet gaps fold.** A stretch with no goal in flight that is longer than a quarter of the range is drawn as a
  break ("⋯ 3 h quiet ⋯"), so the last burst of work sits next to now.

## Motion

Only what happens while the page is open moves. On load everything is drawn settled.

| Event | Goal row | Hive | Strip |
|---|---|---|---|
| Goal announced | slides in at the top of In flight, rows below ease down | chip pops onto its cells | Building bumps |
| Push | a tick on the bar (Timeline); nothing else | — | — |
| Approved | green tick pops, status updates | cell gets its green edge | — |
| Changes asked | red tick, the row pulses red once | cell flashes red | back to Building |
| Checking to land | the bar's end turns amber and blinks | amber lamp | Landing bumps |
| Landed | ✓ pops, the row glows green; moves to Finished after 60 s, or later while hovered | cell turns landed-lately | Landed bumps |
| Needs a person | red border until someone acts | — | the needs-you line appears |

- **What changed** is found by comparing the newly read state with the last one drawn (the live socket only says
  "something changed").
- **Bursts ripple:** changes from one read play about 80 ms apart, oldest first; past ten, the rest just appear.
- **Coming back to a hidden tab** plays nothing; rows that changed while it was hidden get a dot until hovered or
  opened.
- **Nothing changes abruptly.** A row's steps slide open and fold shut, each line arriving just after the one
  above. A row the filter or the range leaves out folds away instead of vanishing; rows that change place (a goal
  arriving, one moving down to Finished) glide there. Bars and the clock's labels glide when the range changes.
  Map cells glide when a comb rearranges, new ones grow in, gone ones shrink away, and combs ease to their new
  height. The needs-you line slides open and shut. Each row has a disclosure chevron that turns when it opens.
- **`prefers-reduced-motion`:** colors change, nothing pops or slides.
- An `aria-live="polite"` region announces landings and requests for a person, at most one announcement every few
  seconds.

## Linking

Hovering a goal row lights its cells on the hive; hovering a cell lights its goal rows. Clicking an agent's chip
anywhere filters both the goals and the hive to that agent; a chip in the panel's header shows the filter and clears
it.

## Data

A new pure module, `web/src/lib/goals.ts`, turns what the tab already loads into goals:

```ts
interface Goal {
	change: string;
	agent: string;           // resolved even after the claim is gone (see below)
	title: string;           // short title, as above
	intent: string;
	paths: string[];         // the claim's; once it's gone, what the tab remembers seeing (see below)
	state: "building" | "in-review" | "revising" | "approved" | "landing" | "asking" | "landed" | "released";
	announced: string;       // claim.since, or the claimed event's time
	finished?: string;
	head?: string | null;    // in force only, with approval and attention
	steps: GoalStep[];       // oldest first
	earlierSteps: boolean;   // true when the goal started before the oldest event we have
}
interface GoalStep {
	at: string;
	kind: "claimed" | "widened" | "pushed" | "approved" | "changes-asked" | "asked" | "merging" | "checking"
		| "landed" | "failed" | "released" | "heads-up" | "interface" | "conflicted";
	by?: string;
	commit?: string;
	role?: string;           // a vote's
	text?: string;           // a vote's evidence, a failure's reason, a question for a person
	other?: string;          // the other agent an awareness event names
}
```

A batch that fails sends its change back to its agent, so a failed landing is a step, and the goal is `revising`
("checks failed, fixing") until its next push.

Sources: the snapshot's claims and votes (with evidence), the events log (`GET /repos/:repo/events`, the newest
100), and the landing (`checking`, `recent` with failure reasons). Names after the claim is gone come from those too:
a change's agent from its `claimed` event or its landing outcome, a vote's change from the commit a `pushed` event or
landing outcome names. Steps older than the events log keeps are left out, and the row's steps say "Earlier steps:
open the change". Nothing the server sends says what a landed change touched once its claim is gone, so the tab
remembers the paths of every claim it has seen while open; a change that landed before the page opened lights no
cells (Phase 2 fixes this).

Pure helpers beside it: the time axis (range choice, positions, clipping, gap folding) in `lib/timeAxis.ts`, and the
motion diff (which goals and cells changed between two states, and how) in `lib/hiveMotion.ts`.

## Seeing it locally: the playground

`npm run dev:web` already serves the dashboard locally, with the API proxied to a deployed Worker. Agents working
against a real GitHive need that deployment and its credentials (`.dev.vars`, not on this machine), so for building
and iterating we use a simulator instead:

- **`web/playground.html`** and **`web/src/playground/`**: a page Vite serves in development only (the build's input
  stays `index.html`). Open `http://localhost:5173/playground.html`. No backend, no sign-in.
- **`web/src/playground/sim.ts`**: a seeded, deterministic simulator. It plays agents from several owners that
  arrive, claim (and sometimes get refused and pick other work), push, review each other with evidence, fix after a
  rejection, ask a person, land in batches (and occasionally fail), and release. It runs on a virtual clock and
  emits exactly the API's shapes (`RepoSnapshot`, `RepoLanding`, `HiveEvent[]`, `RepoTree`) plus `now` and a
  backlog, which it feeds to the real `Hive` component. What the playground shows is what ships.
- **Controls:** play / pause, speed (1×, 5×, 20×, 60×), step to the next event, reset, seed, scenario, and "a person
  votes" for goals that need one.
- **Scenarios:** *mixed hive* (8 agents, 3 owners, features, fixes and a refactor, one rejection, one request for a
  person, one release), *swarm* (20 agents on `test/` files, the shape of the Express run), *quiet then a burst*
  (gap folding), *first agent* (empty hive), *big repo* (about 2,000 files).
- The simulator's states double as fixtures for the tests.

Once it looks right in the playground, a final check against real agents: `GITHIVE_API=<deployment> npm run dev:web`
with scripted agents (`scripts/swarm.mjs` or `scripts/seed-demo.mjs`, no model calls) running against the same
deployment. That needs the deployment's credentials in `.dev.vars`.

## Phases

**Phase 1 (this spec): the new tab on today's data, and the playground.** Client only. Everything above, with the
strip's *Up next* and the hive's dashed cells shown only when backlog data is present (the playground provides it;
production doesn't yet).

**Phase 2 (each its own small spec, later): server data.**
- Claims carry a short `title` (a backlog item's title, or one the agent gives), and optionally a `kind`
  (feature, fix, refactor, test, deps) for tags on the rows.
- `GET /repos/:repo/backlog`, for *Up next* and the hive's dashed cells.
- Every event names its agent and its change, so the client needn't resolve them.
- A goals endpoint: in-flight and recently finished goals with all their steps and paths from the records, so long
  goals aren't cut short by the 100-event log and landed ones still light their cells after a reload.
- Whose agent each is (the person behind it), for "bob's Codex" on the rows.

**Not in either:** a roster panel (the agent filter covers "what is agent-7 doing"), coordination moments
(refused claims aren't recorded as events), and a recap / replay scrubber. Each can come back as its own spec.

## Testing

- `lib/goals.ts`: states from claims, votes and landing; steps in order; names resolved after a claim is gone; short
  titles from long intents; `earlierSteps`.
- `lib/timeAxis.ts`: range choice, positions, clipping markers, gap folding.
- `lib/hiveMotion.ts`: which animations a change between two states produces; burst ordering and the cap.
- `playground/sim.ts`: the same seed gives the same events; every scenario reaches its end without a goal stuck in
  an impossible state.
- Components (`renderToStaticMarkup`, as the existing tests do): the stage strip's counts, Story and Timeline markup,
  folded and open Finished sections, the needs-you line, the hive's state classes. The existing `HiveTab`,
  `HiveMap` and feed tests are rewritten to the new markup.
- `npm test` and `npm run typecheck` pass. The playground is checked by eye in the browser.
