# One theme and one set of components for the dashboard

**Date:** 2026-10-13 · **Branch:** `ui-theme-system` (off `dev`)

## Why

The dashboard (`web/`) is about 6,000 lines of hand-written CSS in 36 files, with a deliberate look (the "signal
box" in `styles.css`) but no shared system behind it:

- Light and dark follow the operating system only; nobody can choose.
- `--radius` and `--radius-sm` are both 4px and 37 radii are written out, so corners can't be changed in one place.
- 183 font sizes are written out (twenty different values), with no scale.
- Buttons, inputs and pills are global element styles; tabs, pills, confirms, segmented controls and drawers are
  rebuilt per screen.
- Motion is careful on the Hive tab and almost absent everywhere else: menus, details, tabs, confirms and loaded
  content change at once.

## What we're building

The end state is the dashboard written in **Tailwind CSS v4 with shadcn/ui components**, on one theme file:

1. **One theme file** (`web/src/theme.css`) holds every design value: colors under shadcn's names plus
   GitHive's own (the lamps, the stages, diffs), the radius scale, the type scale, shadows, and motion (durations,
   easings, keyframes and the motion utilities). No component file holds a raw color, size or duration.
2. **Light, dark and system**, chosen in the top bar and remembered in the browser. Other palettes and corner
   styles are token blocks we can swap on our side (`[data-theme]`, `--radius`); they aren't offered to people yet.
3. **shadcn components, in the signal box's look**, for everything shared: buttons, badges, cards, callouts, tabs,
   segmented controls, inputs, selects, menus, dialogs, tooltips and collapsibles. They live in
   `web/src/components/ui/` and use GitHive's `Icon`, not a second icon set.
4. **Every screen on utilities**, including the Hive tab, with no per-component `.css` files left.
5. **Nothing changes abruptly**, anywhere. What the Hive tab does becomes the rule for the whole dashboard (below).

This pass is a **faithful refactor**: once animations settle, every page looks exactly as it does today. A visual
refresh is a separate, later decision. The only intended visible changes are the theme switch and the added
motion.

## Order of work

| Stage | What | Visible change |
| --- | --- | --- |
| R. Regression check | A Playwright harness with fixture data and a frozen clock; baselines captured from `dev` before anything changes | none |
| 0. Foundation | Tailwind v4, shadcn setup, `theme.css`, cascade layers, legacy variables as aliases, the theme switch | the switch |
| 1. Building blocks | `components/ui/*` in the signal box's look, with their motion | none |
| 2. Shell | Top bar, repo header, tabs, page layout | motion only |
| 3. Pages | 3a sign-in, repositories, new repo · 3b changes and the change page · 3c agents, inbox, orgs, admin, settings · 3d code, overview, history, timeline, claims | motion only |
| 4. Hive tab | Strip, goals panel, map | none (sign-off by the owner) |
| 5. Clean-up | Delete the legacy layer and the global element styles; Tailwind's preflight is the only base | none |

Each stage ends with the whole regression check passing, and is its own commit (or a few).

## The regression check (`web/visual/`)

- **Fixture API.** Every GET the dashboard makes is answered from deterministic, synthetic fixtures (no production
  data), through Playwright's request routing; the live WebSocket is routed to a socket that never speaks. A signed-in
  admin sees every page; a signed-out visitor sees sign-in and public pages.
- **Frozen clock.** Playwright's clock fixes `Date.now()`, so "3 min ago" never drifts.
- **Scenes.** Every route and tab, plus states only reachable by a click (an open menu, a confirm asking, an
  expanded row, a drawer), each in light and dark, at 1280px and 390px wide. The Hive tab is captured from the
  playground at fixed seeds and fixed points in the run.
- **Motion.** For key motions (drawer open/close, a row folding away, a count bumping, cells appearing, Story ↔
  Timeline), the harness triggers the motion, pauses every animation (`document.getAnimations()`), seeks them to
  fixed times and captures each frame. Before and after are compared frame by frame.
- **Compare.** Pixel diffs against the baselines with a small anti-aliasing tolerance, written to an HTML report with
  before, after and the difference side by side. Anything over the tolerance fails the stage.
- **Baselines** are captured once from `dev` (commit `d5b7d1e`) and kept outside git.

## Foundation details

- **Tailwind v4** through `@tailwindcss/vite`; configuration lives in CSS (`@theme`, `@custom-variant`,
  `@utility`). `tw-animate-css` for shadcn's enter and exit animations. `cn()` (clsx + tailwind-merge, extended
  with our font-size names) and `cva` for variants.
