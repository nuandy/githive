# The dashboard's look: theme, components, motion

How `web/` is styled, for anyone changing a screen. The design behind it is in
`docs/superpowers/specs/2026-10-13-ui-theme-system-design.md`.

## Where things are

| What | Where |
| --- | --- |
| Every design value (colors, radius, type, shadows, motion), light and dark | `web/src/theme.css` |
| Shared components (Button, Badge, Box, Callout, Empty, fields, Collapse, DropdownMenu, Tooltip, Dialog, …) | `web/src/components/ui/` |
| The frame every page sits in (`Shell`, `Main`, `Page`, `PageHeader`, `EmptyPage`) | `web/src/components/Page.tsx` |
| Routes, and views kept in the address (`readQuery`, `withQuery`) | `web/src/lib/routes.ts` |
| Focus and scroll as the route changes (`useHashRoute`, `replaceHash`) | `web/src/hooks/useHashRoute.ts`, `lib/scrollMemory.ts` |
| The keyboard's shortcuts, the ⌘K palette and their list | `lib/shortcuts.ts`, `lib/palette.ts`, `components/Keyboard.tsx` |
| Joining class names | `cn()` in `web/src/lib/utils.ts` |
| Light, dark and the reader's choice | `web/src/lib/theme.ts`, `ThemeMenu.tsx` |
| Motion hooks (`useLingering`, `useChanged`, `useArrivals`, …) and `useAnnouncer` | `web/src/hooks/` |
| Whether JavaScript motion should move (`reducedMotion`, `motionMs`) | `web/src/lib/motion.ts` |
| The visual regression check | `web/visual/` |

Screens are written in Tailwind CSS v4 utilities. There are no per-component stylesheets: a component's look is in its
markup, drawn from the theme.

## The theme

**Colors** carry meaning, and only the theme's exist (Tailwind's stock palette is switched off):

- Paper and ink: `background`, `foreground`, `card`, `popover`, `muted` / `muted-foreground`, `secondary`, `accent`
  (the surface under a hovered or highlighted item: `surface-3`, a step under the muted surfaces, so it shows on them
  too), `surface-2`, `surface-3`, `border`, `border-strong`, `input` (a control's edge: every field, button, segmented
  control and top-bar pill is `border-input`).
- Actions: `primary` (the ink fill of a primary action), `link` and `link-soft` (links, focus, "in progress"), `ring`.
- The lamps, always the same meaning: `amber` only for what's being checked to land, `good` (approved, passed,
  landed), `bad` (failed, sent back, or needing a person), `needs` (what asks the reader: a question's callout, the
  Inbox), plus `warn` (amber dark enough for text, and warnings) and `neutral`. Each has a `-soft` background. Text on a
  solid `good`, `bad`, `warn` or `needs` fill is that color's `-foreground` (`bg-good text-good-foreground`), never
  `text-white`: dark mode's lamps are bright, and take dark text.
- The Hive's stages, `stage-building`, `stage-review`, `stage-landing`, `stage-landed` and `stage-asking`, name the
  lamps a change's state takes (below).
- Diffs (`diff-add`, `diff-del` and their `-strong`), the mark (`mark-tile`, `mark-line`, `mark-dot`), and the agents'
  hues (`hue-0` … `hue-7`): an agent's chip on the Hive is ringed in a stable hue of its own, one no lamp uses
  (`agentHue` in `lib/hiveCells.ts`), so two agents in a cell are told apart by more than their letters.
- Code's syntax colors, in the Code tab (`code-keyword`, `code-string`, `code-literal`, `code-comment`, `code-title`,
  `code-type`, `code-attr`): `lib/highlight.ts` maps highlight.js's scopes onto them.

Use them as `bg-card`, `text-muted-foreground`, `border-border-strong`, `bg-bad/45`. In SVG or inline styles use the
variable: `fill="var(--good)"`.

