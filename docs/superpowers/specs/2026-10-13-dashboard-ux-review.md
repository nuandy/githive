# Dashboard UX review

**Date:** 2026-10-13 · **Branch:** `dev` at `6300d75` · Feeds the visual refresh the theme-system pass deferred.

How it was reviewed: a fresh capture of every scene (`npm run visual -- ux-review`, light and dark, 1280 and 390),
the dashboard on fixtures (`dev:web:fixtures`) driven by Playwright for keyboard, focus, titles and target sizes,
axe-core on 19 routes in both schemes, contrast computed from `theme.css`, and a read of the code. Four areas: the
chrome, the workflows inside a repo, setup and settings, and the design system and accessibility. Items marked
**(verified)** were reproduced in the running app or confirmed line by line; the rest cite the code and screenshots
they come from.

## The short version

1. **Status has no single source.** The same change is "Approved" with a Merge button on its page while the Hive says
   "checks failed, fixing" and the page itself shows a conflict. "Needs you" counts 2 in the Inbox, 3 on Changes and 5
   in the Hive banner. One state has up to four names, and amber means three different things.
2. **The human's main job, deciding on a change, is underserved.** There is no diff anywhere, the vote starts on
   Approve, Merge lands other people's changes on one unconfirmed click, and "Needs you" can point at a form that
   isn't there.
3. **The accessibility floor has holes.** The skip link opens "Page not found", focus is invisible on several controls,
   dark mode's solid status fills fail contrast (2.58:1 on the Merge button), links in prose are colour-only, and the
   Hive map's text is 7.5–9px.
4. **Setup is a scavenger hunt.** Nothing leads from "repo made" to "agent connected" to "first claim". Settings is
   one 4,144px page with five save models, and one click makes a private repo public.
5. **The chrome breaks when narrow.** Breadcrumbs overprint, the repo tabs hide the current tab, and the repo header
   takes about 260px before any content at 390px.

What's working and should stay: the theme architecture and motion rules; reduced motion honoured in CSS and JS;
History's traceability (reviewers and evidence inline); the Awareness panel; the Conflict panel's real conflicting
lines; the Hive's throttled screen-reader announcer and cells that carry text plus border style; inline confirms
instead of `window.confirm`; typed-name delete; Repositories grouped by what needs you; sign-in that returns you to
where you were.

---

## 1. Fix now: bugs with small diffs

