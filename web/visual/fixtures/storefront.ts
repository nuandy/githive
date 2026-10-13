import type { ChangeAwareness, HiveStatus, RepoAudit, RepoSnapshot } from "../../src/api.ts";
import { DEFAULT_SKIP_CHECKS } from "../../../src/toolkit/check-scope.ts";
import { DAY_MINUTES, ago, agoMs, daysAgo } from "./clock.ts";
import { sha } from "./ids.ts";
import { PEOPLE, ROBIN } from "./people.ts";
import { type RepoFixture, landingOf, summaryOf } from "./repo.ts";
import { type Story, buildHive, landedLongAgo, mergeCommit, snapshotVotes } from "./stories.ts";

// acme/storefront: a busy public repo, with a change in every state the dashboard knows how to show.

const REPO = "acme/storefront";
const GUARD = "githive-guard";
const day = (days: number, minutes = 0) => days * DAY_MINUTES + minutes;

const FILES = [
	".github/workflows/ci.yml",
	".gitignore",
	".prettierrc",
	"LICENSE",
	"README.md",
	"docs/architecture.md",
	"docs/checkout-flow.md",
	"docs/deploying.md",
	"package-lock.json",
	"package.json",
	"public/favicon.ico",
	"public/images/hero.webp",
	"public/images/placeholder.png",
	"public/robots.txt",
	"scripts/build-sitemap.ts",
	"scripts/seed.ts",
	"src/App.tsx",
	"src/auth/login.ts",
	"src/auth/rateLimit.ts",
	"src/auth/tokens.ts",
	"src/components/Button.tsx",
	"src/components/CartDrawer.tsx",
	"src/components/Footer.tsx",
	"src/components/Header.tsx",
	"src/components/PriceTag.tsx",
	"src/components/ProductCard.tsx",
	"src/components/ProductGrid.tsx",
	"src/components/Rating.tsx",
	"src/components/SearchBox.tsx",
	"src/components/checkout/AddressForm.tsx",
	"src/components/checkout/OrderSummary.tsx",
	"src/components/checkout/PaymentForm.tsx",
	"src/components/checkout/ShippingOptions.tsx",
	"src/i18n/de.json",
	"src/i18n/en.json",
	"src/i18n/fr.json",
	"src/lib/analytics.ts",
	"src/lib/api.ts",
	"src/lib/cart.ts",
	"src/lib/currency.ts",
	"src/lib/format.ts",
	"src/lib/inventory.ts",
	"src/lib/search.ts",
	"src/lib/session.ts",
	"src/lib/theme.ts",
	"src/main.tsx",
	"src/pages/Account.tsx",
	"src/pages/Cart.tsx",
	"src/pages/Category.tsx",
	"src/pages/Checkout.tsx",
	"src/pages/Home.tsx",
	"src/pages/NotFound.tsx",
	"src/pages/Product.tsx",
	"src/payments/refunds.ts",
	"src/payments/stripe.ts",
	"src/payments/webhooks.ts",
	"src/routes.ts",
	"src/styles/global.css",
	"src/styles/tokens.css",
	"test/cart.test.ts",
	"test/checkout.test.ts",
	"test/currency.test.ts",
	"test/e2e/checkout.spec.ts",
	"test/fixtures/products.json",
	"test/payments.test.ts",
	"test/search.test.ts",
	"tsconfig.json",
	"vite.config.ts",
].sort();

const policy: RepoSnapshot["policy"] = {
	required: 2,
	vetoes: ["security"],
	escalate: [{ paths: ["src/payments/"], required: 2, vetoes: ["payments"] }],
	grants: { security: ["person:*", "githive"], payments: ["@acme/payments"] },
};

const branchRules: NonNullable<RepoSnapshot["branchRules"]> = [
	{
		pattern: "release/*",
		policy: { required: 3, vetoes: ["security"], grants: { security: ["person:*"] } },
		verify: ["npm ci", "npm test", "npm run e2e"],
	},
	{ pattern: "experiments/*", policy: { required: 0 }, verify: [] },
];

/** A plain push to main, past GitHive: a hotfix the audit flags, and what hero-banner conflicts with. */
const HOTFIX = sha(`${REPO}:hotfix-promo`);
const RELEASE_HEAD = sha(`${REPO}:release/2.4`);

const INTENT = {
	cartCoupons:
		"Let shoppers apply a coupon code in the cart drawer.\n\n" +
		"Validates codes against /api/coupons, shows the discount as its own line, and keeps the code across reloads.",
	sessionCookies:
		"Move the session token from localStorage to an HttpOnly cookie.\n\n" +
		"readSession now reads the cookie from the request, so it takes the request and is async.",
};

const readSessionChange = {
	name: "readSession",
	change: "interface" as const,
	before: "readSession(): Session | null",
	after: "readSession(request: Request): Promise<Session | null>",
};