**Contrast** is measured, in light and dark, by `web/src/lib/theme.test.ts` (it reads `theme.css`): text at 4.5:1
(a lamp's color on its `-soft`, on `surface-2` and `surface-3`; muted text, placeholders among it; text on a solid
lamp; code's syntax colors on the card and `surface-2`), and what marks a control or focus at 3:1 (`input` and `border-strong` on the card and the page, `ring` on every
surface). A new color, or a new pair that sets text on a color, goes into that test. Content that's out of play
(a revoked agent, a resolved violation) says so in a badge at full contrast; it never fades with `opacity`. The amber
lamp, pale on light paper, carries a ring of `warn`.

**A change's state** has one noun, one color, one icon and one mark everywhere it shows: pills, lamps, the Hive's cells,
strip and goal rows, the Claims map's rows and every legend. They're one table, `STATES` in `web/src/lib/status.ts`, and
one derivation, `changeState()`; read them, never a tone map of your own. Color never says it alone (WCAG 1.4.1): each
mark has a glyph or a pattern too.

| State | Color | Mark |
| --- | --- | --- |
| Building | `link` (`stage-building`) | solid edge, tinted |
| In review | `link` (`stage-review`) | dashed edge |
| Needs a person | `bad` | filled, `!` |
| Changes requested, Checks failed | `bad` | soft, `×` |
| Approved | `good` | soft, `✓` |
| Landing (being checked to land) | `amber` (`stage-landing`) | tinted, `●` |
| Landed | `good` (`stage-landed`) | filled, `✓` |
| Released, Abandoned, free to take | `neutral` | a hollow ring |

Pills and headings use the noun ("Needs a person"); cells, goal rows and legends the same words in lowercase. A change
lands: "Land", "Landed on main"; "merge" is only git's own (a merge commit, a conflict with main). "Needs you" is only
for counts addressed to the reader: the Inbox's count, "2 changes need you". What needs you is agents' questions,
changes waiting on a vote only people may give, and the audit's open violations, never failed checks (the agent's own
work): `waitingOn()` in `status.ts` and `needsYou()` in `needsYou.ts` decide it, and the server's repo summaries count
the same for the Inbox and Repositories. A vote is people's alone when every holder of its role is people
(`person:*`) or one person, never a team, whose members' agents may vote as it; and it's read from the policy the
change is held to (`claimPolicy`: its branch's, or none for GitHub's trusted change), so pass the repo's `settings`,
never `snapshot.policy` alone.

**Light and dark.** `:root` is light and `.dark` on `<html>` is dark; `dark:` variants follow it. Under "Same as this
device" the page follows the system live. Another palette is another block of the same variables.

**Corners** are steps of one `--radius` (4px): `rounded-2xs` 1px, `xs` 2px, `sm` 3px, `md` 4px, `lg` 5px, `xl` 6px,
`2xl` 12px, `3xl` 14px, and `rounded-full`. Changing `--radius` rounds or squares the whole dashboard.

**Type** comes in eight sizes, named by role: `text-micro` 11px (counts only, and the Hive's small capitals until it's
redrawn), `caption` 12 (the smallest for words: Overpass's x-height is small), `meta` and `ui` 13, `ui-lg` and
`body-sm` 14, `body` 15, `lead` and `title-sm` 17, `title` and `title-lg` 20, `display-sm` and `display` 26. Roles that
share a size are told apart by weight, color or face. No `text-[…]` sizes, but in the Hive's marks (the map, the goals'
chips and clock) and a state's glyph on its lamp or mark, where type sits inside shapes of its own size, and never under
10px: the map's cells are drawn at their own size and never scaled down, and a name that doesn't fit is cut in the
middle so its end stays (`cellNames`). Long-form text (an intent, a review, an agent's
question, an Inbox reason) wraps at `max-w-measure`, 70ch. Fonts: `font-sans` (Overpass) and `font-mono` (Overpass
Mono).

**Narrow windows**: `to-480:`, `to-560:`, `to-640:`, `to-720:`, `to-900:`, `to-1100:` apply up to and including that
width (`to-560:hidden`).