| # | What | Where | |
| --- | --- | --- | --- |
| 1.1 | "Skip to content" goes to `#main`, which the hash router reads as a route: keyboard users land on **Page not found**. Its `shadow-raised` also bleeds a grey smudge into the top-left of every page. | `components/Page.tsx:14-23` | verified |
| 1.2 | Breadcrumbs overprint ("Repositoacm…") at 390 on every repo page, and on long change titles at 1280. Non-last crumbs have `min-w-0` and shrink under their text. | `components/TopBar.tsx:156-170` | verified |
| 1.3 | A change with failed checks and a conflict shows **Approved** and **Merge**. `claimStatus` tests `approval.approved` before rejections on the head; `goals.stateOf` tests them first; `mergeable` ignores conflicts and failed checks. | `lib/claimStatus.ts:34`, `lib/goals.ts:373`, `ChangePage.tsx:450` | verified |
| 1.4 | The vote form starts on **Approve**. | `VoteForm.tsx:41` | verified |
| 1.5 | "Make it [Public]" flips visibility on one click, no confirm, on a button that reads like a badge. | `RepoAdmin.tsx:235-249` | verified |
| 1.6 | White text on dark-mode solid fills: Merge/Approved 2.58:1, warn badge 1.89:1, inbox count 3.43:1. | `badge.tsx:33-38`, `button.tsx:25,27`, `TopBar.tsx:129` | verified |
| 1.7 | The repo `h1`'s accessible name includes the "Sharded votes" badge's sr-only paragraph, so screen readers hear storage internals as the page heading. | `RepoHeader.tsx` | verified |
| 1.8 | Segmented control's focus ring is clipped by `overflow-hidden`; a focused "Story" shows nothing. | `ui/segmented.tsx:26` | |
| 1.9 | `ConfirmButton` unmounts its trigger, so focus drops to `<body>`; Escape doesn't cancel. | `Confirm.tsx` | |
| 1.10 | A failed audit shows "Replaying the records from Git…" forever; audit and access errors never reach `PageErrors`. History's error has no reason or retry. | `RepoTabs.tsx:328`, `App.tsx:226`, `History.tsx:37` | |
| 1.11 | "Needs you" on a change with nothing pushed says "Decide with your vote below", but `VoteForm` returns null without a head. Visitors are told "asks you… your decision" too. | `ChangePage.tsx:217,317`, `VoteForm.tsx:51` | |
| 1.12 | New repository defaults to **Import**; typing only a name leaves submit grey with no reason. | `NewRepoPage.tsx:84,101` | verified |
| 1.13 | Daily owner limit saves 5 before a number is typed; Enter does nothing; nothing says "Saved". | `AgentLimitsPanel.tsx:84-113` | |
| 1.14 | `CopyBlock`'s `aria-label` reads 40 characters of the secret token aloud and hides "Copied". Making a second token silently replaces the first before it's copied. | `CopyBlock.tsx:39`, `AgentsPage.tsx:62` | |
| 1.15 | Theme leaks: `text-[#b86e00]` (3.33:1), `#e59a0b` in `HiveMark`, `[border:2px_groove_ThreeDFace]` on the GitHub fieldset, `[font-family:monospace]` on sign-in, native radios and checkboxes in system blue (no `accent-color`). | `ChangePage.tsx:402`, `HiveMark.tsx:18`, `GitHubSettings.tsx:100`, `SignIn.tsx` | |
| 1.16 | Every repo tab has the same window title; not-found keeps "GitHive" and has no `h1`; the change page has two `h1`s. | `App.tsx:403`, `RepoHeader.tsx:70`, `ChangePage.tsx:509` | verified |

## 2. One status, one "needs you"

The root of the most confusing moments. Today state is derived in `claimStatus.ts`, `goals.ts` (`stateOf`,
`STAGE_OF`), `Territory`'s `lampOf`, and hand-copied tone maps (`ChangePage.tsx:251`, `Timeline.tsx:175`,
`GoalsPanel.tsx:46`).

- **P0. Contradictions.** See 1.3. `session-cookies` is "Changes requested" and "Blocked by security" in the list,
  "needs a person" in Territory, "changes asked, revising" in the Hive, and "REVISING" on its cell whose accessible
  name says "changes asked" (axe flagged 146 such label/name mismatches).
- **P1. Colour means different things.** Amber is "in review" on Changes and Territory but "landing" on the Hive;
  "in review" is slate on the Hive. `--needs` and `--bad` are 1.14:1 apart in light and identical in dark. Territory's
  "needs a person" and "approved" squares differ only by red against green (1.08:1 luminance, the same under
  deuteranopia).
- **P1. "Merge" and "land"** both name the same act. History, the Hive and the README say land.
- **P1. "Needs you" isn't one list.** The Inbox reads only `summary.waiting` (`lib/inbox.ts`); the Hive banner adds role
  votes only a person holds, failed checks, and audit flags.
- **P1. The stage strip isn't the key it claims to be.** `STAGE_OF` folds revising into building, asking into review and
  approved into landing (`goals.ts:425`), so "0 in review" sits over a map with red and green cells and no key for
  either.

**Recommendation.** A `lib/status.ts` registry of about seven states, each with one noun, a short label, a tone, an
icon and a pattern, which `StatusPill`, `Badge`, `Lamp`, the hex cells, Territory, the stage strip and every legend
read. Derive state once (rejections on the head before approval). Define "needs you" once, server-side, and feed the
top-bar count, the Inbox, the Repositories line and the Hive banner from it. Give "waits on a person" its own hue or
alias it to `bad` outright, and give every lamp a glyph (✓, !, …) so colour never carries meaning alone. Use "land"
everywhere.

## 3. Deciding on a change