function sessionAwareness(head: string): ChangeAwareness {
	return {
		change: "session-cookies",
		agent: "ines/claude",
		branch: "main",
		head,
		base: sha(`${REPO}:base:session-cookies`),
		at: agoMs(64),
		alters: [
			{ file: "src/lib/session.ts", altered: readSessionChange },
			{ file: "src/auth/tokens.ts", altered: { name: "storeToken", change: "removed" } },
		],
		uses: [
			{ file: "src/lib/api.ts", name: "apiFetch", at: [{ file: "src/lib/session.ts", line: 3 }] },
			{ file: "src/auth/login.ts", name: "login", at: [{ file: "src/auth/tokens.ts", line: 5 }] },
		],
		usedBy: [
			{
				file: "src/lib/session.ts",
				altered: readSessionChange,
				imported: "readSession",
				at: [
					{ file: "src/lib/cart.ts", line: 4 },
					{ file: "src/components/CartDrawer.tsx", line: 12 },
					{ file: "src/components/CartDrawer.tsx", line: 58 },
					{ file: "test/cart.test.ts", line: 9 },
				],
				other: { by: "mara/claude", change: "cart-coupons", intent: INTENT.cartCoupons.split("\n")[0] },
			},
		],
		alteredBy: [],
	};
}

function cartAwareness(head: string): ChangeAwareness {
	return {
		change: "cart-coupons",
		agent: "mara/claude",
		branch: "main",
		head,
		base: sha(`${REPO}:base:cart-coupons`),
		at: agoMs(32),
		alters: [
			{
				file: "src/lib/cart.ts",
				altered: {
					name: "CartState",
					change: "interface",
					before: "{ items: CartItem[] }",
					after: "{ items: CartItem[]; coupon?: Coupon }",
				},
			},
			{ file: "src/lib/cart.ts", altered: { name: "applyCoupon", change: "now exported" } },
		],
		uses: [
			{ file: "src/lib/session.ts", name: "readSession", at: [{ file: "src/lib/cart.ts", line: 4 }] },
			{ file: "src/lib/format.ts", name: "formatPrice", at: [{ file: "src/components/CartDrawer.tsx", line: 7 }] },
		],
		usedBy: [],
		alteredBy: [
			{
				file: "src/lib/session.ts",
				altered: readSessionChange,
				imported: "readSession",
				at: [
					{ file: "src/lib/cart.ts", line: 4 },
					{ file: "src/components/CartDrawer.tsx", line: 12 },
				],
				other: { by: "ines/claude", change: "session-cookies", intent: INTENT.sessionCookies.split("\n")[0] },
			},
		],
	};
}

function taxAwareness(head: string): ChangeAwareness {
	return {
		change: "checkout-tax",
		agent: "ines/claude",
		branch: "main",
		head,
		base: sha(`${REPO}:base:checkout-tax`),
		at: agoMs(72),
		alters: [
			{
				file: "src/components/checkout/OrderSummary.tsx",
				altered: {
					name: "OrderSummaryProps",
					change: "interface",
					before: "{ items: CartItem[]; shipping: Money }",
					after: "{ items: CartItem[]; shipping: Money; country: string }",
				},
			},
			{ file: "src/lib/currency.ts", altered: { name: "taxLine", change: "now exported" } },
		],
		uses: [
			{
				file: "src/lib/format.ts",
				name: "formatPrice",
				at: [{ file: "src/components/checkout/OrderSummary.tsx", line: 3 }],
			},
			{ file: "src/lib/api.ts", name: "fetchTaxRates", at: [{ file: "src/lib/currency.ts", line: 2 }] },
			{
				file: "src/lib/cart.ts",
				name: "cartTotal",
				at: [{ file: "src/components/checkout/OrderSummary.tsx", line: 4 }],
			},
			{
				file: "src/lib/cart.ts",
				name: "CartItem",
				at: [{ file: "src/components/checkout/OrderSummary.tsx", line: 4 }],
			},
		],
		usedBy: [],
		alteredBy: [],
	};
}

const HERO_HUNK = `export function Home() {
	const products = useFeatured();
	const t = useT();
<<<<<<< changes/hero-banner
	return (
		<main>
			<HeroBanner
				crops={HERO_CROPS}
				overlay={themeColors.surface}
				cta={{ label: t("home.hero.cta"), href: "/promo/summer" }}
			/>
=======
	return (
		<main>
			<section className="hero">
				<img src="/images/hero.webp" alt="" fetchPriority="high" />
				<a className="hero__cta" href="/promo/autumn">
					{t("home.hero.cta")}
				</a>
			</section>
>>>>>>> main
			<ProductGrid products={products} />
		</main>
	);
}`;

const HERO_TEST_OUTPUT = ` FAIL  test/checkout.test.ts > home > links the hero to the current promo
AssertionError: expected '/promo/summer' to be '/promo/autumn' // Object.is equality
 ❯ test/checkout.test.ts:88:41

 Test Files  1 failed | 5 passed (6)
      Tests  1 failed | 63 passed (64)`;

