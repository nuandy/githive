// What the regression check captures: every page and tab from fixtures, states reached by a click, and the Hive tab
// from the playground at fixed points of fixed runs, with its motions frame by frame.
//
// Scenes find things by role and accessible name, not by class, so they keep working while the markup's classes
// change underneath them.

import type { Page } from "playwright-core";
import type { Who } from "./fixtures.ts";
import { FIXED_NOW } from "./fixtures/clock.ts";

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
	(name: string | RegExp, role: "button" | "link" | "radio" = "button") =>
	async (p: Page) => {
		await p.getByRole(role, { name }).first().click();
	};
const openSummary = (text: string) => async (p: Page) => {
	await p.locator("summary", { hasText: text }).first().click();
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
 * loads again to ask. */
const answering =
	(path: string, body: unknown, { status = 200, method = "GET" } = {}) =>
	async (p: Page) => {
		await p.route(`**${path}`, (route) =>
			route.request().method() === method
				? route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) })
				: route.fallback(),
		);
		if (method === "GET") await p.reload();
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

const APP: Scene[] = [
	page("repos", "/"),
	page("repos-menu", "/", { act: openUserMenu }),
	page("repos-search", "/", { act: fill("Find a repository", "acme") }),
	page("repos-search-none", "/", { act: fill("Find a repository", "zzz") }),
	page("repos-empty", "/", { act: answering("/summaries", { repos: [] }) }),
	page("repos-demo-running", "/", {
		act: answering("/demo/runs", { running: { fullName: "acme/storefront" }, newest: LANDED_RUN }),
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
	page("new-repo-bad-name", "/new", { act: fill(/^Name/, "my project") }),
	page("new-repo-error", "/new", {
		act: steps(
			answering("/repos", { error: "robin/widgets exists already" }, { status: 409, method: "POST" }),
			fill(/^Name/, "widgets"),
			fill("Git URL", "https://github.com/octocat/Spoon-Knife"),
			click("Make repository"),
		),
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
	page("org-fieldnotes", "/orgs/fieldnotes"),
	page("org-robin", "/orgs/robin"),
	page("agents", "/settings/agents"),
	page("agents-confirm", "/settings/agents", { act: click("Revoke") }),
	page("admin", "/admin", { who: "operator" }),
	page("admin-confirm", "/admin", { who: "operator", act: click("Remove") }),
	page("not-found", "/nope/nothing"),
	page("theme-menu", "/", { act: async (p) => p.getByRole("button", { name: /^Theme:/ }).click() }),
	// A choice against the system's: these match repos.dark and repos.light.
	page("theme-dark-chosen", "/", { storage: { "githive.theme": "dark" }, schemes: ["light"] }),
	page("theme-light-chosen", "/", { storage: { "githive.theme": "light" }, schemes: ["dark"] }),

	page("storefront-hive", STOREFRONT),
	page("storefront-hive-row", STOREFRONT, {
		act: async (p) => p.locator('section[aria-labelledby="goals-title"] button[aria-expanded="false"]').first().click(),
	}),
	page("storefront-hive-timeline", STOREFRONT, { storage: { "githive.hive.view": "timeline" } }),
	// The demo run's banner, as on the demo repo's Hive tab.
	page("storefront-hive-demo", STOREFRONT, { act: answering("/demo/runs/acme/storefront", LANDED_RUN) }),
	page("storefront-changes", `${STOREFRONT}/changes`),
	page("storefront-changes-release", `${STOREFRONT}/changes?branch=release%2F2.4`),
	page("storefront-history", `${STOREFRONT}/history`),
	page("storefront-claims", `${STOREFRONT}/claims`),
	// The account menu open over the Claims tab: what its baselines show, as the first <summary> on the page, which
	// it clicked, was the menu's while the menu was a <details>.
	page("storefront-claims-open", `${STOREFRONT}/claims`, { act: openUserMenu }),
	// A folder of the claims tree opened.
	page("storefront-claims-tree", `${STOREFRONT}/claims`, {
		act: async (p) => p.locator("main summary").first().click(),
	}),
	page("storefront-code", `${STOREFRONT}/code`),
	page("storefront-code-folder", `${STOREFRONT}/code/src/lib`),
	page("storefront-code-file", `${STOREFRONT}/code/src/lib/cart.ts`),
	page("storefront-code-readme", `${STOREFRONT}/code/README.md`),
	page("storefront-code-image", `${STOREFRONT}/code/public/images/placeholder.png`),
	page("storefront-code-lockfile", `${STOREFRONT}/code/package-lock.json`),
	page("storefront-agents", `${STOREFRONT}/agents`),
	page("storefront-settings", `${STOREFRONT}/settings`),
	page("storefront-settings-checks", `${STOREFRONT}/settings`, { act: openSummary("What the checks run in") }),
	page("storefront-settings-confirm", `${STOREFRONT}/settings`, {
		act: async (p) =>
			p
				.locator('[aria-labelledby="repo-collaborators"]')
				.getByRole("button", { name: "Remove", exact: true })
				.first()
				.click(),
	}),
	page("storefront-audit", `${STOREFRONT}/audit`),
	...CHANGES.map((change) => page(`change-${change}`, `${STOREFRONT}/changes/${change}`)),
	page("change-checkout-tax-commits", `${STOREFRONT}/changes/checkout-tax/commits`),
	page("change-cart-coupons-commits", `${STOREFRONT}/changes/cart-coupons/commits`, { act: openSummary("More") }),
	page("change-session-cookies-evidence", `${STOREFRONT}/changes/session-cookies`, { act: openSummary("Evidence") }),

	page("docs-hive", "/repos/acme/docs"),
	page("docs-history", "/repos/acme/docs/history"),
	page("notes-hive", "/repos/robin/notes"),
	page("new-thing-hive", "/repos/acme/new-thing"),
	page("new-thing-code", "/repos/acme/new-thing/code"),
	page("new-thing-settings", "/repos/acme/new-thing/settings"),
	page("tiny-lib-hive", "/repos/oss-friend/tiny-lib"),
	page("tiny-lib-settings", "/repos/oss-friend/tiny-lib/settings"),
	page("tiny-lib-code", "/repos/oss-friend/tiny-lib/code"),

	page("visitor-home", "/", { who: "visitor" }),
	page("visitor-storefront", STOREFRONT, { who: "visitor" }),
	page("visitor-change", `${STOREFRONT}/changes/stock-sync`, { who: "visitor" }),
	page("visitor-private", "/repos/acme/docs", { who: "visitor" }),
	page("visitor-sign-in", STOREFRONT, { who: "visitor", act: click("Sign in") }),
	{ name: "visitor-sign-in-failed", url: "/?signin_error=not-invited#/", who: "visitor" },
];

export const SCENES: Scene[] = [...APP, ...HIVE];
