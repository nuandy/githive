# The dashboard's look: theme, components, motion

How `web/` is styled, for anyone changing a screen. The design behind it is in
`docs/superpowers/specs/2026-10-13-ui-theme-system-design.md`.

## Where things are

| What | Where |
| --- | --- |
| Every design value (colors, radius, type, shadows, motion), light and dark | `web/src/theme.css` |
| Shared components (Button, Badge, Box, Callout, fields, Collapse, DropdownMenu, …) | `web/src/components/ui/` |
| The frame every page sits in (`Shell`, `Page`, `EmptyPage`) | `web/src/components/Page.tsx` |
| Joining class names | `cn()` in `web/src/lib/utils.ts` |
| Light, dark and the reader's choice | `web/src/lib/theme.ts`, `ThemeMenu.tsx` |
| Motion hooks (`useLingering`, `useChanged`, …) | `web/src/hooks/` |
| The visual regression check | `web/visual/` |

Screens are written in Tailwind CSS v4 utilities. There are no per-component stylesheets: a component's look is in its
markup, drawn from the theme.

## The theme

**Colors** carry meaning, and only the theme's exist (Tailwind's stock palette is switched off):

- Paper and ink: `background`, `foreground`, `card`, `popover`, `muted` / `muted-foreground`, `secondary`, `accent`
  (the surface under a hovered or highlighted item), `surface-2`, `surface-3`, `border`, `border-strong`, `input`.
- Actions: `primary` (the ink fill of a primary action), `link` and `link-soft` (links, focus, "in progress"), `ring`.
- The lamps, always the same meaning: `amber` (claimed, in line, checking), `good` (approved, passed, landed), `bad`
  (failed, vetoed), `needs` (waits on a person), plus `warn` (amber dark enough for text) and `neutral`. Each has a
  `-soft` background.
- Diffs (`diff-add`, `diff-del` and their `-strong`), the Claims map's `claim-0` … `claim-7`, the mark (`mark-tile`,
  `mark-line`).

Use them as `bg-card`, `text-muted-foreground`, `border-border-strong`, `bg-bad/45`. In SVG or inline styles use the
variable: `fill="var(--good)"`.

**Light and dark.** `:root` is light and `.dark` on `<html>` is dark; `dark:` variants follow it. Under "Same as this
device" the page follows the system live. Another palette is another block of the same variables.

**Corners** are steps of one `--radius` (4px): `rounded-2xs` 1px, `xs` 2px, `sm` 3px, `md` 4px, `lg` 5px, `xl` 6px,
`2xl` 12px, `3xl` 14px, and `rounded-full`. Changing `--radius` rounds or squares the whole dashboard.

**Type**, by role: `text-micro` 11.5px, `caption` 12, `meta` 12.5, `ui` 13, `ui-lg` 13.5, `body-sm` 14, `body` 15,
`lead` 16, `title-sm` 18, `title` 20, `title-lg` 22, `display-sm` 24, `display` 26. Fonts: `font-sans` (Overpass) and
`font-mono` (Overpass Mono).

**Narrow windows**: `to-480:`, `to-560:`, `to-640:`, `to-720:`, `to-900:`, `to-1100:` apply up to and including that
width (`to-560:hidden`).

## Components

Reach for `components/ui` before writing a control by hand:

- `Button`: `variant` default, `primary` (ink), `go` (green: merge, approve), `danger`, `ghost`, `link`; `size` default,
  `sm`, `icon`; `asChild` to give a link a button's look.
- `Badge` (a pill: `tone` good, bad, warn, needs, accent, neutral; `solid`, `outline`, `size="lg"`), `Counter`, `Lamp`.
- `Box`, `BoxHeader`, `BoxBody`, `BoxRow`: ruled sections, not cards. `Callout` with a `tone`.
- `Input`, `Textarea`, `NativeSelect`, `Label`.
- `Collapse`: anything that opens and closes. `DropdownMenu`: menus from a button.
- Native `<details>` take the `disclosure` class to unfold instead of jumping open.

To add a shadcn component, run from the repository root: `npx shadcn@latest add <name>` (`components.json` points it
at `web/src/components/ui`). Then point its `cn` import at `@/lib/utils` (ours knows the theme's names), swap
lucide icons for `Icon`, and restyle it from the theme.

## Motion: nothing changes abruptly

- State changes (hover, press, focus, selected) transition at `duration-fast`.
- What appears (loaded content, a message, a confirm) fades in: `animate-appear`. A page fades in as you go to it
  (`PageBoundary`); what's there from its first render comes with that fade, so what fades in on its own later (a
  tab's content, a bumped count) waits until it has changed (`useChanged`).
- What opens and closes folds its height: `Collapse`, `disclosure`, or grid rows `0fr ↔ 1fr`.
- Menus and other overlays grow from their trigger and fade, both ways.
- Swapped content cross-fades; what leaves goes before it's removed (`useLingering`).
- Changing numbers bump (`animate-bump`); reordered rows glide (FLIP).
- Durations come from the theme (`duration-fast` 150ms, `duration-base` 250ms, `duration-slow` 400ms; easings
  `ease-out`, `ease-in`, `ease-spring`, `ease-pop`), and reduced motion turns them all off. JavaScript motion checks
  `prefers-reduced-motion` itself.
- Don't transition a `color-mix()` value: Chrome interpolates it wrongly. Animate opacity instead.
- A fade-in fills `backwards`, not `both`: a transform left filling once it's done keeps the element on a layer of its
  own, which Chrome draws a little blurred at a fractional offset (and the visual check catches).

## The visual regression check

```sh
npm run visual -- <label> [--only <regex>]       # capture every scene into web/visual/out/<label>
npm run visual:compare -- <before> <after>       # compare two captures; writes out/<after>-vs-<before>.html
```

Scenes (`web/visual/scenes.ts`) cover every page and tab, states reached by a click, and the Hive playground at fixed
points of fixed runs, with its motions frame by frame, in light and dark, 1280px and 390px wide, from synthetic
fixtures (`web/visual/fixtures/`) with the clock frozen. Capture a baseline before a change and compare after.

## Moving a screen off the legacy stylesheets

While this lasts: the stylesheets not yet moved sit in a `legacy` cascade layer (`web/vite.config.ts` wraps them),
between the base and the utilities. Utilities beat legacy rules whatever their specificity; legacy rules beat
browser defaults. Tailwind's reset (preflight) is off until the legacy layer is gone, and then it's on.

Moving a component:

1. Read its markup, its stylesheet, and the global rules that reach it (`styles.css`: `button`, `input`, `label`,
   `.pill`, `.box`, `.callout`, `.empty`, `.stat`, `.bar`, `.muted`, …). Its look is the sum of them.
2. Rewrite its classes as utilities and components that reproduce that look exactly. Use the theme's names; an
   arbitrary value (`leading-[1.45]`) only where the theme has no step for it. A page's `<main className="page">` is
   `Page`.
3. Write out what the browser's defaults give it now and preflight will take away: margins of `p`, `ul`, `ol`, `dl`,
   `figure`, `blockquote`, `h1`–`h6`; a list's padding and bullets; a heading's size; an `svg` or `img` sitting inline
   on the text's baseline; a `button`'s or field's font. (Links, `code`, `pre`, headings' weight and line height and
   the body's font stay as the base gives them.)
4. Give every button and field its look from `Button`, `Input` and friends, or in full: the global `button` and
   `input` rules go with the legacy layer.
5. Add the motion the rules above ask for.
6. Delete a stylesheet once none of its classes is used anywhere (search the whole of `web/src`).
7. Capture and compare: every shot must match.
