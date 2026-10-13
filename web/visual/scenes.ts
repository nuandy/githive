// What the regression check captures: every page and tab from fixtures, states reached by a click, and the Hive tab
// from the playground at fixed points of fixed runs, with its motions frame by frame.
//
// Scenes find things by role and accessible name, not by class, so they keep working while the markup's classes
// change underneath them.

import type { Page } from "playwright-core";
import type { Who } from "./fixtures.ts";
import { AGENTS, CONNECTIONS, NEW_CONNECTION, NEW_TOKEN } from "./fixtures/account.ts";
import { FIXED_NOW } from "./fixtures/clock.ts";
import { DOCS_REPO } from "./fixtures/small-repos.ts";
import { STOREFRONT as STOREFRONT_REPO } from "./fixtures/storefront.ts";

export type Scheme = "light" | "dark";

export interface Scene {
	name: string;
	/** Path and hash on the dev server. */
	url: string;
	/** Signed in as the fixtures' admin (default), signed out, or an Access operator (who alone sees #/admin). */
	who?: Who;
	/** "fixed": Date.now() is frozen and timers run (default). "paused": every clock is stopped until a scene runs it. */
	clock?: "fixed" | "paused";
	/** What to do once the page has settled, before capturing. */
	act?: (page: Page) => Promise<void>;
	/** Capture a motion instead of a still: what starts it, and the times (ms into it) to capture. */
	motion?: { trigger: (page: Page) => Promise<void>; at: number[]; clip?: string };
	widths?: number[];
	schemes?: Scheme[];
	height?: number;
	/** localStorage entries set before the page loads. */
	storage?: Record<string, string>;
}

const MINUTE = 60_000;
const SPEED = 5;

/** Plays a playground run for `minutes` of its virtual time, pauses it, then lets the page's own timers settle. */
async function playFor(page: Page, minutes: number) {
	if (minutes > 0) await page.clock.runFor((minutes * MINUTE) / SPEED);
	await page.getByRole("button", { name: "Pause", exact: true }).click();
	await page.clock.runFor(90_000);
}

const goals = (page: Page) => page.locator('section[aria-labelledby="goals-title"]');
const firstRow = (page: Page) => goals(page).locator('button[aria-expanded="false"]').first();
const viewButton = (page: Page, name: "Story" | "Timeline") => goals(page).getByRole("button", { name, exact: true });

function playground(
	name: string,
	scenario: string,
	seed: number,
	minutes: number,
	more: Partial<Scene> & { then?: (page: Page) => Promise<void> } = {},
): Scene {
	const { then, ...rest } = more;
	return {
		name: `hive-${name}`,
		url: `/playground.html?scenario=${scenario}&seed=${seed}&speed=${SPEED}`,
		clock: "paused",
		height: 1000,
		act: async (page) => {
			await playFor(page, minutes);
			if (then) {
				await then(page);
				await page.clock.runFor(2_000);
			}
		},
		...rest,
	};
}

/** A motion in the playground: the run played to a point, then `trigger`, captured at `at`. */
function motion(
	name: string,
	scenario: string,
	minutes: number,
	trigger: (page: Page) => Promise<void>,
	at: number[],
	setup?: (page: Page) => Promise<void>,
): Scene {
	return {
		name: `motion-${name}`,
		url: `/playground.html?scenario=${scenario}&seed=1&speed=${SPEED}`,
		clock: "paused",
		height: 1000,
		widths: [1280],
		schemes: ["light"],
		act: async (page) => {
			await playFor(page, minutes);
			if (setup) {
				await setup(page);
				await page.clock.runFor(2_000);
			}
		},
		motion: { trigger, at },
	};
}

const STEP_FRAMES = [0, 80, 160, 240, 320, 450, 600, 900];
const step = (page: Page) => page.getByRole("button", { name: "Step", exact: true }).click();