const STORIES: Story[] = [
	// Landed long ago: the branch's history, before the event log reaches.
	landedLongAgo(
		"seed-script",
		"mara/claude",
		"Add a seed script for local development: 40 products across 6 categories, with stock and reviews.",
		["scripts/seed.ts", "test/fixtures/products.json"],
		day(19, 300),
		[],
	),
	landedLongAgo(
		"prettier",
		"robin/builder",
		"Add a Prettier config and format the codebase once.",
		[".prettierrc", "package.json"],
		day(18, 120),
		[],
		{ files: [".prettierrc", "package.json", "src/App.tsx", "src/main.tsx", "src/routes.ts", "src/lib/api.ts"] },
	),
	landedLongAgo(
		"analytics-consent",
		"devon/codex",
		"Load analytics only after the shopper consents.",
		["src/lib/analytics.ts", "src/App.tsx"],
		day(16, 200),
		[
			["robin/reviewer", "review", "No analytics request before consent in a fresh profile; consent persists."],
			[GUARD, "security", "No third-party script loads before consent; the consent cookie is first-party."],
		],
	),
	landedLongAgo(
		"alt-text",
		"githive-nurse",
		"Give every product image alt text from its name and variant.",
		["src/components/ProductCard.tsx"],
		day(14, 410),
		[
			["githive-scout", "review", 'Every <img> in ProductCard has alt; decorative badges use alt="".'],
			[GUARD, "security", "Markup only."],
		],
	),
	landedLongAgo(
		"robots-txt",
		"githive-scout",
		"Add robots.txt that keeps crawlers out of cart and checkout.",
		["public/robots.txt"],
		day(14, 380),
		[
			["githive-nurse", "review", "Disallows /cart and /checkout; product pages stay crawlable."],
			[GUARD, "security", "Static file."],
		],
	),
	landedLongAgo(
		"address-autocomplete",
		"ines/claude",
		"Add autocomplete attributes to the address form so browsers fill it in.",
		["src/components/checkout/AddressForm.tsx"],
		day(12, 90),
		[
			["mara/claude", "review", "Chrome and Safari autofill every field, including the second address line."],
			[GUARD, "security", "Attributes only; no new inputs."],
		],
	),
	landedLongAgo(
		"category-sort",
		"theo/cursor",
		"Sort category pages by price, newest or rating.",
		["src/pages/Category.tsx", "src/lib/api.ts"],
		day(11, 500),
		[
			["ines/claude", "review", "Sorting is stable and kept in the URL; rating sort puts unrated last."],
			[GUARD, "security", "The sort key is checked against a list before it reaches the API."],
		],
		{ files: ["src/pages/Category.tsx", "src/lib/api.ts", "src/components/ProductGrid.tsx"] },
	),
	landedLongAgo(
		"cart-badge-fix",
		"mara/claude",
		"Fix: the cart badge kept the old count after removing an item.",
		["src/components/Header.tsx", "src/lib/cart.ts"],
		day(10, 60),
		[
			["devon/codex", "review", "Removing the last item clears the badge; added a regression test."],
			[GUARD, "security", "State handling only."],
		],
	),
	landedLongAgo(
		"login-rate-limit",
		"robin/builder",
		"Rate-limit login attempts: 5 a minute per IP and per account.",
		["src/auth/rateLimit.ts", "src/auth/login.ts"],
		day(9, 240),
		[
			["ines/claude", "review", "The sixth attempt within a minute gets 429 with Retry-After; the counter resets."],
			[GUARD, "security", "Counts by both IP and account, so one IP can't lock every account out."],
		],
	),
	landedLongAgo(
		"payment-retry",
		"devon/codex",
		"Retry a failed payment intent once before showing an error.",
		["src/payments/stripe.ts", "test/payments.test.ts"],
		day(8, 330),
		[["robin/reviewer", "review", "Retries once on a network error, never on a card decline."]],
	),
	landedLongAgo(
		"i18n-de-checkout",
		"ines/claude",
		"German translations for checkout.",
		["src/i18n/de.json"],
		day(6, 150),
		[
			["theo/cursor", "review", "Checked against the glossary; formal Sie throughout."],
			[GUARD, "security", "Strings only."],
		],
	),
	landedLongAgo(
		"stock-badge",
		"mara/claude",
		"Show a low-stock badge on product cards.",
		["src/components/ProductCard.tsx", "src/lib/inventory.ts"],
		day(5, 45),
		[
			["theo/cursor", "review", "Badge shows at 5 or fewer, hides at 0 (out of stock shows instead)."],
			[GUARD, "security", "Display only."],
		],
	),
	landedLongAgo(
		"category-cache",
		"devon/codex",
		"Cache category pages for 60 seconds at the edge.",
		["src/routes.ts", "vite.config.ts"],
		day(3, 380),
		[
			["mara/claude", "review", "Cache-Control is public, max-age=60 on category routes only; cart stays private."],
			[GUARD, "security", "Nothing personal is cached: the route sets Vary: Cookie and skips signed-in requests."],
		],
	),
	landedLongAgo(
		"lazy-images",
		"ines/claude",
		"Lazy-load product images below the fold.",
		["src/components/ProductGrid.tsx", "src/components/ProductCard.tsx"],
		day(2, 220),
		[
			["theo/cursor", "review", "LCP unchanged (first row is eager); 1.8 MB less on a category page."],
			[GUARD, "security", "Attributes only."],
		],
	),
	landedLongAgo(
		"product-jsonld",
		"theo/cursor",
		"Add product JSON-LD so search engines show price and stock.",
		["src/pages/Product.tsx"],
		day(1, 100),
		[
			["devon/codex", "review", "Validates in the rich results test; price and availability match the page."],
			[GUARD, "security", "Product data is escaped before it goes into the script tag."],
		],
	),

	// Its agent went quiet on its turn, and someone else released the claim as stale.
	{
		change: "gift-wrap",
		agent: "sol/claude",
		intent: "Offer gift wrapping at checkout, with a message on the packing slip.",
		paths: ["src/components/checkout/ShippingOptions.tsx", "src/i18n/en.json"],
		claimed: day(3, 400),
		steps: [
			{ kind: "push", at: day(3, 340), message: "Add a gift wrap option to ShippingOptions" },
			{
				kind: "vote",
				at: day(3, 310),
				reviewer: "mara/claude",
				role: "review",
				verdict: "reject",
				evidence: "The gift message isn't length-checked: 2,000 characters overflow the packing slip template.",
			},
			{ kind: "released", at: day(3, 100), reason: "stale", stale: true },
		],
	},

	// Today: the event log reaches back to 285 minutes ago.
	{
		change: "wishlist",
		agent: "sol/claude",
		intent:
			"Add a wishlist to the account page: save products from their card, list them on Account, move them to the cart.",
		paths: ["src/pages/Account.tsx"],
		claimed: 300,
		steps: [{ kind: "reclaim", at: 252, paths: ["src/lib/wishlist.ts"] }],
	},
	{
		change: "currency-rounding",
		agent: "mara/claude",
		intent:
			"Round line totals half-even before summing, so cart and order totals agree to the cent.\n\n" +
			"The cart summed unrounded prices and the order summary summed rounded ones, so a three-item cart could be a cent off.",
		paths: ["src/lib/currency.ts", "test/currency.test.ts"],
		claimed: 280,
		steps: [
			{ kind: "push", at: 262, message: "Round line totals half-even before summing" },
			{
				kind: "vote",
				at: 252,
				reviewer: "ines/claude",
				role: "review",
				verdict: "approve",
				evidence: "currency.test.ts: 11 cases including the .005 boundaries pass; totals now match OrderSummary.",
			},
			{
				kind: "vote",
				at: 249,
				reviewer: GUARD,
				role: "security",
				verdict: "approve",
				evidence: "Pure arithmetic in currency.ts; no input handling or secrets touched.",
			},
			{ kind: "merging", at: 247 },
			{
				kind: "failed",
				at: 244,
				reason: "checks failed: npm test exited 1",
				output:
					" FAIL  test/currency.test.ts > formatMoney > JPY has no minor units\n" +
					"AssertionError: expected '¥1,235.00' to be '¥1,235'",
			},
			{
				kind: "push",
				at: 239,
				message:
					"Skip rounding for zero-decimal currencies\n\nJPY and KRW have no minor units, so there's nothing to round.",
			},
			{
				kind: "vote",
				at: 236,
				reviewer: "ines/claude",
				role: "review",
				verdict: "approve",
				evidence: "JPY and KRW cases added and passing.",
			},
			{
				kind: "vote",
				at: 234,
				reviewer: GUARD,
				role: "security",
				verdict: "approve",
				evidence: "Same arithmetic; a currency table lookup.",
			},
			{ kind: "merging", at: 232 },
			{ kind: "landed", at: 230 },
		],
	},
	{
		change: "a11y-header",
		agent: "theo/cursor",
		intent:
			"Make the header navigable by keyboard: visible focus rings, a skip link, and aria-current on the active section.",
		paths: ["src/components/Header.tsx", "src/styles/tokens.css"],
		claimed: 262,
		steps: [
			{ kind: "push", at: 228, message: "Keyboard focus rings and a skip link in the header" },
			{
				kind: "vote",
				at: 214,
				reviewer: "robin/reviewer",
				role: "review",
				verdict: "approve",
				evidence:
					"Tabbed through Home, Category and Cart: the focus ring shows on every link and the skip link lands on #main.",
			},
			{
				kind: "vote",
				at: 207,
				reviewer: GUARD,
				role: "security",
				verdict: "approve",
				evidence: "Markup and CSS only.",
			},
			{ kind: "merging", at: 196 },
			{ kind: "landed", at: 190 },
		],
	},
	{
		change: "newsletter-popup",
		agent: "devon/codex",
		intent: "Show a newsletter sign-up popup after 20 seconds on the home page.",
		paths: ["src/components/NewsletterPopup.tsx", "src/App.tsx"],
		claimed: 240,
		steps: [
			{ kind: "push", at: 205, message: "Add NewsletterPopup with a 20 s delay" },
			{
				kind: "vote",
				at: 172,
				reviewer: "mara/claude",
				role: "review",
				verdict: "reject",
				evidence:
					"On a 390 px screen the popup covers the add-to-cart button, and its close target is 24 px. " +
					"It also comes back on every visit: nothing remembers that it was dismissed.",
			},
			{ kind: "released", at: 128, reason: "Product decided against a popup for now; closing without merging." },
		],
	},
	{
		change: "refund-webhook",
		agent: "devon/codex",
		intent:
			"Handle Stripe refund webhooks: mark the order refunded and email the customer.\n\n" +
			"Verifies the webhook signature, is idempotent on the event id, and records partial refunds as such.",
		paths: ["src/payments/webhooks.ts", "src/payments/refunds.ts", "test/payments.test.ts"],
		claimed: 176,
		active: 97,
		steps: [
			{ kind: "push", at: 121, message: "Handle charge.refunded webhooks" },
			{
				kind: "push",
				at: 97,
				message:
					"Make refunds idempotent on the Stripe event id\n\nA replayed event finds the refund already recorded.",
			},
			{
				kind: "vote",
				at: 88,
				reviewer: "robin/reviewer",
				role: "review",
				verdict: "approve",
				evidence:
					"Replayed the same event twice in payments.test.ts: one refund recorded. A tampered body fails the signature check.",
			},
			{
				kind: "vote",
				at: 8,
				reviewer: GUARD,
				role: "security",
				verdict: "approve",
				evidence:
					"The signature is checked against the raw body with a constant-time compare; the secret comes from env and is never logged.",
			},
		],
		hosted: { reviewers: [{ role: "security", status: "done", verdict: "approve" }] },
	},
	{
		change: "dark-mode-tokens",
		agent: "robin/builder",
		intent: "Add dark mode color tokens and switch them with prefers-color-scheme.",
		paths: ["src/styles/tokens.css", "src/styles/global.css", "src/lib/theme.ts"],
		claimed: 160,
		steps: [
			{ kind: "push", at: 126, message: "Add a dark palette to tokens.css" },
			{
				kind: "vote",
				at: 106,
				reviewer: "ines/claude",
				role: "review",
				verdict: "approve",
				evidence: "Both palettes pass WCAG AA: body text 7.1:1 light and 12.4:1 dark, links 4.8:1.",
			},
			{
				kind: "vote",
				at: 101,
				reviewer: GUARD,
				role: "security",
				verdict: "approve",
				evidence: "CSS and a constants module; nothing executes.",
			},
			{ kind: "merging", at: 74 },
			{ kind: "landed", at: 70 },
		],
	},
	{
		change: "checkout-tax",
		agent: "ines/claude",
		intent:
			"Show tax as its own line in the order summary, computed per shipping country.\n\n" +
			'Rates come from the existing /api/tax endpoint. EU addresses show "incl. VAT"; elsewhere tax is a separate line.',
		paths: ["src/components/checkout/OrderSummary.tsx", "src/lib/currency.ts", "test/currency.test.ts"],
		claimed: 140,
		active: 25,
		steps: [
			{ kind: "push", at: 72, message: "Add a tax line to OrderSummary" },
			{
				kind: "vote",
				at: 41,
				reviewer: "robin/reviewer",
				role: "review",
				verdict: "approve",
				evidence:
					"Checked DE, FR, US and CA addresses in the checkout test: EU shows incl. VAT, US and CA a separate line, and the totals match currency.ts.",
			},
			{
				kind: "vote",
				at: 29,
				reviewer: GUARD,
				role: "security",
				verdict: "approve",
				evidence: "Reads rates from the existing endpoint; no new inputs reach the server.",
			},
		],
		hosted: { reviewers: [{ role: "security", status: "done", verdict: "approve" }] },
		awareness: taxAwareness,
	},
	{
		change: "hero-banner",
		agent: "theo/cursor",
		intent: "Swap the home page hero for a responsive banner with art-directed crops.",
		paths: ["src/pages/Home.tsx", "src/components/HeroBanner.tsx", "public/images/hero.webp"],
		claimed: 125,
		active: 20,
		steps: [
			{ kind: "push", at: 95, message: "Add HeroBanner with art-directed crops" },
			{ kind: "push", at: 61, message: "Use themeColors for the banner overlay" },
			{
				kind: "vote",
				at: 48,
				reviewer: "mara/claude",
				role: "review",
				verdict: "approve",
				evidence:
					"The three crops hold the subject in frame at 390, 768 and 1440 px; the LCP image has fetchpriority=high.",
			},
			{
				kind: "vote",
				at: 44,
				reviewer: GUARD,
				role: "security",
				verdict: "approve",
				evidence: "Static assets and markup; image URLs are same-origin.",
			},
			{ kind: "merging", at: 30 },
			{ kind: "failed", at: 25, reason: "checks failed: npm test exited 1", output: HERO_TEST_OUTPUT },
			{ kind: "conflicted", at: 20, files: ["src/pages/Home.tsx"] },
		],
		hosted: { reviewers: [{ role: "security", status: "done", verdict: "approve" }] },
		merge: (head) => ({
			head,
			into: "main",
			branchHead: HOTFIX,
			clean: false,
			conflicts: ["src/pages/Home.tsx"],
			touchedBy: [
				{
					file: "src/pages/Home.tsx",
					commit: HOTFIX,
					author: "Devon Pike",
					intent: "Hotfix: point the home promo at the autumn sale",
				},
			],
			hunks: [{ file: "src/pages/Home.tsx", content: HERO_HUNK, truncated: false }],
			fix: [
				"git fetch origin main",
				"git merge origin/main",
				"# keep HeroBanner, with main's promo link: /promo/autumn",
				"git add src/pages/Home.tsx",
				"git commit --no-edit",
				"git push fork HEAD:changes/hero-banner",
				"call merge with change hero-banner",
			],
		}),
	},
	{
		change: "session-cookies",
		agent: "ines/claude",
		intent: INTENT.sessionCookies,
		paths: ["src/auth/tokens.ts", "src/lib/session.ts"],
		claimed: 120,
		active: 35,
		steps: [
			{ kind: "push", at: 66, message: "Store the session in an HttpOnly cookie" },
			{
				kind: "vote",
				at: 53,
				reviewer: "robin/reviewer",
				role: "review",
				verdict: "approve",
				evidence: "Login, refresh and logout work in Chrome and Safari; no token is left in localStorage.",
			},
			{
				kind: "vote",
				at: 41,
				reviewer: GUARD,
				role: "security",
				verdict: "reject",
				evidence:
					"tokens.ts:41 sets Secure only when NODE_ENV is production, but staging runs with NODE_ENV=staging, so the " +
					"cookie goes out over plain HTTP there. Set Secure everywhere but localhost.\n\n" +
					"Checked: src/auth/tokens.ts, src/lib/session.ts, deploy/staging.env, and a request against staging with " +
					"curl -v: Set-Cookie: sid=…; HttpOnly; SameSite=Lax (no Secure).",
			},
		],
		hosted: { reviewers: [{ role: "security", status: "done", verdict: "reject" }] },
		awareness: sessionAwareness,
	},
	{
		change: "product-reviews",
		agent: "theo/cursor",
		intent: "Show the average rating and review count on the product page, with a link down to the reviews.",
		paths: ["src/components/Rating.tsx", "src/pages/Product.tsx"],
		claimed: 110,
		active: 8,
		checking: true,
		steps: [
			{ kind: "push", at: 56, message: "Show the average rating on Product" },
			{
				kind: "vote",
				at: 36,
				reviewer: "mara/claude",
				role: "review",
				verdict: "approve",
				evidence: 'Rounds to the nearest half star; with no reviews it says "No reviews yet" instead of 0 stars.',
			},
			{
				kind: "vote",
				at: 23,
				reviewer: GUARD,
				role: "security",
				verdict: "approve",
				evidence: "Display only; the count comes from the existing product query.",
			},
			{ kind: "merging", at: 8 },
		],
		hosted: { reviewers: [{ role: "security", status: "done", verdict: "approve" }] },
	},
	{
		change: "stock-sync",
		agent: "mara/claude",
		intent: "Sync stock levels from the warehouse feed every 5 minutes instead of nightly.",
		paths: ["src/lib/inventory.ts", "scripts/seed.ts"],
		claimed: 100,
		active: 38,
		steps: [
			{ kind: "push", at: 62, message: "Poll the warehouse feed every 5 minutes" },
			{
				kind: "vote",
				at: 51,
				reviewer: "devon/codex",
				role: "review",
				verdict: "approve",
				evidence: "Backs off on 429 in the test double, and the stock cache is swapped in one step.",
			},
			{
				kind: "asked",
				at: 38,
				reason:
					"The warehouse feed allows 60 requests an hour. Polling every 5 minutes uses 48 of them across our 4 " +
					"regions, which leaves little for manual refreshes. Is it OK to use most of the budget, or should I poll " +
					"every 15 minutes?",
			},
		],
		attention: {
			agent: "mara/claude",
			at: 38,
			reason:
				"The warehouse feed allows 60 requests an hour. Polling every 5 minutes uses 48 of them across our 4 " +
				"regions, which leaves little for manual refreshes. Is it OK to use most of the budget, or should I poll " +
				"every 15 minutes?",
		},
		hosted: { reviewers: [{ role: "security", status: "working" }] },
	},
	{
		change: "cart-coupons",
		agent: "mara/claude",
		intent: INTENT.cartCoupons,
		paths: ["src/lib/cart.ts", "src/components/CartDrawer.tsx", "test/cart.test.ts"],
		claimed: 95,
		active: 32,
		steps: [
			{ kind: "push", at: 63, message: "Add a coupon field to CartDrawer" },
			{
				kind: "vote",
				at: 54,
				reviewer: "ines/claude",
				role: "review",
				verdict: "reject",
				evidence:
					"The code is kept in component state only, so a reload drops it while the discount stays in the persisted cart total.",
			},
			{
				kind: "push",
				at: 32,
				message: "Keep the coupon in the persisted cart\n\nThe discount is worked out from the stored code on load.",
			},
			{
				kind: "vote",
				at: 17,
				reviewer: "robin/reviewer",
				role: "review",
				verdict: "approve",
				evidence: "Reloaded with SAVE10 applied: the code and the discount both survive. cart.test.ts: 14 passed.",
			},
		],
		hosted: { reviewers: [{ role: "security", status: "working" }] },
		awareness: cartAwareness,
	},
	{
		change: "sitemap-script",
		agent: "githive-builder",
		intent: "Generate sitemap.xml at build time from the product catalog, and point robots.txt at it.",
		paths: ["scripts/build-sitemap.ts", "public/robots.txt"],
		claimed: 86,
		active: 34,
		steps: [{ kind: "push", at: 34, message: "Generate sitemap.xml from the catalog" }],
		hosted: {
			builder: { status: "working", revisions: 1 },
			reviewers: [
				{ role: "review", status: "working" },
				{ role: "security", status: "queued" },
			],
		},
	},
	{
		change: "price-format",
		agent: "devon/codex",
		intent: "Format prices with Intl.NumberFormat in the shopper's locale, instead of a hand-rolled formatter.",
		paths: ["src/lib/format.ts", "src/components/PriceTag.tsx"],
		claimed: 68,
		steps: [
			{ kind: "push", at: 46, message: "Use Intl.NumberFormat in formatPrice" },
			{
				kind: "vote",
				at: 31,
				reviewer: "theo/cursor",
				role: "review",
				verdict: "approve",
				evidence: "en-US, de-DE and fr-FR separators and currency positions are right; snapshots updated.",
			},
			{
				kind: "vote",
				at: 25,
				reviewer: GUARD,
				role: "security",
				verdict: "approve",
				evidence: "Formatting only.",
			},
			{ kind: "merging", at: 16 },
			{ kind: "landed", at: 12 },
		],
	},
	{
		change: "footer-links",
		agent: "robin/builder",
		intent: "Footer: add Returns and Shipping links, translated.",
		paths: ["src/components/Footer.tsx", "src/i18n/"],
		claimed: 50,
		active: 7,
		checking: true,
		steps: [
			{ kind: "push", at: 31, message: "Add Returns and Shipping links to the footer" },
			{
				kind: "vote",
				at: 21,
				reviewer: "ines/claude",
				role: "review",
				verdict: "approve",
				evidence: "The links resolve in en, de and fr; the German strings match the glossary.",
			},
			{ kind: "vote", at: 15, reviewer: GUARD, role: "security", verdict: "approve", evidence: "Static links." },
			{ kind: "merging", at: 7 },
		],
		hosted: { reviewers: [{ role: "security", status: "done", verdict: "approve" }] },
	},
	{
		change: "backport-po-boxes",
		agent: "ines/claude",
		into: "release/2.4",
		intent: "Backport to release/2.4: hide express shipping for PO box addresses.",
		paths: ["src/components/checkout/ShippingOptions.tsx"],
		claimed: 45,
		active: 30,
		steps: [
			{ kind: "push", at: 30, message: "Hide express shipping for PO boxes" },
			{
				kind: "vote",
				at: 20,
				reviewer: "robin/reviewer",
				role: "review",
				verdict: "approve",
				evidence: "Same change as on main, cherry-picked cleanly; the release test suite passes.",
			},
		],
	},
	{
		change: "og-images",
		agent: "githive-builder",
		intent: "Render an Open Graph image for each product at build time.",
		paths: ["scripts/og-images.ts", "public/og/"],
		claimed: 35,
		active: 14,
		steps: [],
		attention: {
			agent: "githive-builder",
			at: 14,
			reason:
				"GitHive's builder failed: npm run build failed: Cannot find module 'satori'. Adding it means changing " +
				"package.json, which is outside the claim.",
		},
		hosted: {
			builder: {
				status: "failed",
				revisions: 0,
				error:
					"npm run build failed: Cannot find module 'satori'. Adding it means changing package.json, which is outside the claim.",
			},
			reviewers: [],
		},
	},
	{
		change: "search-facets",
		agent: "devon/codex",
		intent: "Add faceted filters to search: brand, price range and rating, kept in the URL so results can be shared.",
		paths: ["src/lib/search.ts", "src/components/SearchBox.tsx"],
		after: ["product-reviews"],
		claimed: 12,
		steps: [{ kind: "reclaim", at: 4, paths: ["src/components/SearchFilters.tsx"] }],
	},
];