- **P0. No code.** The change page has Conversation and Commits; commit hashes open the code browser at that commit,
  not a diff. The theme's `diff-*` tokens are unused. The vote form asks "What you checked". **Add a Files tab**:
  unified diff from the merge base to `claim.head`, a fold per file, a flag on files outside the claim, linked from
  Awareness and the Conflict panel. (verified)
- **P1. The decision is scattered.** Status pill and Merge in the header; the approvals box at the very bottom under the
  vote form; the sidebar's "Reviewers" shows raw words ("working", "approve") and not who voted for each required
  role; checks aren't shown at all (`MergeChecks` is only in Settings). **One decision box**, near the top or sticky in
  the sidebar: approvals per role and who gave them, the latest check with its log, conflict with main, the
  Awareness count, one primary action.
- **P1. The vote form.** No verdict preselected. Approve / Request changes / Block (as security), each with its
  consequence. Offer only roles the person holds; fix "review reviewer" (the role name plus "reviewer"). When the
  agent asked a question, label the field "Your answer to mara/claude". Say why submit is disabled. After voting,
  collapse to "You approved 4e6df04 · Change".
- **P1. Merge.** Fires on one click and lands the branch's other ready changes with it (`ChangePage.tsx:45,133-165`).
  Rename "Land now", put it in the decision box, confirm with what goes with it: "Land checkout-tax now? It lands
  with footer-links and product-reviews after `npm test`."
- **P1. People can't free a stuck change.** "Give up" exists only for GitHub's changes. Add "Release claim" with a
  reason, for write access and above.
- **P2. Internals in prime spots.** "Sharded votes" as the repo header's badge (move to Settings or Audit),
  "person e5c1b970" hashes instead of handles, and the agent's git commands in the Conflict panel unfolded (fold
  them under "What the agent will do"). Claim paths break mid-extension ("CartDrawer.ts / x"); truncate in the middle.

## 4. The Hive, Changes, Inbox and the other tabs

- **P0. Hive map text is unreadable.** Labels 9px and 7.5px (`HiveMap.tsx:117-118`), about 6px once scaled at 390;
  "LANDING" on its fill is 1.88:1, folder names at `opacity-80` 2.83:1. Names truncate at the end ("OrderSumm…").
  Nothing under 10px, the file name only, state carried by fill and edge, middle truncation, chips kept inside their
  cell, `--warn` for status words.
- **P1. Goal rows cut the part that matters.** Titles stop at about 45 characters at 1280 and 20 at 390 while the
  Story bar column (often 1–3px ticks) takes 30% of the row. Cap the bar near 120px in Story, allow two lines, keep the
  distinguishing part of the title.
- **P1. Three clicks from a cell to its change**, and expanded building rows say "Answer it on its page →"
  (`GoalsPanel.tsx:822,865`). Make titles links; keep the chevron as the toggle.
- **P1. The "Needs a person" banner is a paragraph** of dot-separated links. Rows with a kind icon, an age and a verb;
  three, then "+2 more in Inbox".
- **P1. Live reordering moves rows while you read.** Pause FLIP while the pointer or focus is in the panel or a row is
  open; show "2 new" instead. Cap `goal-blink`, `hive-cell-blink` and `live-pulse` at three runs (WCAG 2.2.2); bring
  `bump` from 1.6× to about 1.15×.