const HIVE: Scene[] = [
	playground("mixed", "mixed", 1, 0),
	playground("mixed-later", "mixed", 1, 4),
	playground("mixed-row", "mixed", 1, 2, { then: (page) => firstRow(page).click() }),
	playground("mixed-timeline", "mixed", 1, 2, { then: (page) => viewButton(page, "Timeline").click() }),
	// The narrow layout, in a window as wide as the playground's narrow view (its iframe settles too unevenly to compare).
	playground("mixed-720", "mixed", 1, 2, { widths: [720] }),
	playground("big-720", "big-repo", 1, 4, { widths: [720] }),
	playground("swarm", "swarm", 2, 3),
	playground("quiet", "quiet-burst", 1, 0),
	playground("quiet-later", "quiet-burst", 1, 6),
	playground("first-empty", "first-agent", 1, 0),
	playground("first", "first-agent", 1, 3),
	playground("big", "big-repo", 1, 4),
	playground("big-timeline", "big-repo", 1, 4, { then: (page) => viewButton(page, "Timeline").click() }),
	// A cell's details, opened by a click beside it.
	playground("mixed-cell", "mixed", 1, 2, {
		then: (page) =>
			page
				.getByRole("button", { name: /: building, / })
				.first()
				.click(),
	}),
	// The map from the keyboard: one stop, the arrow keys from cell to cell, its ring on the cell reached.
	playground("mixed-map-keys", "mixed", 1, 2, {
		then: async (page) => {
			await page
				.getByRole("button", { name: /: building, / })
				.first()
				.focus();
			await page.keyboard.press("ArrowRight");
			await page.keyboard.press("ArrowDown");
		},
	}),
	// Reading a goal while the hive moves on: the rows hold still and "4 new · 5 finished" waits in the heading.
	playground("mixed-held", "mixed", 1, 2, {
		then: async (page) => {
			await firstRow(page).click();
			await page.getByRole("button", { name: "Skip 10 min", exact: true }).click();
		},
	}),

	motion("drawer-open", "mixed", 2, (page) => firstRow(page).click(), [0, 60, 120, 180, 240, 320]),
	motion(
		"drawer-close",
		"mixed",
		2,
		(page) => goals(page).locator('button[aria-expanded="true"]').first().click(),
		[0, 60, 120, 180, 240],
		(page) => firstRow(page).click(),
	),
	motion("to-timeline", "mixed", 2, (page) => viewButton(page, "Timeline").click(), [0, 100, 200, 300, 450]),
	motion("step-mixed-1", "mixed", 2, step, STEP_FRAMES),
	motion("step-mixed-2", "mixed", 3, step, STEP_FRAMES),
	motion("step-swarm", "swarm", 3, step, STEP_FRAMES),
	motion("step-big", "big-repo", 4, step, STEP_FRAMES),
	motion("first-arrives", "first-agent", 0, step, STEP_FRAMES),
	motion("step-timeline", "mixed", 2, step, STEP_FRAMES, (page) => viewButton(page, "Timeline").click()),
];

/** A page of the dashboard itself. */
const page = (name: string, hash: string, more: Partial<Scene> = {}): Scene => ({
	name,
	url: `/#${hash}`,
	...more,
});

const click =
	(name: string | RegExp, role: "button" | "link" | "radio" | "menuitem" = "button") =>
	async (p: Page) => {
		await p.getByRole(role, { name }).first().click();
	};
const openSummary = (text: string) => async (p: Page) => {
	await p.locator("summary", { hasText: text }).first().click();
};
const removeCollaborator = async (p: Page) => {
	await p
		.locator('[aria-labelledby="repo-collaborators"]')
		.getByRole("button", { name: "Remove", exact: true })
		.first()
		.click();
};
const openUserMenu = async (p: Page) => {
	await p.getByRole("button", { name: /^Signed in as/ }).click();
};
const fill = (label: string | RegExp, text: string) => async (p: Page) => {
	await p.getByLabel(label).first().fill(text);
};
const steps =
	(...each: ((p: Page) => Promise<void>)[]) =>
	async (p: Page) => {
		for (const step of each) await step(p);
	};

/** From here on, `method` requests to `path` get `body` (what the fixtures don't hold); then, for a GET, the page
 * loads again to ask, unless told not to (`reload: false`, for what the page asks again on its own). */
const answering =
	(path: string, body: unknown, { status = 200, method = "GET", reload = true } = {}) =>
	async (p: Page) => {
		await p.route(`**${path}`, (route) =>
			route.request().method() === method
				? route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
				: route.fallback(),
		);
		if (method === "GET" && reload) await p.reload();
	};

/** A demo run on acme/storefront, finished with every piece landed, so there's a game to play. */
const LANDED_RUN = {
	id: "run-3",
	number: 3,
	fullName: "acme/storefront",
	by: "robin",
	startedAt: FIXED_NOW - 20 * 60_000,
	endedAt: FIXED_NOW - 60_000,
	status: "done",
	pieces: 1,
	agents: [
		{ name: "githive-forager", finished: [{ piece: "board", at: FIXED_NOW - 60_000 }], reviewed: 0, done: true },
	],
};

