# UX fixes, part 1: the bugs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the sixteen defects in §1 of the dashboard UX review, each as a small change with a test, without
redesigning anything the later parts redesign.

**Architecture:** Each task touches one component or one piece of `web/src/lib`. Logic changes get unit tests in
the existing style (`renderToStaticMarkup` + `visibleText`, or plain functions); behavior that needs a real browser
(focus, clicks) is checked with a small Playwright script against `npm run dev:web:fixtures`, and every page is
compared with the visual check before and after.

**Tech Stack:** React 19, Tailwind CSS v4 (`web/src/theme.css`), Radix, Vitest (Node, no DOM), playwright-core.

**Spec:** `docs/superpowers/specs/2026-10-13-dashboard-ux-review.md`, §1 (and the lines of §2, §3 and §7 that §1
points at). Read `docs/dashboard-ui.md` before writing any markup.

## Global Constraints

- Work on branch `ux-fixes`, made from `dev`, in a worktree. One commit per task.
- Screens are Tailwind utilities drawn from `theme.css`; no raw colors, no per-component CSS (`docs/dashboard-ui.md`).
- Reach for `web/src/components/ui/*` before writing a control by hand. `cn()` joins classes; pass `className` last.
- Copy: plain words, sentence case, active voice, an action keeps its name through the flow; errors say what
  happened and how to fix it.
- Reduced motion turns every animation off; don't add motion that ignores it.
- Tests: `npx vitest run <file>` from the repo root; all web tests: `npx vitest run web/src`. Types: `npm run typecheck`.
- Visual check baseline already captured at `6300d75`: `web/visual/out/ux-review/`. After each task that changes
  pixels: `npm run visual -- fix-<n> --only '<scene regex>'` and `npm run visual:compare -- ux-review fix-<n>`; the
  only differences must be the intended ones.
- Commit messages follow the repo's style (a plain sentence saying what's now true), ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- A change rejected on an **old** head and approved on its new head must read Approved, with Merge offered; only
  rejections on the **current** head count (Task 3).
- A signed-out visitor, or a reader without review access, on a change whose agent asked a question must never be
  told "your vote below" or "your decision" (Task 4).
- The skip link on a page with no `<main>` yet ("Loading…", sign-in, a crashed page) must do nothing harmful: no
  route change, no error (Task 1).
- A breadcrumb trail of one crumb (Inbox, Agents) must still show at 390px (Task 2).
- An owner limit's number field emptied or set to 0 and then Enter or blur must not save 0 as "up to 0 a day"
  (Task 12).

---

### Task 1: The skip link skips, and stops showing

**Files:**
- Modify: `web/src/components/Page.tsx:13-28`
- Create: `web/src/components/Page.test.tsx`
- Create: `web/visual/checks/skip-link.mjs` (a throwaway-free browser check, kept for later runs)

**Interfaces:**
- Produces: `Page` renders `<main id="main" tabIndex={-1}>`, so any code may focus `#main`.

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/components/Page.test.tsx
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Page, SkipLink } from "./Page";