- **Cascade layers:** `theme, base, legacy, components, utilities`. Tailwind's preflight is in `base`. Until stage
  5, every existing stylesheet is wrapped in `legacy` by a small Vite plugin (no file is re-indented), so legacy
  styles override the preflight and utilities override legacy. Where the preflight changes a legacy element (a
  paragraph's margin, an inline SVG), the fix goes into that component's legacy CSS and dies with it.
- **Tokens.** shadcn's names (`background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`,
  `accent`, `destructive`, `border`, `input`, `ring`) plus GitHive's: `link`, `link-soft`, `surface-3`,
  `border-strong`, the lamps (`amber`, `good`, `warn`, `bad`, `needs`, `neutral`, each with `-soft`), diffs, the
  mark, the stages. Values are today's hex values, unchanged (no OKLCH conversion). Legacy variable names stay as
  aliases until stage 5; legacy `--accent` (the slate blue) is renamed `--link` first, because shadcn's `accent` means
  a hover surface.
- **Radius.** One `--radius` (4px); the scale is multiples of it, so today's 1, 2, 3, 4, 5, 6, 12 and 14px are exact
  steps and a rounder or sharper theme changes one number. `999px` and `50%` stay `rounded-full`.
- **Type.** A named scale for the sizes in common use (11.5, 12, 12.5, 13, 13.5, 14, 15, 16, 18, 20, 22, 24 and
  26px). One-off sizes stay arbitrary values until the refresh.
- **Colors mixed with transparency** use opacity modifiers (`bg-bad/45`); identical to today's `srgb` mixes.
  Mixes of two colors keep `srgb` in an arbitrary value.

## Light, dark and system

- `<html>` carries `.dark` when dark applies; `@custom-variant dark` follows it, and `color-scheme` follows too, so
  native controls and scroll bars match.
- The choice (`light`, `dark` or `system`, default `system`) is kept in `localStorage` (`githive.theme`). A small
  inline script in `index.html` and `playground.html` applies it before the first paint, so no page flashes light.
- `system` keeps listening to the operating system and follows it live.
- The control is an icon button in the top bar (sun or moon) opening a three-item menu with the current choice
  checked, for signed-in and signed-out visitors alike. Switching cross-fades the page through a view transition.
- The favicon keeps following the operating system (the browser tab's own theme).

## Motion: nothing changes abruptly

Tokens: `--motion-fast` (150ms, hover and press), `--motion-base` (250ms, small reveals), `--motion-slow` (400ms,
layout), with `--ease-out`, `--ease-in` and `--ease-spring` (the Hive's overshoot). The rules:

- **State changes** (hover, press, focus, selected, disabled) transition color, background, border and shadow at
  `fast`. Focus rings appear without delay but fade out.
- **Appearing content** (a list after it loads, a message, a callout, a saved notice) fades and rises a few pixels
  (`animate-appear`). Lists stagger by `--i`, capped.
- **Expanding and collapsing** (details, drawers, "show more", sections) animates its height: grid rows `0fr ↔ 1fr`
  (`collapse` utility) or Radix's measured height. Nothing pops open.
- **Overlays** (menus, dialogs, tooltips, popovers, selects) fade and scale from their trigger on open and on close.
- **Swapping content** (loading → loaded, Story ↔ Timeline, tab panels, empty ↔ filled) cross-fades; the old
  content leaves before it's removed.
- **Numbers that change** (counters, stage counts) bump.
- **Reordering** glides (FLIP), as the Hive's goals do.
- **Reduced motion:** one rule shortens every animation and transition to nothing; JavaScript motion (FLIP, view
  transitions) checks the same preference.
- Don't animate `color-mix()` inside transitions (Chrome interpolates it wrongly); animate opacity instead.

The Hive tab's hooks (`useGlide`, the drawer, `useLingering`, `useBumps`, `useFresh`, `useLeaving`) move to
`web/src/hooks/` for every screen to use.

## The Hive tab

Migrated last and held to the strictest standard: the stills and the motion frames must match the baselines, and
its owner reviews it in the playground against `dev` before sign-off.

## Testing

- The existing vitest suite keeps passing (it mostly checks text, not classes); class-name assertions move to the
  new names where a component's markup changes.
- `npm run typecheck`, `npm run format:check` and `npm test` pass at every stage.
- The regression check passes at every stage; the report from the final run goes with the branch.

## Not in this pass

A visual refresh (spacing, type, colors), user-facing palettes or corner choices, a design-token pipeline beyond
CSS, and Storybook.