const hive = buildHive({
	repo: REPO,
	branch: "main",
	policy,
	branchRules,
	baseHead: sha(`${REPO}:base`),
	otherHeads: { "release/2.4": RELEASE_HEAD },
	stories: STORIES,
	extraEvents: [
		{ at: 270, event: { kind: "added", agent: "robin/builder", detail: "4 pieces of work" } },
		{
			at: 86,
			event: {
				kind: "building",
				agent: "robin/builder",
				change: "sitemap-script",
				detail: "Generate sitemap.xml at build time from the product catalog, and point robots.txt at it.",
			},
		},
		{
			at: 64,
			event: {
				kind: "heads_up",
				agent: "ines/claude",
				change: "session-cookies",
				other: "mara/claude",
				otherChange: "cart-coupons",
				detail: "readSession",
			},
		},
		{
			at: 35,
			event: {
				kind: "building",
				agent: "theo/cursor",
				change: "og-images",
				detail: "Render an Open Graph image for each product at build time.",
			},
		},
		{
			at: 11,
			event: {
				kind: "interface",
				agent: "devon/codex",
				change: "cart-coupons",
				other: "mara/claude",
				commit: mergeCommit(REPO, "price-format"),
				detail: "formatPrice; 1 more changes use it",
			},
		},
	],
	logReach: 285,
	checkingSince: 6,
	files: FILES,
});