describe("the skip link", () => {
	it("casts no shadow until it takes focus", () => {
		const html = renderToStaticMarkup(<SkipLink />);
		expect(html).not.toMatch(/class="[^"]*(?<!:)shadow-raised/);
		expect(html).toContain("focus:shadow-raised");
	});

	it("lands on a main column that can take focus", () => {
		const html = renderToStaticMarkup(<Page>text</Page>);
		expect(html).toContain('id="main"');
		expect(html).toContain('tabindex="-1"');
	});
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run web/src/components/Page.test.tsx`
Expected: FAIL (the link carries `shadow-raised`; `Page` has no `tabindex`).

- [ ] **Step 3: Implement**

The router reads every hash as a route, so the link can't navigate: it moves focus instead.

```tsx
/** For keyboard users: hidden above the window until it takes focus, then it slides down. It moves focus to the
 *  page's main column without touching the address, which the router reads as a route. */
export function SkipLink() {
	const skip = (event: MouseEvent<HTMLAnchorElement>) => {
		event.preventDefault();
		document.getElementById("main")?.focus();
	};
	return (
		<a
			href="#main"
			onClick={skip}
			className="absolute -top-10 left-2 z-20 rounded-md bg-card px-3 py-1.5 transition-[top] duration-fast ease-out focus:top-2 focus:shadow-raised"
		>
			Skip to content
		</a>
	);
}

export function Page({ className, ...props }: ComponentProps<"main">) {
	return (
		<main
			id="main"
			tabIndex={-1}
			className={cn("mx-auto w-full max-w-(--page-width) min-w-0 p-6 outline-none to-560:p-4", className)}
			{...props}
		/>
	);
}
```

Import `type MouseEvent` from `react`. Remove the now-redundant `id="main"` props passed to `Page`/`EmptyPage`
(`grep -rn 'id="main"' web/src`), keeping any on elements that aren't a `Page`.

- [ ] **Step 4: Run the test**

Run: `npx vitest run web/src/components/Page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Check it in a browser**

```js
// web/visual/checks/skip-link.mjs — node web/visual/checks/skip-link.mjs (needs npm run dev:web:fixtures on :5173,
// or BASE=http://localhost:<port>/)
import { chromium } from "playwright-core";
const BASE = process.env.BASE ?? "http://localhost:5173/";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}#/repos/acme/storefront/changes`);
await page.getByRole("heading", { name: /Open/ }).waitFor();
await page.keyboard.press("Tab");
await page.keyboard.press("Enter");
const hash = await page.evaluate(() => location.hash);
const focused = await page.evaluate(() => document.activeElement?.id);
await browser.close();
if (hash !== "#/repos/acme/storefront/changes" || focused !== "main") {
	console.error(`skip link: hash ${hash}, focus on #${focused}`);
	process.exit(1);
}
console.log("skip link: ok");
```

Run: `node web/visual/checks/skip-link.mjs` → `skip link: ok`. Then the visual check on `repos|inbox`: the grey
smudge at the top left is gone and nothing else moved.

- [ ] **Step 6: Commit** — "The skip link skips to the page, and hides until it's wanted"

### Task 2: Breadcrumbs never print over each other

**Files:**
- Modify: `web/src/components/TopBar.tsx:147-182` (`Breadcrumbs`)
- Test: `web/src/components/TopBar.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
describe("the breadcrumbs", () => {
	const crumbs = [
		{ label: "Repositories", href: "#/" },
		{ label: "acme/storefront", href: "#/repos/acme/storefront" },
		{ label: "Let shoppers apply a coupon code in the cart drawer." },
	];
	const items = (html: string) => [...html.matchAll(/<li class="([^"]*)"/g)].map((match) => match[1]!);

	it("lets only the last crumb shrink, so the others never print under it", () => {
		const [first, second, last] = items(renderToStaticMarkup(<TopBar crumbs={crumbs} />));
		expect(first).toMatch(/\bshrink-0\b/);
		expect(second).toMatch(/\bshrink-0\b/);
		expect(last).toMatch(/\bmin-w-0\b/);
		expect(last).not.toMatch(/\bshrink-0\b/);
	});

	it("keeps only the last crumb on a phone, and a lone crumb always", () => {
		const [first, second, last] = items(renderToStaticMarkup(<TopBar crumbs={crumbs} />));
		expect(first).toMatch(/\bto-560:hidden\b/);
		expect(second).toMatch(/\bto-560:hidden\b/);
		expect(last).not.toMatch(/\bto-560:hidden\b/);
		const [only] = items(renderToStaticMarkup(<TopBar crumbs={[{ label: "Inbox" }]} />));
		expect(only).not.toMatch(/\bto-560:hidden\b/);
	});
});
```

- [ ] **Step 2: Run** `npx vitest run web/src/components/TopBar.test.tsx` → FAIL.

- [ ] **Step 3: Implement.** In each `<li>`: `last ? "min-w-0 overflow-hidden" : "shrink-0"`, and
`!last && "to-560:hidden"` (replacing `index < crumbs.length - 2`). Keep `min-w-0` off the earlier crumbs. Update the
doc comment: "on a phone, only the last one: the repo header and the page say the rest."

- [ ] **Step 4: Run** the test → PASS. Visual check on `change-|storefront-hive|visitor-change`: crumbs at 390 show
only the last, ellipsized; at 1280 "Repositories / acme/storefront / Swap the home page hero…" reads cleanly.

- [ ] **Step 5: Commit** — "Breadcrumbs keep their place: only the last one shortens"

### Task 3: A change's status counts rejections on its head, and Merge waits for a clean head

**Files:**
- Modify: `web/src/lib/changeStatus.ts` (add `"checks-failed"` to `StatusKind`)
- Modify: `web/src/lib/claimStatus.ts` (add `rejectionsOnHead`, take `votes` in `claimStatus`)
- Modify: `web/src/lib/goals.ts:372-373` (use `rejectionsOnHead`)
- Modify: `web/src/components/StatusPill.tsx` (icon for `checks-failed`: `"x"`)
- Modify: `web/src/components/RepoTabs.tsx:104`, `web/src/components/ChangePage.tsx:126-128,299-318,450`
- Test: `web/src/lib/claimStatus.test.ts`, `web/src/components/ChangePage.test.tsx` (create)

**Interfaces:**
- Produces: `rejectionsOnHead(claim: Claim, votes: Vote[]): Vote[]` and
  `claimStatus(claim: Claim, votes?: Vote[]): ChangeStatus`.

- [ ] **Step 1: Write the failing tests**

```ts
// web/src/lib/claimStatus.test.ts
describe("rejections on the change's head", () => {
	const approved = { ...claim, hosted: undefined, approval: { ...claim.approval, approved: true, vetoedBy: [] } };
	const head = approved.head!;
	const vote = (over: Partial<Vote>): Vote => ({
		commit: head, reviewer: "githive-checks", role: "checks", verdict: "reject",
		evidence: "checks failed: npm test exited 1", at: "2026-10-13T10:00:00Z", ...over,
	});

	it("reads an approved change whose checks failed on its head as failed, not approved", () => {
		expect(claimStatus(approved, [vote({})])).toMatchObject({ kind: "checks-failed", label: "Checks failed", tone: "bad" });
	});

	it("reads a reviewer's rejection on the head as changes requested", () => {
		expect(claimStatus(approved, [vote({ reviewer: "ines/claude", role: "review" })]).kind).toBe("changes-requested");
	});

	it("ignores rejections on an earlier head, and the author's own votes", () => {
		expect(claimStatus(approved, [vote({ commit: "0000000old" })]).kind).toBe("approved");
		expect(claimStatus(approved, [vote({ reviewer: approved.agent })]).kind).toBe("approved");
	});

	it("reads as before without votes", () => {
		expect(claimStatus(approved).kind).toBe("approved");
	});
});
```

```tsx
// web/src/components/ChangePage.test.tsx — render the page for an approved change whose checks failed on its head
// and for one that conflicts with main; neither offers Merge. Build the props from web/src/test/fixtures.ts
// (repoSnapshot) the way other component tests do, passing `merge={async () => ({ ok: true })}`.
it("offers no Merge for a change whose checks failed on its head", () => {
	const text = visibleText(renderToStaticMarkup(<ChangePage {...failedChecksProps} />));
	expect(text).toContain("Checks failed");
	expect(text).not.toMatch(/\bMerge\b(?! status)/);
});
it("offers no Merge for a change that conflicts with main", () => {
	const text = visibleText(renderToStaticMarkup(<ChangePage {...conflictProps} />));
	expect(text).not.toMatch(/\bMerge\b(?! status)/);
});
it("offers Merge for an approved change with a clean head", () => {
	expect(visibleText(renderToStaticMarkup(<ChangePage {...cleanProps} />))).toMatch(/\bMerge\b/);
});
```

- [ ] **Step 2: Run** both files → FAIL.

- [ ] **Step 3: Implement**

```ts
// web/src/lib/claimStatus.ts
/** Rejections on the change's current head from anyone but its agent: a reviewer's, or failed checks'. */
export function rejectionsOnHead(claim: Claim, votes: Vote[]): Vote[] {
	if (!claim.head) return [];
	return votes.filter((vote) => vote.commit === claim.head && vote.reviewer !== claim.agent && vote.verdict === "reject");
}
```

In `claimStatus(claim, votes = [])`, after the veto check and before `if (claim.approval.approved)`:

```ts
	const rejected = rejectionsOnHead(claim, votes);
	if (rejected.some((vote) => vote.role === "checks"))
		return {
			kind: "checks-failed",
			label: "Checks failed",
			tone: "bad",
			description: "Its checks failed on this commit; its agent fixes it and pushes again.",
		};
	if (rejected.length)
		return { kind: "changes-requested", label: "Changes requested", tone: "bad", description: "A reviewer asked for changes." };