const STOREFRONT = "/repos/acme/storefront";
const CHANGES = [
	"stock-sync",
	"cart-coupons",
	"checkout-tax",
	"session-cookies",
	"product-reviews",
	"refund-webhook",
	"dark-mode-tokens",
	"hero-banner",
	"wishlist",
	"currency-rounding",
	"a11y-header",
	"newsletter-popup",
	"gift-wrap",
	"og-images",
	"search-facets",
	"sitemap-script",
	"price-format",
	"footer-links",
];

/** acme/storefront's tree grown past what one read holds: more files in src/, hundreds in assets/, cut short. */
const BIG_TREE = {
	ref: "main",
	commit: STOREFRONT_REPO.heads.main,
	files: [
		...STOREFRONT_REPO.files,
		...Array.from({ length: 10 }, (_, i) => `src/feature-${String(i + 1).padStart(2, "0")}.ts`),
		...Array.from({ length: 420 }, (_, i) => `assets/icon-${String(i + 1).padStart(3, "0")}.svg`),
	].sort(),
	truncated: true,
};

/** acme/storefront with one change claiming all of docs/. */
const WHOLE_FOLDER = {
	...STOREFRONT_REPO.hive!.snapshot,
	claims: STOREFRONT_REPO.hive!.snapshot.claims.map((claim) =>
		claim.change === "footer-links" ? { ...claim, paths: ["docs/"] } : claim,
	),
};

const DOCS_HISTORY = DOCS_REPO.hive!.histories.main!;

/** acme/docs's history with its two newest changes landed in one batch, as the server notes one time for a batch. */
const DOCS_BATCH = {
	...DOCS_HISTORY,
	changes: DOCS_HISTORY.changes.map((change, index) =>
		index === 1 ? { ...change, at: DOCS_HISTORY.changes[0]!.at } : change,
	),
};