## Components

Reach for `components/ui` before writing a control by hand:

- `Button`: `variant` default, `primary` (ink, and saving), `go` (green: land and approve, nothing else), `danger`,
  `ghost`, `link`; `size` default, `sm`, `icon`; `asChild` to give a link a button's look.
- `Badge` (a pill: `tone` good, bad, warn, needs, accent, neutral; `solid`, `outline`; `size="sm"` beside a row's
  title, `size="lg"`), `Counter`, `Lamp` (`state` lights it as a change's state, glyph and all). For a change, use
  `StatusPill` and `StatusIcon`; for a state's square or swatch, `StateMark`.
- `Box`, `BoxHeader`, `BoxTitle`, `BoxBody`, `BoxRow`: ruled sections, not cards (`asChild` rules a form). `BoxTitle`
  is a section's title at `title-sm`, semibold, an `h2` (or the heading it's given, `asChild`). `Callout` with a
  `tone`. `Empty`: nothing to show yet, an icon, an `h2` and a line or two, centered (`<Box asChild><Empty>` boxes it).
- `SaveBar`: a form's foot, sticky at the bottom of its section: what a save did (`status`, said politely) or why it
  failed and what's wrong with the form (`alert`, said at once; `saveBarSays` in `SettingsParts.tsx` gives both),
  then Discard and Save (`primary`, submits), both waiting while there's nothing to save (`canDiscard` lets Discard
  close an editor with nothing changed). A form's problems go under their fields too: `problemsFor` gives a field
  `aria-invalid` (a red edge), `aria-describedby` and the line to show. A form held for the session (`useHeldDraft`)
  shows what it saved until the repo is read again, and a part without edits follows the server's settings.
- `TokenInput`: a list chosen as chips, offering what matches as you type (a combobox); it only chooses strings, so
  a form saves what it would have had typed. Enter adds what's typed, or the option the arrow keys lit, or the one
  it names in full. `lib/tokens.ts` reads and writes a list's text and offers roles and who may vote as them.
- `Input`, `Textarea`, `NativeSelect`, `Label`; `Field` holds a label, its control and a `FieldHint` under them.
- `Collapse`: anything that opens and closes; `Fold` drops what it holds once folded, and unfolds it again as it comes
  back (a row a search leaves out, the fields for a choice). `DropdownMenu`: menus from a button; its items light up in
  `link-soft` and the link's color.