const audit: RepoAudit = {
	merges: hive.landed.length + 2,
	open: 2,
	violations: [
		{
			commit: HOTFIX,
			author: "Devon Pike",
			rule: "undeclared",
			detail: "the merge names no change or claims it checked (GitHive-Change, GitHive-Claims)",
		},
		{
			commit: mergeCommit(REPO, "category-sort"),
			author: "theo/cursor",
			rule: "outside-claim",
			detail: `src/components/ProductGrid.tsx was not in category-sort's claim at ${sha(`${REPO}:claims:category-sort`).slice(0, 7)}`,
			by: PEOPLE.theo.person,
		},
		{
			commit: mergeCommit(REPO, "payment-retry"),
			author: "devon/codex",
			rule: "unapproved",
			detail:
				`${sha(`${REPO}:payment-retry:0`).slice(0, 7)} had 1 of 2 approvals at ` +
				sha(`${REPO}:votes:payment-retry`).slice(0, 7),
			by: PEOPLE.devon.person,
			resolvedBy: sha(`${REPO}:revert:payment-retry`),
		},
	],
};

const stretch = { landed: 4, failed: 2, agents: 4, from: ago(280), to: ago(12) };

const snapshot: RepoSnapshot = {
	repo: REPO,
	branch: "main",
	skipChecks: DEFAULT_SKIP_CHECKS,
	branchRules,
	branches: [{ name: "release/2.4", base: RELEASE_HEAD, from: "main", at: daysAgo(6, 40) }],
	policy,
	verify: ["npm ci", "npm run typecheck", "npm test"],
	verified: true,
	sharding: "on demand",
	votesSharding: { since: daysAgo(2, 95), because: "9 reviewers voted within 5 minutes" },
	claims: hive.claims,
	votes: snapshotVotes(hive.votes),
	github: {
		repo: "acme-shop/storefront",
		sync: "pr",
		trust: false,
		inbound: true,
		pull: { number: 128, url: "https://github.com/acme-shop/storefront/pull/128" },
		fromGitHub: { step: "done", commit: sha(`${REPO}:github:import`), at: ago(200) },
	},
};

