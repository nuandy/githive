# The dashboard's look: theme, components, motion

How `web/` is styled, for anyone changing a screen. The design behind it is in
`docs/superpowers/specs/2026-10-13-ui-theme-system-design.md`.

## Where things are

| What | Where |
| --- | --- |
| Every design value (colors, radius, type, shadows, motion), light and dark | `web/src/theme.css` |
| Shared components (Button, Badge, Box, Callout, Empty, fields, Collapse, DropdownMenu, Tooltip, Dialog, …) | `web/src/components/ui/` |
| The frame every page sits in (`Shell`, `Page`, `EmptyPage`) | `web/src/components/Page.tsx` |
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
- The lamps, always the same meaning: `amber` (claimed, in line, checking), `good` (approved, passed, landed), `bad`
  (failed, vetoed), `needs` (waits on a person), plus `warn` (amber dark enough for text) and `neutral`. Each has a
  `-soft` background. Text on a solid `good`, `bad`, `warn` or `needs` fill is that color's `-foreground`
  (`bg-good text-good-foreground`), never `text-white`: dark mode's lamps are bright, and take dark text.
- Diffs (`diff-add`, `diff-del` and their `-strong`), the Claims map's `claim-0` … `claim-7`, the mark (`mark-tile`,
  `mark-line`, `mark-dot`).

Use them as `bg-card`, `text-muted-foreground`, `border-border-strong`, `bg-bad/45`. In SVG or inline styles use the
variable: `fill="var(--good)"`.

**Contrast** is measured, in light and dark, by `web/src/lib/theme.test.ts` (it reads `theme.css`): text at 4.5:1
(a lamp's color on its `-soft`, on `surface-2` and `surface-3`; muted text, placeholders among it; text on a solid
lamp), and what marks a control or focus at 3:1 (`input` and `border-strong` on the card and the page, `ring` on every
surface). A new color, or a new pair that sets text on a color, goes into that test. Content that's out of play
(a revoked agent, a resolved violation) says so in a badge at full contrast; it never fades with `opacity`. The amber
lamp, pale on light paper, carries a ring of `warn`.

**Light and dark.** `:root` is light and `.dark` on `<html>` is dark; `dark:` variants follow it. Under "Same as this
device" the page follows the system live. Another palette is another block of the same variables.

**Corners** are steps of one `--radius` (4px): `rounded-2xs` 1px, `xs` 2px, `sm` 3px, `md` 4px, `lg` 5px, `xl` 6px,
`2xl` 12px, `3xl` 14px, and `rounded-full`. Changing `--radius` rounds or squares the whole dashboard.

**Type** comes in eight sizes, named by role: `text-micro` 11px (counts only, and the Hive's small capitals until it's
redrawn), `caption` 12 (the smallest for words: Overpass's x-height is small), `meta` and `ui` 13, `ui-lg` and
`body-sm` 14, `body` 15, `lead` and `title-sm` 17, `title` and `title-lg` 20, `display-sm` and `display` 26. Roles that
share a size are told apart by weight, color or face. No `text-[…]` sizes, but in the Hive's marks (the map, the goals'
chips and clock), where type sits inside shapes of its own size. Long-form text (an intent, a review, an agent's
question, an Inbox reason) wraps at `max-w-measure`, 70ch. Fonts: `font-sans` (Overpass) and `font-mono` (Overpass
Mono).

**Narrow windows**: `to-480:`, `to-560:`, `to-640:`, `to-720:`, `to-900:`, `to-1100:` apply up to and including that
width (`to-560:hidden`).

## Components

Reach for `components/ui` before writing a control by hand:

- `Button`: `variant` default, `primary` (ink, and saving), `go` (green: land and approve, nothing else), `danger`,
  `ghost`, `link`; `size` default, `sm`, `icon`; `asChild` to give a link a button's look.
- `Badge` (a pill: `tone` good, bad, warn, needs, accent, neutral; `solid`, `outline`; `size="sm"` beside a row's
  title, `size="lg"`), `Counter`, `Lamp`.
- `Box`, `BoxHeader`, `BoxTitle`, `BoxBody`, `BoxRow`: ruled sections, not cards (`asChild` rules a form). `BoxTitle`
  is a section's title at `title-sm`, semibold, an `h2` (or the heading it's given, `asChild`). `Callout` with a
  `tone`. `Empty`: nothing to show yet, an icon, an `h2` and a line or two, centered (`<Box asChild><Empty>` boxes it).
- `SaveBar`: a form's foot, sticky at the bottom of its section: a status line (saved, or what went wrong), then
  Discard and Save (`primary`, submits), both waiting while there's nothing to save.
- `Input`, `Textarea`, `NativeSelect`, `Label`; `Field` holds a label, its control and a `FieldHint` under them.
- `Collapse`: anything that opens and closes; `Fold` drops what it holds once folded, and unfolds it again as it comes
  back (a row a search leaves out, the fields for a choice). `DropdownMenu`: menus from a button; its items light up in
  `link-soft` and the link's color.
- Overlays, shadcn's on `radix-ui`: `Tooltip` (words in ink on hover or focus, in place of `title=`; give a trigger that
  isn't a control `tabIndex={0}`, and the app's one `TooltipProvider` lets one tooltip follow another at once),
  `Popover` (a panel opened by a click or a tap: what a tooltip says where there's no hover, or a few controls),
  `Dialog` (a window of its own over the dimmed page) and `AlertDialog` (a question to answer before going on: delete,
  revoke, remove; `AlertDialogAction` is `danger` unless told otherwise).
- `Announcer` with `useAnnouncer()`: a page's polite live region, for what changes under a screen reader. `say(words)`
  speaks at most once every four seconds and drops what comes sooner; draw `<Announcer said={said} />` once.
- `Icon` comes in three sizes: 14 beside small text (13px and under), 16 (the default) beside body text and alone in a
  button, 28 over an empty state's heading.
- Native `<details>` take the `disclosure` class to unfold instead of jumping open.

To add a shadcn component, run from the repository root: `npx shadcn@latest add <name>` (`components.json` points it
at `web/src/components/ui`). Then point its `cn` import at `@/lib/utils` (ours knows the theme's names), swap
lucide icons for `Icon`, and restyle it from the theme.

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