- Overlays, shadcn's on `radix-ui`: `Tooltip` (words in ink on hover or focus, in place of `title=`; give a trigger that
  isn't a control `tabIndex={0}`, and the app's one `TooltipProvider` lets one tooltip follow another at once),
  `Popover` (a panel opened by a click or a tap: what a tooltip says where there's no hover, or a few controls),
  `Dialog` (a window of its own over the dimmed page) and `AlertDialog` (a question to answer before going on: delete,
  revoke, remove; `AlertDialogAction` is `danger` unless told otherwise).
- Asking first: `ConfirmButton` (a destructive action asked in place, its No saying what it keeps: `keep="Keep
  invitation"`) and `Question` (the same question for something else, a promotion, say); every question names what
  it changes. What can be taken back says so instead, with `useUndo()` and `UndoLine`: Undo for ten seconds, where
  the row was. What changes at once (a role, a permission) says Saved by it (`useSavedNote`, `SAVED_NOTE`).
- Managing pages (`ui/manage.tsx`): a row's actions go under what it's about below 560px; a form that adds to a list
  sits at the list's end (`ADD_FORM`), its fields labelled (`INLINE_FIELDS`), never by a placeholder alone.
- `PageHeader`, `PageTitle`, `EmptyPage`, `Main`, `COLUMN`: the page frame (below).
- `Announcer` with `useAnnouncer()`: a page's polite live region, for what changes under a screen reader. `say(words)`
  speaks at most once every four seconds and drops what comes sooner; draw `<Announcer said={said} />` once.
- `Icon` comes in three sizes: 14 beside small text (13px and under), 16 (the default) beside body text and alone in a
  button, 28 over an empty state's heading.
- Native `<details>` take the `disclosure` class to unfold instead of jumping open.
- `Markdown` (`components/Markdown.tsx`, read by `lib/markdown.ts`): a Markdown file as formatted text, drawn as React
  elements. Raw HTML stays text, never markup, and a link goes only over http or https, or to a path in the repo
  (`linkTarget`); anything else shows as its words. No `dangerouslySetInnerHTML` anywhere.
- `useHighlighted` and `TokenLine` (`components/Highlighted.tsx`): code in its syntax colors. highlight.js's core and
  each language load only when a file in it shows (`lib/highlight.ts`); its spans are read back into tokens, never set
  as HTML.

## A change's page

- **The decision box** (`DecisionBox`, from `lib/decision.ts`) is where a change is decided: its state, approvals per
  role and who gave each, the latest check on its head, a conflict with its branch, how many open changes its code
  meets, and one primary action, Land now (confirmed first, naming what lands with it and the checks that run) or
  Vote. Its ⋯ menu releases the claim. It's sticky in the sidebar beside every tab at 900px and up, under the header
  below that, and it's `#decide` (focusable): `decide` brings it into view. Work its contents out in `lib/decision.ts`,
  as pure functions, not in the component.
- **The Files tab** (`ChangeFiles`) folds each file, its lines drawn only while open, in `diff-add` and `diff-del`
  (their `-strong` behind the line numbers), with git's hunk headers. `href.change(repo, id, "files", path)` opens one
  file; link a file of the change there, as Awareness and the Conflict panel do.
- A person shows as "you" or "a person", never as a `person:` hash; their agents by their `<handle>/<agent>` names.

To add a shadcn component, run from the repository root: `npx shadcn@latest add <name>` (`components.json` points it
at `web/src/components/ui`). Then point its `cn` import at `@/lib/utils` (ours knows the theme's names), swap
lucide icons for `Icon`, and restyle it from the theme.

## The page frame

- **One header, one heading.** A page opens with `PageHeader`: its title (the page's one `h1`, `text-display`), a
  line about it at `max-w-measure`, and its actions at the far end, wrapping under on a phone. A page with nothing but
  a message is an `EmptyPage` with a `title`, the same `h1` centered. A repo's pages are headed by `RepoHeader`, whose
  `h1` is the repo's name (a change's page has its own title instead).
- **One width.** Every page's column is `--page-width` wide at most (`COLUMN`), and no tab narrows it; long text keeps
  to `max-w-measure` instead.
- **Landmarks.** Everything under the top bar is in `<main id="main">` (`Main`; `Page` is `Main` as a column), a
  repo's header and tabs too, so the skip link reaches them.
- **The top bar** is `--bar-height` tall and sticks. A repo's tabs stick under it; under them `--topbar-height` (where
  what sticks starts) reaches their foot. On a narrow screen the current tab is scrolled into view, and an end of the
  tabs with more past it fades out. A tab with nothing to show yet (before GitHive starts on a repo) is dimmed, isn't a
  link, and says why in a tooltip (`TabItem.unavailable`).
- **The Inbox leads the top bar.** It fills `needs-soft` while something waits and keeps its name on a phone, where
  light and dark move into the user menu; its count is the bar's one red number (Admin's is neutral). A repo's crumbs
  are its owner (the org or person's page) and its name, a switcher to the reader's other repos. An Inbox row has its
  kind's icon, who waits and for how long ("mara/claude asks · 38m", "GitHive says" for its own agents), the question
  at body size in ink, and a verb (Answer, "Vote as payments", See the audit) that opens the change at its decision.
  A repo's rows, like the Hive's banner, list questions, then votes, each most urgent and then longest waiting first
  (`byWaiting`); the banner shows three and counts the rest, other branches' too, for the Inbox.
- **Moving between places.** A new place starts at the top with its `h1` focused (no ring: it isn't a control), so a
  screen reader starts there; Back and Forward go back to where each history entry was scrolled once the page has
  filled in; a tab of the same place stays where it is. A view that changes the address in place (a search typed)
  uses `replaceHash`, which keeps the entry.
- **Linkable views.** What a view shows that's worth a link goes in the hash's query: a route reads its names with
  `readQuery`, its link writes them with `withQuery` (a text as `name=value`, a flag as `name`). `#/?q=` is the
  Repositories search; `#/repos/o/n/changes/c?decide` opens a change at its decision (`href.change(repo, change, tab,
  { decide: true })`).

## The keyboard

Everything is reached with Tab, and these save the trip (`?`, or Keyboard shortcuts in the user menu, lists them):

| Keys | Does |
| --- | --- |
| `g` then `i` | Goes to the Inbox |
| `g` then `r` | Goes to Repositories |
| `/` | Finds a repository, on Repositories |
| `1` to `8` | Chooses a repo's tab, Hive to Settings |
| `⌘K` or `Ctrl-K` | Opens the palette: a repo, an open change in the repo shown, or a page |
| `?` | Lists the shortcuts |

Keys typed in a field, held with a modifier, or pressed in an open menu or dialog are left alone, but for ⌘K. The
palette is a combobox over a listbox: arrow keys choose, Enter goes, Escape closes. A new shortcut is a case in
`readShortcut` (`lib/shortcuts.ts`) and a line in `SHORTCUTS` (`components/Keyboard.tsx`).

## Motion: nothing changes abruptly

- State changes (hover, press, focus, selected) transition at `duration-fast`.
- Going somewhere doesn't move anything: a page, a tab, and whatever replaces "Loading…" only fade in, quickly
  (`animate-fade`), and the top bar, header and tabs stay still. A list's rows fade in one after another as it first
  shows (`stagger`, with `useStagger`), never again for a poll.
- What arrives in a page that stays put (a new row, a message, a confirm) fades in rising a few pixels:
  `animate-appear`. What's there from a page's first render comes with that page's fade, so what fades in on its own
  later (a tab's content, a bumped count) waits until it has changed (`useChanged`); a row that comes later than its
  list, on its own (`useArrivals`).
- The page keeps room for its scroll bar (`scrollbar-gutter: stable`), so it doesn't shift sideways between a short
  page and a long one.
- What opens and closes folds its height: `Collapse` or `Fold`, `disclosure`, or grid rows `0fr ↔ 1fr`.
- Menus and other overlays grow from their trigger and fade, both ways.
- Swapped content cross-fades; what leaves goes before it's removed (`useLingering`).
- Changing numbers bump (`animate-bump`, to 1.15 and back); reordered rows glide (FLIP).
- Live updates don't move what's being read: while the pointer or focus is in the Hive's goals, or a row in view is open,
  new and finished goals wait behind a quiet "2 new" (`holdLayout` in `lib/hiveMotion.ts`), and come in, gliding, when
  it's clicked or the reader leaves.
- Nothing blinks or pulses for long (WCAG 2.2.2): the landing blinks and the live dot's pulse play three times, then
  hold still.
- Durations come from the theme (`duration-fast` 150ms, `duration-base` 250ms, `duration-slow` 400ms; easings
  `ease-out`, `ease-in`, `ease-spring`, `ease-pop`), and reduced motion turns them all off. JavaScript motion asks
  `reducedMotion()` (`lib/motion.ts`), and what it keeps while it leaves (`useLingering`, `useLeaving`, a Hive motion's
  timer) goes at once under reduced motion, so nothing unseen holds its room.
- Don't transition a `color-mix()` value: Chrome interpolates it wrongly. Animate opacity instead.
- A fade-in fills `backwards`, not `both`: a transform left filling once it's done keeps the element on a layer of its
  own, which Chrome draws a little blurred at a fractional offset (and the visual check catches).

## Trying it locally

`npm run dev:web` serves the dashboard against githive.app's real data (signing in there doesn't carry over to
localhost). `npm run dev:web:fixtures` needs no Worker or sign-in: the API answers from the visual check's synthetic
repos, signed in as their admin (`GITHIVE_AS=visitor` or `operator` for the others), with their times moved up to
now. Writes answer as if they worked and change nothing, and the live feed never connects.

## The visual regression check

```sh
npm run visual -- <label> [--only <regex>]       # capture every scene into web/visual/out/<label>
npm run visual:compare -- <before> <after>       # compare two captures; writes out/<after>-vs-<before>.html
```

Scenes (`web/visual/scenes.ts`) cover every page and tab, states reached by a click, and the Hive playground at fixed
points of fixed runs, with its motions frame by frame, in light and dark, 1280px and 390px wide, from synthetic
fixtures (`web/visual/fixtures/`) with the clock frozen. Capture a baseline before a change and compare after.

## Writing a screen

- Tailwind's reset (preflight) is on, with GitHive's base over it (`theme.css`, `@layer base`): the body's paper, ink
  and 15px Overpass, headings' weight, links, the focus ring, `code` and `pre`, radios and checkboxes in the link's
  color, and touch targets. Everything else starts bare: a paragraph or list has no margins, a list no bullets, a
  heading the body's size, an `svg` sits as a block. Say what you want.
- **One focus ring.** Everything that takes focus shows the base `:focus-visible` outline: 2px of `ring`, 2px out. Don't
  turn it off or draw a border and halo instead. Only what sits inside a group draws it inset (a segmented control's
  choice, a tab, `-outline-offset-2`), a menu's items light up instead, and a hive cell draws it around its hexagon.
- **A map of many things is one stop for Tab.** The Hive's map takes focus once (a roving `tabIndex`); the arrow keys go
  to the nearest cell that way (`nearestInDirection`), Enter or Space does what a click does, and a cell's details open
  in a `Popover` that Escape closes, back to the cell. A cell's name starts with what it shows, in full
  ("OrderSummary.tsx: approved, …" for "Ord…mary.tsx"), so speech can click it (WCAG 2.5.3); the words and chips it
  shows cut to fit are drawn over its button, not in it.
- **Links in running text are underlined** (WCAG 1.4.1): a link in a paragraph, a callout, a `<blockquote>` or
  `<figcaption>`, or a block marked `prose` (a list of sentences, a timeline entry's body) is underlined at 40% of the
  link's color, by the base rule. Links that stand on their own (navigation, tabs, breadcrumbs, pills, a row's title, a
  button as a link) aren't in running text, and a paragraph laid out as a row (`flex`, `grid`) isn't either; a
  component (`data-slot`) or `no-underline` keeps a link bare.
- **Touch targets.** Under a coarse pointer, `touch-target` (on `Button` `sm` and `icon`, `Segmented`'s choices and the
  top bar's pills) and a radio's or checkbox's `<label>` take taps 44px about their middle with an invisible `::after`,
  so nothing grows or moves. Give anything small to tap the class.
- A control is a component (`Button`, `Input`, …) or written in full; there are no global button or field styles.
- Colors, sizes and timings come from the theme. An arbitrary value (`leading-[1.45]`) only where the theme has no
  step, and never a raw color.
- `cn()` joins classes and lets a later one win; pass a component's `className` last.
- A server's error shown on its own goes through `messageOf` (`lib/errors.ts`): a sentence, with a capital and a full
  stop. One set inside a sentence of your own ("couldn't be loaded: …") takes `reasonOf`, the words as they came; a
  poll's `error` is those. `statusOf` gives a refused call's HTTP status (409 for a name that's taken), so the error
  can go under the field it's about, with `aria-invalid` on the field and its hint in `aria-describedby`.
- Capture the visual check before a change and compare after, and add a scene for any state you add.