```

In `goals.ts` `stateOf`, replace the `onHead…some(reject)` test with `rejectionsOnHead(claim, votes).length`
(same rule, one place). Pass votes to every caller: `RepoTabs.tsx:104` → `claimStatus(claim, snapshot.votes)`;
`ChangePage` `statusOf` and `ClaimMergeBox` → the page's `votes`. In `ChangePage`:

```ts
	const clean = !!claim && !rejectionsOnHead(claim, history?.votes ?? snapshot.votes).length && !history?.merge;
	const mergeable = claim && merge && claim.approval.approved && !claim.waitsOn?.length && clean;
```

- [ ] **Step 4: Run** both test files, then `npx vitest run web/src` (the Hive's tests must not move) → PASS.
Visual check on `change-hero-banner|storefront-changes`: hero-banner shows "Checks failed", no Merge.

- [ ] **Step 5: Commit** — "A change whose checks failed says so, and offers no Merge until its head is clean"

### Task 4: Only the people who can answer are asked

**Files:**
- Modify: `web/src/components/ChangePage.tsx:213-227` (`AttentionCallout`), `:293-319` (`ClaimMergeBox`), and where
  they're rendered (`:482`, `MergeStatus`)
- Test: `web/src/components/ChangePage.test.tsx`

**Interfaces:**
- Consumes: `canVote`, `api`, `claim.head` (existing props).
- Produces: `AttentionCallout({ attention, answerable })`.

- [ ] **Step 1: Failing test**

```tsx
describe("an agent's question", () => {
	it("asks the reader to vote only when a vote form is on the page", () => {
		const text = visibleText(renderToStaticMarkup(<ChangePage {...askingProps} canVote api={voteApi} />));
		expect(text).toContain("Decide with your vote below");
	});
	it("tells a reader who can't vote that it waits on a person, not on them", () => {
		const text = visibleText(renderToStaticMarkup(<ChangePage {...askingProps} canVote={false} />));
		expect(text).toContain("asks a person");
		expect(text).not.toMatch(/asks you|your vote below|your decision/);
	});
	it("says there's nothing to vote on before anything is pushed", () => {
		const text = visibleText(renderToStaticMarkup(<ChangePage {...askingNothingPushedProps} canVote api={voteApi} />));
		expect(text).not.toContain("your vote below");
		expect(text).toContain("Nothing is pushed yet");
	});
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `answerable = !!(api && canVote && claim.head)`. Callout heading: answerable ? "{agent}
asks you" : "{agent} asks a person". Last line: answerable → current text; no head → "Nothing is pushed yet, so
there's no commit to vote on."; can't vote → "A person who can review in {repo} answers it by voting." Merge box:
answerable ? "Waiting on your decision: …" : "Waiting on a person: {agent}'s question is above."

- [ ] **Step 4: Run** → PASS. Visual check `visitor-change|change-og-images|change-stock-sync`.

- [ ] **Step 5: Commit** — "An agent's question asks you only when you can answer it here"

### Task 5: The vote starts undecided, and says why it can't be sent

**Files:**
- Modify: `web/src/components/VoteForm.tsx`
- Modify: `web/src/components/Timeline.tsx:81-86`
- Create: `web/src/lib/roles.ts`, `web/src/lib/roles.test.ts`
- Test: `web/src/components/VoteForm.test.tsx` (create)

**Interfaces:**
- Produces: `roleName(role: string): string` — `"review"` → `"reviewer"`, anything else → `` `${role} reviewer` ``.

- [ ] **Step 1: Failing tests**

```ts
// web/src/lib/roles.test.ts
it("names a role's reviewer without saying review twice", () => {
	expect(roleName("review")).toBe("reviewer");
	expect(roleName("security")).toBe("security reviewer");
});
```

```tsx
// web/src/components/VoteForm.test.tsx
it("starts with no verdict chosen and says what's missing", () => {
	const html = renderToStaticMarkup(<VoteForm repo="acme/storefront" claim={pushedClaim} policy={policy} api={voteApi} />);
	expect(html).not.toMatch(/<input[^>]*checked/);
	expect(visibleText(html)).toContain("Choose a verdict and say what you checked");
	expect(visibleText(html)).not.toContain("review reviewer");
});
it("asks for an answer when the agent asked a question", () => {
	const html = renderToStaticMarkup(<VoteForm repo="acme/storefront" claim={askingClaim} policy={policy} api={voteApi} />);
	expect(visibleText(html)).toContain(`Your answer to ${askingClaim.attention!.agent}`);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `useState<Verdict | null>(null)`; submit needs `verdict && evidence.trim()`; the submit
button is `variant="default"` until a verdict is chosen, then `go` / `danger` as today; under the button, while
disabled and not busy, a `text-meta text-muted-foreground` line with `id="vote-missing"` and
`aria-describedby="vote-missing"` on the button: "Choose a verdict and say what you checked." (or only the half
that's missing). Role options read `roleName(option)`. Field label: `claim.attention ? \`Your answer to
${claim.attention.agent}\` : "What you checked"`. After a successful vote, reset `verdict` to `null`. Timeline:
`({roleName(review.reviewer)})` and `<strong>{review.reviewer}</strong> …` → `roleName` too.

- [ ] **Step 4: Run** → PASS. Visual check `change-` scenes.

- [ ] **Step 5: Commit** — "A vote starts undecided, and its button says what it still needs"

### Task 6: Making a repo public asks first

**Files:**
- Modify: `web/src/components/RepoAdmin.tsx:228-249` (`VisibilityToggle`) and its caller (pass `confirming`,
  `setConfirming`)
- Test: `web/src/components/Manage.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
it("names the visibility action and asks before making a repo public", () => {
	const html = renderToStaticMarkup(<VisibilityToggle repo="acme/docs" visibility="private" confirming="visibility" {...rest} />);
	const text = visibleText(html);
	expect(text).toContain("Make acme/docs public? Anyone signed in to GitHive can read its code and history.");
	expect(text).toContain("Yes, make public");
});
it("makes a public repo private without asking", () => {
	const text = visibleText(renderToStaticMarkup(<VisibilityToggle repo="acme/docs" visibility="public" confirming={null} {...rest} />));
	expect(text).toContain("Make private");
	expect(text).not.toMatch(/\?$/);
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Drop the "Make it" label. Private → `ConfirmButton id="visibility" label="Make public"
question={\`Make ${repo} public? Anyone signed in to GitHive can read its code and history.\`}`. Public → a plain
`Button size="sm"` "Make private". Export `VisibilityToggle` for the test.

- [ ] **Step 4: Run** → PASS. Visual check `storefront-settings|tiny-lib-settings`.

- [ ] **Step 5: Commit** — "Making a repo public asks first, and the button says what it does"

### Task 7: White on a status color is only used where it reads

**Files:**
- Modify: `web/src/theme.css` (light `:root`, `.dark`, and the `@theme` color list near line 232)
- Modify: `web/src/components/ui/badge.tsx:33-36`, `web/src/components/ui/button.tsx:25-27`,
  `web/src/components/ChangePage.tsx` (`MERGE_ICON`), `web/src/components/Timeline.tsx:175-181` (`BADGE`),
  `web/src/components/TopBar.tsx:128` (`PillCount`)
- Test: `web/src/lib/theme.test.ts`

**Interfaces:**
- Produces: tokens `--good-foreground`, `--bad-foreground`, `--warn-foreground`, `--needs-foreground` and utilities
  `text-good-foreground` etc.

- [ ] **Step 1: Failing test** — read `theme.css`, pull each fill and its foreground for `:root` and `.dark`, assert
contrast ≥ 4.5:

```ts
import { readFileSync } from "node:fs";
const css = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
const block = (selector: string) => css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
const value = (scope: string, name: string) => scope.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
const luminance = (hex: string) => {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x! + 0.05) / (y! + 0.05); };

describe("text on a solid status color", () => {
	for (const scheme of [":root", ".dark"])
		for (const tone of ["good", "bad", "warn", "needs"])
			it(`reads at 4.5:1 or more: ${tone}, ${scheme}`, () => {
				const scope = block(scheme);
				// A scheme that doesn't set the foreground inherits :root's.
				const fg = value(scope, `${tone}-foreground`) ?? value(block(":root"), `${tone}-foreground`);
				expect(contrast(value(scope, tone)!, fg!)).toBeGreaterThanOrEqual(4.5);
			});
});
```

- [ ] **Step 2: Run** `npx vitest run web/src/lib/theme.test.ts` → FAIL (no foreground tokens).

- [ ] **Step 3: Implement.** `:root`: `--good-foreground: #ffffff; --bad-foreground: #ffffff; --warn-foreground:
#ffffff; --needs-foreground: #ffffff;`. `.dark`: all four `#121a1f`. Under `@theme`: `--color-good-foreground:
var(--good-foreground);` and the other three. Replace `text-white` on solid good/bad/warn/needs fills with the
matching `text-*-foreground` in the five files listed; `go`'s hover and `danger`'s hover use them too.

- [ ] **Step 4: Run** → PASS. Visual check `change-checkout-tax|change-hero-banner|repos|admin` in dark: Merge, the
Approved pill and the inbox count are dark-on-color; light is unchanged.

- [ ] **Step 5: Commit** — "Status colors carry text that reads in dark mode too"

### Task 8: The repo's heading is its name

**Files:**
- Modify: `web/src/components/RepoHeader.tsx:68-80` (move `badges` out of the `h1`; add `heading` prop)
- Modify: `web/src/components/RepoPage.tsx:~371` (pass `heading={false}` on the change page)
- Test: `web/src/components/RepoTabs.test.tsx` (or a new `RepoHeader.test.tsx`)

**Interfaces:**
- Produces: `RepoHeader` prop `heading?: boolean` (default `true`): the name is an `h1` only when the page has no
  heading of its own.

- [ ] **Step 1: Failing test**

```tsx
it("names the repo, and only the repo, in its heading", () => {
	const html = renderToStaticMarkup(
		<RepoHeader name="acme/storefront" tabs={[]} current="hive" homeHref="#/" badges={<ShardingBadge summary={{ label: "Sharded votes", sharded: true, detail: "Votes are split by commit." }} />} />,
	);
	const h1 = html.match(/<h1[^>]*>(.*?)<\/h1>/s)?.[1] ?? "";
	expect(visibleText(h1)).toBe("acme/storefront");
	expect(html).toContain("Sharded votes");
});
it("leaves the heading to a page that has its own", () => {
	expect(renderToStaticMarkup(<RepoHeader name="acme/storefront" tabs={[]} current="changes" homeHref="#/" heading={false} />)).not.toContain("<h1");
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Wrap name row in a `div` (flex, same classes); `const Name = heading ? "h1" : "p"`; the
`Name` holds the icon and link; `{badges}` follows as a sibling. `RepoPage` passes `heading={view.page !== "change"}`
(or the equivalent condition there).

- [ ] **Step 4: Run** → PASS. Visual check `storefront-hive|change-cart-coupons`: no pixel change.

- [ ] **Step 5: Commit** — "A repo's heading is its name; a change's page has one heading"

### Task 9: Segmented choices show focus

**Files:**
- Modify: `web/src/components/ui/segmented.tsx:26-40`
- Test: `web/src/components/ui/ui.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
it("doesn't clip a focused choice's ring", () => {
	const html = renderToStaticMarkup(<Segmented label="Window" options={[{ value: 1, words: "1 h" }, { value: 6, words: "6 h" }]} value={1} onPick={() => undefined} />);
	expect(html).not.toMatch(/data-slot="segmented"[^>]*overflow-hidden/);
	expect(html).toContain("focus-visible:outline-2");
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Group: drop `overflow-hidden`. Buttons: add `relative first:rounded-l-[calc(var(--radius)-1px)]
last:rounded-r-[calc(var(--radius)-1px)] focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2
focus-visible:outline-ring`, and drop `focus-visible:border-ring focus-visible:shadow-focus` (they coloured a border
the buttons don't have).

- [ ] **Step 4: Run** → PASS. Visual check `hive-` scenes: unchanged at rest.

- [ ] **Step 5: Commit** — "A focused choice in a segmented control shows its ring"

### Task 10: Asking twice keeps your place

**Files:**
- Modify: `web/src/components/Confirm.tsx`
- Create: `web/visual/checks/confirm-focus.mjs`

- [ ] **Step 1: Write the browser check** (fails today)

```js
// web/visual/checks/confirm-focus.mjs
import { chromium } from "playwright-core";
const BASE = process.env.BASE ?? "http://localhost:5173/";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}#/repos/acme/storefront/settings`);
const remove = page.getByRole("button", { name: "Remove" }).first();
await remove.waitFor();
await remove.focus();
await page.keyboard.press("Enter");
const asked = await page.evaluate(() => document.activeElement?.textContent?.trim());
await page.keyboard.press("Escape");
const back = await page.evaluate(() => document.activeElement?.textContent?.trim());
await browser.close();
const ok = asked === "Cancel" && back === "Remove";
console.log(ok ? "confirm focus: ok" : `confirm focus: asked on "${asked}", back on "${back}"`);
process.exit(ok ? 0 : 1);
```

- [ ] **Step 2: Run** `node web/visual/checks/confirm-focus.mjs` → exits 1.

- [ ] **Step 3: Implement.** In the question branch, a ref on Cancel focused in `useEffect` when it opens; `onKeyDown`
on the group: Escape → `setConfirming(null)`. A ref on the trigger, and a module-level `returnTo` id: when
`confirming` goes from `id` back to `null` without confirming, focus the trigger after render (`useEffect` keyed on
`confirming`). Give the group `role="alertdialog"`-free semantics: keep `role="group"`, add `aria-live="polite"` on
the question's `<span>` so it's read as it appears.

- [ ] **Step 4: Run** the check → `confirm focus: ok`. Visual check `-confirm` scenes: the Cancel button now shows
its focus ring (intended).

- [ ] **Step 5: Commit** — "Asking twice moves focus to the question and back, and Escape keeps things as they were"

### Task 11: A tab that can't load says why, and offers to try again

**Files:**
- Create: `web/src/components/LoadError.tsx`
- Modify: `web/src/App.tsx:226-229` (errors list), `useRepoData` consumers, `web/src/components/RepoTabs.tsx:319-329`
  (`AuditTab`), `web/src/components/History.tsx:34-42`
- Test: `web/src/components/History.test.tsx`, `web/src/components/RepoTabs.test.tsx`

**Interfaces:**
- Produces: `LoadError({ what, error, onRetry }: { what: string; error: string; onRetry?: () => void })` — a
  `Callout tone="bad"` with `role="alert"`: "{what} couldn't be loaded: {error}." and a `Button size="sm"` "Try again".
- `AuditTab` takes `error?: string` and `onRetry?: () => void`; `History` takes `onRetry?: () => void`.

- [ ] **Step 1: Failing tests**

```tsx
it("says why the history couldn't load, and offers to try again", () => {
	const text = visibleText(renderToStaticMarkup(<History repo="acme/docs" history={undefined} error="the server timed out" onRetry={() => undefined} />));
	expect(text).toContain("The history couldn't be loaded: the server timed out.");
	expect(text).toContain("Try again");
});
it("stops replaying once the audit fails", () => {
	const text = visibleText(renderToStaticMarkup(<AuditTab snapshot={{ ...repoSnapshot, audit: undefined }} error="the records couldn't be read" />));
	expect(text).not.toContain("Replaying");
	expect(text).toContain("The audit couldn't be loaded: the records couldn't be read.");
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** `LoadError`, use it in both; thread `audit.error` / `audit.refresh` from `useRepoData`
to `AuditTab`; History's `error` is `unknown` today — pass `messageOf(error)`. Add `audit.error` and `access.error`
to the `errors` list in `Dashboard` (as `${repoName} audit: …`, `${repoName} access: …`).

- [ ] **Step 4: Run** → PASS. Visual check `storefront-audit|docs-history-error`.

- [ ] **Step 5: Commit** — "A tab that can't load says why, and offers to try again"

### Task 12: New repositories start fresh, and say what's missing

**Files:**
- Modify: `web/src/components/NewRepoPage.tsx:84,97-103,~203`, `web/src/components/NewRepoFields.tsx:112-119`
- Test: create `web/src/components/NewRepoPage.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
it("starts fresh, with the choices in the order people pick them", () => {
	expect(SOURCES.map((source) => source.value)).toEqual(["empty", "import", "copy"]);
	const html = renderToStaticMarkup(<NewRepoView orgs={orgs} repos={[]} create={create} onCreated={() => undefined} />);
	expect(html).toMatch(/value="empty"[^>]*checked|checked[^>]*value="empty"/);
});
it("says what the form still needs while it can't be sent", () => {
	const text = visibleText(renderToStaticMarkup(<NewRepoView orgs={orgs} repos={[]} create={create} onCreated={() => undefined} />));
	expect(text).toContain("Name it to make it.");
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Default `source` `"empty"`; reorder `SOURCES`. A `missing` string beside the disabled
submit, `aria-describedby` from the button: no name → "Name it to make it."; import without URL → "Add the Git URL
to import."; copy without a repo → "Choose the repository to copy."

- [ ] **Step 4: Run** → PASS. Visual check `new-repo`.

- [ ] **Step 5: Commit** — "A new repository starts fresh, and the form says what it still needs"

### Task 13: Owner limits save what you meant, and say so

**Files:**
- Modify: `web/src/components/AgentLimitsPanel.tsx:40-118`
- Test: `web/src/components/AgentsPage.test.tsx`

- [ ] **Step 1: Failing tests**

```tsx
it("doesn't save a daily limit until a number is given", () => {
	const saved: (number | null)[] = [];
	// Render LimitField (export it) with limit 0 and a save spy; simulate choosing "daily" by calling its choose()
	// through a small exported helper `nextLimit(choice, perDay)`.
	expect(nextLimit("daily", 0)).toBeUndefined();
	expect(nextLimit("daily", 3)).toBe(3);
	expect(nextLimit("never", 3)).toBe(0);
	expect(nextLimit("any", 3)).toBeNull();
});
it("says when a limit was saved", () => {
	expect(visibleText(renderToStaticMarkup(<LimitField id="b" label="Build" limit={3} done={0} save={() => undefined} saved />))).toContain("Saved");
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** `nextLimit(choice, perDay)`: `"daily"` with `perDay < 1` → `undefined` (don't save).
Choosing "daily" shows the number field empty-or-last and focuses it, and saves nothing until Enter or blur with a
whole number ≥ 1. Enter in the field saves. After a save resolves, show `Saved` (`role="status"`,
`text-meta text-good`) for 2 s. Disable only this agent's fieldset: `disabled={busy === key}`.

- [ ] **Step 4: Run** → PASS. Visual check `agents`.

- [ ] **Step 5: Commit** — "Owner limits save the number you give, when you give it, and say so"

### Task 14: Copying a secret doesn't read it aloud, and a new token waits for you

**Files:**
- Modify: `web/src/components/CopyBlock.tsx`, `web/src/components/AgentsPage.tsx:62-90`
- Test: `web/src/components/copy.test.tsx`, `web/src/components/AgentsPage.test.tsx`

- [ ] **Step 1: Failing tests**

```tsx
it("names the copy button by what it copies, never by the secret", () => {
	const html = renderToStaticMarkup(<CopyBlock text="ghv_secretsecretsecretsecretsecretsecret" label="Copy token" />);
	expect(html).not.toContain("ghv_secret</");
	expect(html).not.toMatch(/aria-label="[^"]*ghv_/);
	expect(html).toContain('role="status"');
});
it("keeps each agent's new token until it's dismissed", () => {
	// issued is a record by agent id: making a token for a second agent leaves the first one shown.
	expect(withIssued({ a: "t1" }, "b", "t2")).toEqual({ a: "t1", b: "t2" });
	expect(withIssued({ a: "t1", b: "t2" }, "a", null)).toEqual({ b: "t2" });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** CopyBlock: drop the `aria-label`; the button's visible text is its name; an sr-only
`role="status"` span says "Copied" when copied; reset `copied` after 2 s (`setTimeout`, cleared on unmount). Callers
that pass `label` keep it ("Copy token", "Copy command"). AgentsPage: `issued: Record<string, string>` with an
exported pure `withIssued(issued, agentId, token | null)`.

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** — "Copying a token never reads it aloud, and each new token stays until you're done"

### Task 15: Nothing on screen steps outside the theme

**Files:**
- Modify: `web/src/components/ChangePage.tsx:402`, `web/src/components/HiveMark.tsx:18`,
  `web/src/components/GitHubSettings.tsx:99-101`, `web/src/components/SignIn.tsx:175`, `web/src/theme.css` (`@layer base`)
- Test: `web/src/components/ui/ui.test.tsx` (a source scan)

- [ ] **Step 1: Failing test**

```ts
import { readdirSync, readFileSync } from "node:fs";
it("uses no raw colors or system styles in components", () => {
	const dir = new URL("../", import.meta.url);
	const offenders = readdirSync(dir).filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
		.filter((file) => /#[0-9a-f]{6}\b|ThreeDFace|font-family:monospace/i.test(readFileSync(new URL(file, dir), "utf8")));
	expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run** → FAIL (ChangePage, HiveMark, GitHubSettings, SignIn).

- [ ] **Step 3: Implement.** `text-[#b86e00]` → `text-warn`. HiveMark's dot: a new `--mark-dot: #e59a0b` (both schemes)
used as `fill="var(--mark-dot)"`. The GitHub fieldset: `rounded-md border border-border px-4 py-4` (no groove).
`[font-family:monospace]` → `font-mono`. In `@layer base`: `input[type="radio"], input[type="checkbox"] {
accent-color: var(--link); }`.

- [ ] **Step 4: Run** → PASS. Visual check `storefront-settings|visitor-sign-in|change-cart-coupons`.

- [ ] **Step 5: Commit** — "Every color on screen comes from the theme"

### Task 16: Each page names itself in the window title

**Files:**
- Modify: `web/src/App.tsx:393-436` (`headingOf`, export it), `web/src/components/Page.tsx` (`EmptyPage` → `h1`)
- Modify: every `EmptyPage` child `<h2>` → `<h1>` (`grep -rn "<EmptyPage" web/src`)
- Test: create `web/src/App.test.ts`

- [ ] **Step 1: Failing test**

```ts
import { headingOf } from "./App";
it("titles each repo tab, file and missing page", () => {
	expect(headingOf({ page: "repo", repo: "acme/storefront", tab: "changes" }, 0, "").title).toBe("Changes · acme/storefront · GitHive");
	expect(headingOf({ page: "repo", repo: "acme/storefront", tab: "hive" }, 0, "").title).toBe("acme/storefront · GitHive");
	expect(headingOf({ page: "repo", repo: "acme/storefront", tab: "code", path: "src/lib/cart.ts" }, 0, "").title).toBe("cart.ts · src/lib · acme/storefront · GitHive");
	expect(headingOf({ page: "not-found" }, 0, "").title).toBe("Page not found · GitHive");
	expect(headingOf({ page: "repos" }, 2, "").title).toBe("(2) Repositories · GitHive");
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement.** Tab names: `{ changes: "Changes", history: "History", claims: "Claims", code: "Code",
agents: "Agents", audit: "Audit", settings: "Settings" }`; Code with a path: `basename · dirname · repo`; not-found
→ "Page not found · GitHive"; a positive inbox count prefixes every title with `(n) ` (the Inbox's own title keeps
"Inbox (n)" → becomes "(n) Inbox"). `EmptyPage`'s `[&_h2]` selectors → `[&_h1]`; its callers' `h2` → `h1`.

- [ ] **Step 4: Run** → PASS; `npx vitest run web/src` → PASS; `npm run typecheck` → clean. Visual check `not-found`.

- [ ] **Step 5: Commit** — "Each page names itself in the window title, and has one heading"

---

## Finishing

- [ ] `npx vitest run web/src` and `npm run typecheck` pass.
- [ ] `npm run visual -- fix-all` and `npm run visual:compare -- ux-review fix-all`: every difference is one this
      plan intended (list them in the merge message).
- [ ] `node web/visual/checks/skip-link.mjs` and `node web/visual/checks/confirm-focus.mjs` print ok.
- [ ] Use superpowers:finishing-a-development-branch.