const APP: Scene[] = [
	page("repos", "/"),
	page("repos-menu", "/", { act: openUserMenu }),
	page("repos-search", "/", { act: fill("Find a repository", "acme") }),
	page("repos-search-none", "/", { act: fill("Find a repository", "zzz") }),
	page("repos-empty", "/", { act: answering("/summaries", { repos: [] }) }),
	page("repos-demo-running", "/", {
		act: answering("/demo/runs", { running: { fullName: "acme/storefront" }, newest: LANDED_RUN }),
	}),
	// A new account: no repos, no agents. Get started leads, the demo card is prominent.
	page("repos-get-started", "/", {
		act: steps(answering("/me/agents", []), answering("/me/connections", []), answering("/summaries", { repos: [] })),
	}),
	// A first repo, an agent connected and its first claim: three steps ticked, the landing next.
	page("repos-get-started-claimed", "/", {
		act: steps(
			answering("/me/agents", []),
			answering("/summaries", {
				repos: [
					{
						repo: "robin/widgets",
						since: new Date(FIXED_NOW - 60 * 60_000).toISOString(),
						summary: {
							open: 1,
							needsYou: 0,
							merged: 0,
							violations: 0,
							lastActivity: new Date(FIXED_NOW).toISOString(),
						},
					},
				],
			}),
		),
	}),
	// A demo run starting: how long so far, and how long it can take.
	page("repos-demo-setting-up", "/", {
		act: steps(
			answering("/demo/runs", { id: "run-9", repo: "acme/storefront" }, { status: 201, method: "POST" }),
			answering("/demo/runs", {
				running: null,
				recent: [],
				newest: { ...LANDED_RUN, id: "run-9", status: "running", settingUp: true },
			}),
			click("Start a demo run"),
		),
	}),
	// A run refused because another started first: the card offers that one to watch.
	page("repos-demo-refused", "/", {
		act: async (p) => {
			let refused = false;
			await p.route("**/demo/runs", (route) => {
				const post = route.request().method() === "POST";
				if (post) refused = true;
				const body = post
					? { error: "a demo run is going already: watch it at acme/storefront" }
					: { running: refused ? { fullName: "acme/storefront" } : null, recent: [], newest: null };
				return route.fulfill({ status: post ? 429 : 200, contentType: "application/json", body: JSON.stringify(body) });
			});
			await p.reload();
			await click("Start a demo run")(p);
		},
	}),
	page("repos-demo-error", "/", {
		act: steps(
			answering("/demo/runs", { error: "another demo run is going" }, { status: 409, method: "POST" }),
			click("Start a demo run"),
		),
	}),
	page("new-repo", "/new"),
	page("new-repo-org", "/new?owner=acme"),
	page("new-repo-copy", "/new", { act: click(/A copy of a repository here/, "radio") }),
	page("new-repo-fresh", "/new", { act: click(/Start fresh/, "radio") }),
	page("new-repo-import", "/new", { act: steps(fill(/^Name/, "widgets"), click(/A Git repository/, "radio")) }),
	page("new-repo-bad-name", "/new", { act: fill(/^Name/, "my project") }),
	// A name that's taken: said under the name, with a link to the one there.
	page("new-repo-error", "/new", {
		act: steps(
			answering("/repos", { error: "robin/widgets exists" }, { status: 409, method: "POST" }),
			fill(/^Name/, "widgets"),
			click(/A Git repository/, "radio"),
			fill("Git URL", "https://github.com/octocat/Spoon-Knife"),
			click("Make repository"),
		),
	}),
	// An import that failed: said under its URL.
	page("new-repo-import-error", "/new", {
		act: steps(
			answering("/repos", { error: "the repository has no branch to import" }, { status: 400, method: "POST" }),
			fill(/^Name/, "widgets"),
			click(/A Git repository/, "radio"),
			fill("Git URL", "https://github.com/octocat/Spoon-Knife"),
			click("Make repository"),
		),
	}),
	// A name too long, said once the field is left.
	page("new-repo-long-name", "/new", {
		act: steps(fill(/^Name/, "x".repeat(104)), async (p) => p.getByLabel(/^Name/).first().blur()),
	}),
	page("inbox", "/inbox"),
	page("orgs", "/orgs"),
	page("orgs-new", "/orgs", { act: fill("Name in URLs", "acme-labs") }),
	page("orgs-bad-slug", "/orgs", { act: fill("Name in URLs", "-acme") }),
	page("orgs-error", "/orgs", {
		act: steps(
			answering("/orgs", { error: "acme-labs is taken" }, { status: 409, method: "POST" }),
			fill("Name in URLs", "acme-labs"),
			click("Create organization"),
		),
	}),
	page("org-acme", "/orgs/acme"),
	page("org-acme-confirm", "/orgs/acme", { act: click("Remove") }),
	page("org-acme-team-confirm", "/orgs/acme", { act: click("Delete team") }),
	// Making devon an owner asks first.
	page("org-acme-promote", "/orgs/acme", {
		act: async (p) => {
			await p.locator("#role-devon").selectOption("owner");
		},
	}),
	// A role changed says Saved.
	page("org-acme-role-saved", "/orgs/acme", {
		act: async (p) => {
			await p.locator("#role-mara").selectOption("member");
		},
	}),
	// Taken off a team, with Undo.
	page("org-acme-team-undo", "/orgs/acme", { act: click("Take devon off @acme/payments") }),
	page("org-acme-invite-undo", "/orgs/acme", {
		act: steps(click("Cancel invitation"), click("Yes, cancel invitation")),
	}),
	page("org-fieldnotes", "/orgs/fieldnotes"),
	page("org-robin", "/orgs/robin"),
	page("agents", "/settings/agents"),
	// Revoking an agent from its ⋯ menu, asked in a dialog.
	page("agents-confirm", "/settings/agents", {
		act: steps(click("More for robin/builder"), async (p) => p.getByRole("menuitem", { name: /Revoke agent/ }).click()),
	}),
	// An agent's tokens unfolded, and the revoked agents.
	page("agents-tokens", "/settings/agents", { act: steps(openSummary("Tokens (2)"), openSummary("Revoked (1)")) }),
	page("agents-new-token", "/settings/agents", { act: steps(openSummary("Tokens (2)"), click("New token…")) }),
	page("agents-token-made", "/settings/agents", {
		act: steps(
			answering(`/me/agents/${AGENTS[0]!.id}/tokens`, NEW_TOKEN, { method: "POST" }),
			openSummary("Tokens (2)"),
			click("New token…"),
			click("Make token"),
		),
	}),
	// Closing the new token before copying it asks first.
	page("agents-token-uncopied", "/settings/agents", {
		act: steps(
			answering(`/me/agents/${AGENTS[0]!.id}/tokens`, NEW_TOKEN, { method: "POST" }),
			openSummary("Tokens (2)"),
			click("New token…"),
			click("Make token"),
			click("Done"),
		),
	}),
	// The Claude Code command copied, and a new connection found at the next look.
	page("agents-connected", "/settings/agents", {
		act: steps(
			click("Copy"),
			answering("/me/connections", [...CONNECTIONS, NEW_CONNECTION], { reload: false }),
			async (p) => p.waitForTimeout(4_000),
		),
	}),
	page("admin", "/admin", { who: "operator" }),
	page("admin-confirm", "/admin", { who: "operator", act: click("Remove") }),
	page("not-found", "/nope/nothing"),
	page("theme-menu", "/", { act: async (p) => p.getByRole("button", { name: /^Theme:/ }).click() }),
	// On a phone, light and dark are in the user menu.
	page("repos-menu-narrow", "/", { widths: [390], act: openUserMenu }),
	// The keyboard: the ⌘K palette, typed into, and the list of shortcuts.
	page("palette", STOREFRONT, { act: async (p) => p.keyboard.press("Control+k") }),
	page("palette-typed", STOREFRONT, {
		act: async (p) => {
			await p.keyboard.press("Control+k");
			await p.keyboard.type("docs");
		},
	}),
	page("shortcuts", "/", { act: async (p) => p.keyboard.press("?") }),
	// A choice against the system's: these match repos.dark and repos.light.
	page("theme-dark-chosen", "/", { storage: { "githive.theme": "dark" }, schemes: ["light"] }),
	page("theme-light-chosen", "/", { storage: { "githive.theme": "light" }, schemes: ["dark"] }),

	page("storefront-hive", STOREFRONT),
	// The repo crumb's switcher, and on a phone the header's ⋯ menu.
	page("storefront-switcher", STOREFRONT, { act: click(/switch repository/) }),
	page("storefront-header-menu", STOREFRONT, { widths: [390], act: click("More for acme/storefront") }),
	page("storefront-hive-row", STOREFRONT, {
		act: async (p) => p.locator('section[aria-labelledby="goals-title"] button[aria-expanded="false"]').first().click(),
	}),
	page("storefront-hive-timeline", STOREFRONT, { storage: { "githive.hive.view": "timeline" } }),
	// What needs a person, as rows; the first question's tooltip says it in full.
	page("storefront-hive-needs", STOREFRONT, {
		act: async (p) =>
			p.getByRole("region", { name: "Needs a person" }).getByRole("listitem").first().locator("[tabindex]").hover(),
	}),
	// A link that opens the Hive as someone left it: six hours, Timeline, one agent's goals, a row open.
	page("storefront-hive-linked", `${STOREFRONT}?window=6h&view=timeline&agent=mara%2Fclaude&row=stock-sync`),
	// The demo run's banner, as on the demo repo's Hive tab.
	page("storefront-hive-demo", STOREFRONT, { act: answering("/demo/runs/acme/storefront", LANDED_RUN) }),
	page("storefront-changes", `${STOREFRONT}/changes`),
	// The list narrowed by a chip, and by a search.
	page("storefront-changes-needs-you", `${STOREFRONT}/changes?filter=needs-you`),
	page("storefront-changes-search", `${STOREFRONT}/changes`, { act: fill("Find a change", "cart") }),
	page("storefront-changes-none", `${STOREFRONT}/changes?filter=building`, { act: fill("Find a change", "zzz") }),
	page("storefront-changes-release", `${STOREFRONT}/changes?branch=release%2F2.4`),
	page("storefront-changes-unknown-branch", `${STOREFRONT}/changes?branch=nope`),
	page("storefront-changes-new-branch", `${STOREFRONT}/changes`, { act: click("New branch") }),
	page("storefront-changes-new-branch-error", `${STOREFRONT}/changes`, {
		act: steps(
			answering(`${STOREFRONT}/branches`, { error: "release/2.4 exists already" }, { status: 409, method: "POST" }),
			click("New branch"),
			fill("Name of the new branch", "release/2.4"),
			click("Make branch"),
		),
	}),
	page("storefront-history", `${STOREFRONT}/history`),
	// A change's files opened from its count.
	page("storefront-history-files", `${STOREFRONT}/history`, { act: click(/^\d+ files?$/) }),
	page("storefront-claims", `${STOREFRONT}/claims`),
	page("storefront-claims-tree-error", `${STOREFRONT}/claims`, {
		act: answering(`${STOREFRONT}/tree`, { error: "the tree is too big to read" }, { status: 500 }),
	}),
	page("storefront-claims-big-tree", `${STOREFRONT}/claims`, {
		act: steps(answering(`${STOREFRONT}/tree`, BIG_TREE), answering(STOREFRONT, WHOLE_FOLDER)),
	}),
	// The account menu open over the Claims tab: what its baselines show, as the first <summary> on the page, which
	// it clicked, was the menu's while the menu was a <details>.
	page("storefront-claims-open", `${STOREFRONT}/claims`, { act: openUserMenu }),
	// Every file, not only what's claimed.
	page("storefront-claims-all", `${STOREFRONT}/claims`, { act: async (p) => p.getByLabel("Only claimed").uncheck() }),
	page("storefront-code", `${STOREFRONT}/code`),
	page("storefront-code-folder", `${STOREFRONT}/code/src/lib`),
	page("storefront-code-file", `${STOREFRONT}/code/src/lib/cart.ts`),
	// A README formatted, and its source; a file another change holds, in its syntax colors; the branches to show.
	page("storefront-code-readme", `${STOREFRONT}/code/README.md`),
	page("storefront-code-readme-source", `${STOREFRONT}/code/README.md`, { act: click("Source") }),
	page("storefront-code-branches", `${STOREFRONT}/code/src/lib/cart.ts`, { act: click(/^Branch: /) }),
	page("storefront-code-image", `${STOREFRONT}/code/public/images/placeholder.png`),
	page("storefront-code-lockfile", `${STOREFRONT}/code/package-lock.json`),
	page("storefront-agents", `${STOREFRONT}/agents`),
	// Settings, a page per section.
	page("storefront-settings", `${STOREFRONT}/settings`),
	page("storefront-settings-records", `${STOREFRONT}/settings`, { act: openSummary("How the records are kept") }),
	...(["review", "path-rules", "branch-rules", "checks", "github", "danger-zone"] as const).map((section) =>
		page(`storefront-settings-${section}`, `${STOREFRONT}/settings/${section}`),
	),
	page("storefront-settings-checks-environment", `${STOREFRONT}/settings/checks`, {
		act: openSummary("What the checks run in"),
	}),
	page("storefront-settings-confirm", `${STOREFRONT}/settings`, { act: removeCollaborator }),
	// The collaborator removed: a line offers Undo.
	page("storefront-settings-undo", `${STOREFRONT}/settings`, {
		act: steps(removeCollaborator, click("Yes, remove")),
	}),
	// Edits not saved: a dot by Review in the nav, and its save bar ready.
	page("storefront-settings-review-dirty", `${STOREFRONT}/settings/review`, {
		act: steps(fill("Required approvals", "3"), async (p) => {
			await p.locator("#settings-vetoes").fill("privacy,");
			await p.keyboard.press("Escape");
		}),
	}),
	// Roles offered as you type.
	page("storefront-settings-review-typeahead", `${STOREFRONT}/settings/review`, {
		act: async (p) => {
			await p.locator("#settings-vetoes").click();
			await p.keyboard.type("f");
		},
	}),
	// A save with a rule naming no paths: the problem under its field, and in the save bar.
	page("storefront-settings-path-rules-problem", `${STOREFRONT}/settings/path-rules`, {
		act: steps(click("Add a rule"), click("Save")),
	}),
	page("storefront-settings-github-change", `${STOREFRONT}/settings/github`, { act: click("Change…") }),
	page("storefront-settings-github-disconnect", `${STOREFRONT}/settings/github`, { act: click("Disconnect") }),
	page("storefront-settings-delete", `${STOREFRONT}/settings/danger-zone`, {
		act: steps(click("Delete repository…"), fill(/^Type/, "acme/storefront")),
	}),
	page("storefront-audit", `${STOREFRONT}/audit`),
	// The audit not read yet: here, never.
	page("storefront-audit-loading", `${STOREFRONT}/audit`, {
		act: answering(`${STOREFRONT}/audit`, { error: "the records couldn't be replayed" }, { status: 500 }),
	}),
	...CHANGES.map((change) => page(`change-${change}`, `${STOREFRONT}/changes/${change}`)),
	page("change-checkout-tax-commits", `${STOREFRONT}/changes/checkout-tax/commits`),
	page("change-wishlist-commits", `${STOREFRONT}/changes/wishlist/commits`),
	page("change-cart-coupons-commits", `${STOREFRONT}/changes/cart-coupons/commits`, { act: openSummary("More") }),
	page("change-session-cookies-evidence", `${STOREFRONT}/changes/session-cookies`, { act: openSummary("Evidence") }),
	// The Files tab: a file outside the claim, a long test folded, a binary image; one file asked for by the address.
	page("change-checkout-tax-files", `${STOREFRONT}/changes/checkout-tax/files`),
	page("change-cart-coupons-files", `${STOREFRONT}/changes/cart-coupons/files`),
	page("change-hero-banner-files", `${STOREFRONT}/changes/hero-banner/files/src/pages/Home.tsx`),
	page("change-og-images-files", `${STOREFRONT}/changes/og-images/files`),
	// Deciding: Land now's confirm, the release dialog, and the agent's commands unfolded in the Conflict panel.
	page("change-checkout-tax-land", `${STOREFRONT}/changes/checkout-tax`, { act: click("Land now") }),
	page("change-stock-sync-release", `${STOREFRONT}/changes/stock-sync`, {
		act: steps(click("More about this change"), click("Release claim…", "menuitem")),
	}),
	page("change-og-images-release", `${STOREFRONT}/changes/og-images`, { act: click("Release claim…") }),
	page("change-hero-banner-commands", `${STOREFRONT}/changes/hero-banner`, {
		act: openSummary("What the agent will do"),
	}),

	page("docs-hive", "/repos/acme/docs"),
	page("docs-history", "/repos/acme/docs/history"),
	page("docs-history-batch", "/repos/acme/docs/history", {
		act: answering("/repos/acme/docs/history?branch=main", DOCS_BATCH),
	}),
	page("docs-history-more", "/repos/acme/docs/history", {
		act: answering("/repos/acme/docs/history?branch=main", { ...DOCS_HISTORY, total: DOCS_HISTORY.total + 12 }),
	}),
	page("docs-history-empty", "/repos/acme/docs/history", {
		act: answering("/repos/acme/docs/history?branch=main", { branch: "main", total: 0, changes: [] }),
	}),
	page("docs-history-error", "/repos/acme/docs/history", {
		act: answering("/repos/acme/docs/history?branch=main", { error: "offline" }, { status: 500 }),
	}),
	page("docs-changes", "/repos/acme/docs/changes"),
	// No violations and no reviews yet.
	page("docs-audit-quiet", "/repos/acme/docs/audit", {
		act: answering("/repos/acme/docs", { ...DOCS_REPO.hive!.snapshot, votes: [] }),
	}),
	page("notes-hive", "/repos/robin/notes"),
	page("new-thing-hive", "/repos/acme/new-thing"),
	page("new-thing-code", "/repos/acme/new-thing/code"),
	page("new-thing-settings", "/repos/acme/new-thing/settings"),
	page("new-thing-settings-danger-zone", "/repos/acme/new-thing/settings/danger-zone"),
	page("tiny-lib-hive", "/repos/oss-friend/tiny-lib"),
	page("tiny-lib-settings", "/repos/oss-friend/tiny-lib/settings"),
	page("tiny-lib-code", "/repos/oss-friend/tiny-lib/code"),

	page("visitor-home", "/", { who: "visitor" }),
	page("visitor-storefront", STOREFRONT, { who: "visitor" }),
	page("visitor-change", `${STOREFRONT}/changes/stock-sync`, { who: "visitor" }),
	page("visitor-private", "/repos/acme/docs", { who: "visitor" }),
	page("visitor-sign-in", STOREFRONT, { who: "visitor", act: click("Sign in") }),
	{ name: "visitor-sign-in-failed", url: "/?signin_error=not-invited#/", who: "visitor" },
	// A request to join, noted under the account the server sent back in the fragment.
	{
		name: "visitor-sign-in-requested",
		url: "/?signin_error=not-invited#signin-as=taylor%40mail.example",
		who: "visitor",
	},
	// A session that ends while a repo is open: the next read answers 401, and the sign-in screen says so.
	page("session-ended", STOREFRONT, {
		act: async (p) => {
			const ended = { status: 401, contentType: "application/json", body: JSON.stringify({ error: "signed out" }) };
			await p.route("**/repos/**", (route) => route.fulfill(ended));
			await p.waitForTimeout(6_000);
		},
	}),
];

export const SCENES: Scene[] = [...APP, ...HIVE];