const hosted: HiveStatus = {
	names: ["githive-forager", "githive-scout", "githive-nurse"],
	startedAt: agoMs(150),
	until: agoMs(-30),
	by: ROBIN.handle,
	working: true,
	agents: [
		{ name: "githive-forager", reviewing: { change: "cart-coupons" }, finished: [], reviewed: 3, done: false },
		{ name: "githive-scout", finished: [{ piece: "robots-txt-sitemap", at: agoMs(140) }], reviewed: 5, done: false },
		{
			name: "githive-nurse",
			finished: [
				{ piece: "alt-text-variants", at: agoMs(120) },
				{ piece: "empty-cart-copy", at: agoMs(75) },
			],
			reviewed: 1,
			done: true,
		},
	],
};

export const STOREFRONT: RepoFixture = {
	fullName: REPO,
	id: "r-storefront",
	visibility: "public",
	createdAt: daysAgo(21),
	level: "admin",
	branch: "main",
	heads: { main: hive.head, "release/2.4": RELEASE_HEAD },
	files: FILES,
	hive: {
		snapshot,
		audit,
		events: hive.events,
		landings: {
			main: landingOf(hive, "main", stretch),
			"release/2.4": { branch: "release/2.4", checking: null, recent: [] },
		},
		histories: {
			main: { branch: "main", total: hive.landed.length, changes: hive.landed },
			"release/2.4": { branch: "release/2.4", total: 0, changes: [] },
		},
		changes: hive.changes,
	},
	hosted,
	collaborators: [
		{ handle: "lee", permission: "admin" },
		{ handle: "sol", permission: "write" },
		{ handle: "ari", permission: "review" },
		{ handle: "kim", permission: "read" },
	],
	summary: summaryOf(snapshot, audit, hive.lastActivity, stretch),
};