- **P1. The Hive map is about 30 tab stops.** One stop, arrow keys between cells.
- **P1. Changes buries its list.** Territory (about 600px) pushes "12 Open" to y≈880 at 1280 and y≈2,500 at 390, and
  repeats the Claims tab. Move Territory to Claims; list first; filter chips ("Needs you 2 · In review · Approved ·
  Building"); sort what needs action first; label "4m" as "active 4m ago"; make "21 merged on main" link to History.
  The tab count (13, all branches) disagrees with "12 Open".
- **P1. Three maps of who holds what, in three colour schemes.** Claims cycles 8 colours over 13 changes, so two
  blues and two pinks collide. One map coloured by state, the holder named on each claimed row, "Only claimed" on by
  default, rows linking to their change.
- **P1. The Inbox is thin.** No age, no kind, no verb, and questions at 12.5px muted, about 170 characters a line.
  Rows: kind icon, "mara/claude asks · 38m", the question at body size in ink, a verb button that lands on a `#decide`
  anchor.
- **P1. Audit is a dead end.** Hashes aren't links, rule ids are raw ("outside-claim"), reviews name a commit, not a
  change, and nothing says what to do about a violation.
- **P2. Code and History.** No syntax highlighting, README shown as source, no "last changed by" or claim banner on a
  file, "main" isn't a branch switcher, History's "2 files" can't be opened, nothing groups a batch.

## 5. Chrome and navigation

- **P0. Narrow tabs.** At 390 the tabs scroll with a hidden scrollbar and nothing scrolls the current one into view; on
  Settings or Audit no tab looks current and "Audit 2" is never seen (`Tabs.tsx:50`). `scrollIntoView` the
  `aria-current` tab plus an edge fade, or tabs past the fourth in a "More ▾" menu.
- **P1. The Inbox doesn't lead.** It's the same outline pill as Agents, with a warning triangle that reads as "error",
  and icon-only at 390 next to the theme toggle. An inbox icon, a `needs-soft` fill when non-zero, "(2)" in every
  window title, the theme choice moved into the user menu on narrow screens.
- **P1. "Agents" is two pages.** The top bar's (your agents and tokens) and the repo tab's (agents at work there).
  Rename the top-bar one "Your agents"; drop its duplicate in the user menu.
- **P1. Repositories and organizations aren't destinations.** Home is the logo or the breadcrumb; orgs live in the
  user menu with the repo icon; "acme" in "acme/storefront" isn't a link; there's no repo switcher.
- **P1. Focus and scroll on navigation.** Nothing is focused or announced on a route change (the clicked link unmounts,
  focus falls to `<body>`), and `scrollTo(0,0)` runs on Back too (`App.tsx:64`), so Back to the Changes list starts at
  the top. Focus the `h1` on a place change; restore scroll per history entry.
- **P1. Session and permission states.** An expired session drops to sign-in with no "your session ended"; on a public
  repo it silently turns into the visitor view and loses a half-typed vote. A private link signed out shows a bare
  sign-in card. Say so on the card; keep vote and form drafts in `sessionStorage`.
- **P1. Repo header at 390** wraps to four lines. Name, a Public/Private badge (shown nowhere today) and the Live dot
  on one row; site, GitHub and records in a ⋯ menu.
- **P2. Page frames vary.** Titles at three sizes, widths of 820, 900 and 1132px, headings jump h1 → h3 on Audit, and
  the repo header sits outside every landmark (axe "region" on 24 of 38 runs). One `PageHeader`, one `h1`, one width
  rule, the repo header inside `<main>`. Keep the repo tabs sticky under the top bar.
- **P2. Views can't be linked.** Hive window, Story/Timeline, agent filter, expanded row and repo search are local
  state. Put them in the hash query. Add `theme-color` per scheme.
- **P2. Keyboard shortcuts.** `g i`, `g r`, `/`, `1–8` for tabs, ⌘K to jump to a repo or change, `?` for help. Hash
  routes make these cheap.

## 6. Getting started, settings and admin

- **P0. No path from a repo to a working agent.** The empty Repositories page never mentions agents; an empty Hive
  says "Connect an agent from the Agents page" as plain text; the connect steps stop at signing in and never say what
  to ask the agent; nothing confirms a connection (connections refresh every 60s). A self-ticking "Get started" box on
  Repositories (make a repo → connect an agent → give it a task → see it land), the MCP command and a ready-made
  prompt naming the repo inline on an empty Hive, "Waiting for the first claim…", and a quick poll after Copy that
  says "Claude Code connected as robin/builder ✓".
- **P1. Settings: one 4,144px page, five save models.** One "Save settings" under three peer sections, two full-width
  green save bars, instant-apply role and visibility changes, inline-confirm removes, typed-name delete, and no
  unsaved-changes guard (`dirty` is tracked in `MergeSettings.tsx:117` but unused for that). Sub-navigation (General
  & access · Review · Path rules · Branch rules · Checks · GitHub · Danger zone), one right-aligned save bar per
  section, a dot on sections with unsaved edits, a guard on leaving. `go` green is for land and approve, not save.
- **P1. The review policy is a mini-language.** Comma-separated roles, `person:*`, `@org/team`, `githive` in free text;
  errors only in the save bar. Token inputs with typeahead from teams, collaborators and agents, presets, errors under
  their field, and `MergePolicyTerms` rendered live from the draft as "What this means" (today it's hidden from
  editors, `RepoTabs.tsx:470`).
- **P1. GitHub disconnects by emptying a field.** Show the connection read-only with Change… and a confirmed
  Disconnect; the sync modes as radio cards.
- **P1. The Agents page.** "Revoke" means both the agent and a token, side by side; the expiry select reads as the
  agent's; "Active" means not revoked; nothing says where an agent is working; connected apps repeat the agents;
  dates mix "8/16/2026" and "2026-11-22". A live lamp and "Working in acme/storefront · 1 claim · 7 min ago" per
  agent, its client and Disconnect inside its card, tokens under a disclosure, "Revoke agent" in a ⋯ menu.
- **P1. Forms.** Server errors are raw and far from their field ("robin/widgets exists already" at the form's foot);
  validation fires mid-word ("acme-" → "can't end with a dash"); the bad character isn't named; a demo-run 409 leaves
  a dead button though the card has a Watch state. Errors in the field's hint with `aria-invalid`, sentence case in
  `messageOf`, trailing-dash and length checks on blur. Only three fields link hints with `aria-describedby`; save
  notices lack `role="status"`.
- **P1. Confirms.** Focus the safe button, Escape cancels, focus returns to the trigger. The dismiss label says what it
  keeps ("Keep invitation", not "Cancel" beside "Yes, cancel invitation"). Every question names its consequence, as
  the team-delete one does. "Undo" where it's reversible. An AlertDialog for delete repository.
- **P1. Role changes apply instantly,** making someone Owner included, with Read/Review/Write/Admin never explained
  (`LEVEL_WORDS` already has the words). Confirm promotions; show the words as a hint; say "Saved".
- **P1. Sign-in for people without a code.** Say "No code? Continue anyway and we'll ask an admin to let you in." After
  a request, show the account recorded and how they'll hear, and offer "Watch a hive build a game" (the public demo
  repo renders signed out). Push a history entry for the sign-in screen.
- **P2.** The demo card sits above "Needs you" for good (prominent only when empty, otherwise one dismissible line);
  placeholders stand in for labels; add-forms sit above, below or in the header depending on the page; org invites
  awaiting GitHive approval look like the rest; member rows at 390 wrap raggedly; the Claude Code command breaks
  mid-flag.

## 7. Design system and accessibility

Contrast failures and near-misses (WCAG 2.2: 4.5:1 text, 3:1 large text and UI):

```
TEXT                                          light   dark    where
white on --good (solid pill, Merge)            5.00   2.58    badge, button go, ChangePage:251, Timeline:175
white on --warn (solid badge)                  5.89   1.89    badge.tsx:35
white on --bad/--needs (inbox count)           5.41   3.43    TopBar.tsx:129
--good on --good-soft ("Approved", "Active")   4.22   5.46    Badge sm at 11.5px
--bad on --bad-soft (Needs banner)             4.43   4.46    HiveStrip.tsx:163
placeholder (preflight 50%)                    3.00   4.36    every Input/Textarea
muted at opacity-70 / -75 (revoked, resolved)  3.04/3.34      AgentRow:68, RepoTabs:272
amber "3 landing"                              2.16   9.32    HiveStrip.tsx:26
Hive "LANDING" on its fill, 7.5px              1.88   6.49    HiveMap.tsx:86
link vs surrounding text (no underline)        1.38   1.25    theme.css:449
NON-TEXT
--input / --border-strong vs card              1.81   1.86    every field, default Button
focus halo (ring at 35%)                       1.80   2.22    button, field, segmented, ThemeMenu
menu item highlight vs popover                 1.11   1.09    dropdown-menu.tsx:41
Segmented pressed vs card                      1.21   1.23    segmented.tsx:38
```

- **P0. On-colour tokens.** `--good-foreground`, `--bad-foreground`, `--warn-foreground` and `--needs-foreground`:
  `#fff` in light, `#121a1f` in dark (6.81, 5.13, 9.32, 5.13:1).
- **P0. Status text on tints.** Light `--good: #276b4e`, light `--bad: #b03426`, dark `--bad`/`--needs: #ef7563`.
- **P0. One focus ring.** Today there are three styles (base outline, Tabs inset outline, border plus a 1.8:1 halo),
  and menus show focus only by a 1.1:1 background. Use `outline-2 outline-offset-2 outline-ring` everywhere (7.9:1 /
  9.0:1); menu items `data-highlighted:bg-link-soft data-highlighted:text-link`.
- **P0. Links in prose underline** (`decoration-link/40 underline-offset-2`); the bare style stays for nav and lists.
- **P0. Dimmed content keeps full contrast.** A "Revoked" or "Resolved" badge instead of opacity;
  `placeholder:text-muted-foreground`.
- **P1. Field and button edges at 3:1.** Light `--input: #87918d`, dark `--input: #66777f`; `border-input` on every
  control.
- **P1. Type scale: 13 steps to 8.** Usage is 57/36/29/25 for ui/body-sm/meta/caption and 1–5 for micro, title-sm,
  title-lg, display-sm and display; the half-pixel steps are about 4% apart; 18 arbitrary `text-[…]` with 12 values.
  Proposed: 11 (counts only), 12, 13, 14, 15, 17, 20, 26, with a 12px floor for prose (Overpass's x-height is small).
  Prose at `max-w-[70ch]`: intents and reviews run about 110 characters a line today.
- **P1. Missing primitives.** 50 `title=` attributes that keyboard and touch can't reach (truncated goals, LiveDot,
  map cells, the colour-only "changed while you were away" dot). Add Tooltip, Popover (map and Territory cells on
  tap), AlertDialog (delete, revoke, remove) and Dialog (new token).
- **P1. One set of status components.** `Lamp` (amber/green/red) and `Badge` (good/bad/warn/needs/accent) speak two
  vocabularies; pills, dots and counters are rebuilt in TopBar, LiveDot, `RepoPage.tsx:312`, `GoalsPanel.tsx:194`;
  AgentsConnect is a second segmented control. Collapse into `StatusBadge` and `Lamp` keyed by the registry in §2; a
  Button `variant="pill"`; AgentsConnect on `Segmented`.
- **P1. Touch targets at 390.** Top-bar pills 25–30px, `Button sm` 28px, Segmented 24px, link buttons and code crumbs
  20px, checkboxes 13px. `pointer-coarse:min-h-11` on small buttons, Segmented and pills, or an `after:-inset-2` hit
  area.
- **P1. Live regions.** Changes and Inbox update silently; reuse the Hive's throttled announcer.
- **P2. Token hygiene.** 255 arbitrary values; 15 quarter-step spacings (3px ×32, 15px ×22); `--muted`, `--secondary`,
  `--accent` and `--surface-2` share one hex, so hover is invisible on muted surfaces (make `--accent` surface-3);
  icons in 7 sizes (settle on 14, 16, 28); `h2` from 12 to 20px (a 16px semibold `BoxTitle`).

## Order of work

1. **Bugs (§1).** Each is a small diff with a visual-check scene to add. A day or two.
2. **Status registry and one "needs you" (§2).** Unblocks the Inbox, the banner, the legends and the colour fixes, and
   removes the contradictions for good.
3. **The decision flow (§3).** Files tab, decision box, vote form, "Land now" with its confirm, release claim.
4. **Inbox and chrome (§4 Inbox, §5).** The Inbox as the to-do list, narrow tabs, nav, focus and scroll.
5. **Getting started and settings (§6).** The checklist, then settings sub-navigation and the policy editor.
6. **The refresh (§7).** Focus ring, on-colour tokens, input edges, type scale, touch targets, Hive legibility, the new
   primitives. Capture a baseline first; this one is meant to change pixels.
