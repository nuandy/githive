import type { RepoFile } from "../../src/api.ts";
import { between, pick } from "./ids.ts";

// What the Code tab shows of a file: made up from its path, so every file in a tree opens to something that looks
// like it belongs there. Images are binary, the lock file too big to show.

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?)$/;
const TOO_BIG: Record<string, number> = { "package-lock.json": 812_403 };

const base = (path: string) => path.split("/").pop() ?? path;
const stem = (path: string) => base(path).replace(/\.(test|spec)?\.?[a-z]+$/, "");
const pascal = (name: string) =>
	name
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((word) => word[0]!.toUpperCase() + word.slice(1))
		.join("");
const camel = (name: string) => {
	const joined = pascal(name);
	return joined[0]!.toLowerCase() + joined.slice(1);
};
const kebab = (name: string) =>
	name
		.replace(/([a-z0-9])([A-Z])/g, "$1-$2")
		.replace(/[^A-Za-z0-9]+/g, "-")
		.toLowerCase();
const words = (name: string) => kebab(name).replace(/-/g, " ");
const title = (text: string) => text[0]!.toUpperCase() + text.slice(1);

/** What some files are for, in a line. */
const ABOUT: Record<string, string> = {
	"src/lib/cart.ts": "the cart: its items, their totals, and keeping it across reloads",
	"src/lib/currency.ts": "money: rounding, currencies without minor units, and tax lines",
	"src/lib/format.ts": "formatting prices and dates in the shopper's locale",
	"src/lib/inventory.ts": "stock levels, read from the warehouse feed",
	"src/lib/search.ts": "product search: the query, its filters, and ranking",
	"src/lib/session.ts": "the shopper's session, read from its cookie",
	"src/lib/api.ts": "calls to the storefront API, with retries and timeouts",
	"src/lib/analytics.ts": "analytics events, sent only once the shopper consents",
	"src/lib/theme.ts": "the color tokens as constants, for the few places CSS can't reach",
	"src/payments/webhooks.ts": "Stripe webhooks: verifying them and handing each event on",
	"src/payments/refunds.ts": "refunds: recording them against the order, partial or whole",
	"src/payments/stripe.ts": "the Stripe client and payment intents",
	"src/auth/tokens.ts": "session tokens: issuing, storing and refreshing them",
	"src/auth/login.ts": "logging in and out",
	"src/auth/rateLimit.ts": "rate limits for login attempts, per IP and per account",
	"src/notes.ts": "notes: making, editing and sorting them",
	"src/search.ts": "searching notes, fuzzily",
	"src/tags.ts": "tags: parsing #tags out of a note and listing them",
	"src/storage.ts": "keeping notes in local storage",
};

function about(path: string): string {
	return ABOUT[path] ?? `${words(stem(path))}, as the rest of the app uses it`;
}

function component(path: string): string {
	const name = pascal(stem(path));
	const cls = kebab(stem(path));
	const shown = between(path, 3, 8);
	const deep = path.split("/").length > 3 ? "../../" : "../";
	const label = pick(path, ["title", "heading", "label"]);
	return `import { useMemo, useState } from "react";
import { useT } from "${deep}i18n";
import { formatPrice } from "${deep}lib/format";
import type { Product } from "${deep}lib/api";

export interface ${name}Props {
	products: Product[];
	/** Shown above the list; the section's own name by default. */
	${label}?: string;
	/** Called when a product is picked. */
	onSelect?: (product: Product) => void;
	/** How many to show before "Show all". */
	shown?: number;
}

/** ${title(about(path))}. */
export function ${name}({ products, ${label}, onSelect, shown = ${shown} }: ${name}Props) {
	const t = useT();
	const [expanded, setExpanded] = useState(false);
	const visible = useMemo(
		() => (expanded ? products : products.slice(0, shown)),
		[expanded, products, shown],
	);
	const hidden = products.length - visible.length;

	if (!products.length) {
		return (
			<section className="${cls} ${cls}--empty">
				<p className="muted">{t("${camel(stem(path))}.empty")}</p>
			</section>
		);
	}

	return (
		<section className="${cls}" aria-label={${label} ?? t("${camel(stem(path))}.title")}>
			<h2 className="${cls}__title">{${label} ?? t("${camel(stem(path))}.title")}</h2>
			<ul className="${cls}__list">
				{visible.map((product) => (
					<li key={product.id} className="${cls}__item">
						<button type="button" onClick={() => onSelect?.(product)}>
							<img src={product.image} alt={product.name} loading="lazy" />
							<span className="${cls}__name">{product.name}</span>
							<span className="${cls}__price">{formatPrice(product.price)}</span>
						</button>
					</li>
				))}
			</ul>
			{hidden > 0 ? (
				<button type="button" className="link" onClick={() => setExpanded(true)}>
					{t("common.showAll", { count: products.length })}
				</button>
			) : null}
		</section>
	);
}

/** The products worth showing first: in stock, then by rating. */
export function rank(products: Product[]): Product[] {
	return [...products].sort(
		(a, b) => Number(b.inStock) - Number(a.inStock) || (b.rating ?? 0) - (a.rating ?? 0),
	);
}
`;
}

function moduleFile(path: string): string {
	const name = pascal(stem(path));
	const fn = camel(stem(path));
	const maxAge = between(path, 15, 300);
	const tries = between(`${path}:tries`, 2, 4);
	return `// ${title(about(path))}.

import { apiFetch, ApiError } from "./api";

export interface ${name}Options {
	/** How long an answer is good for, in milliseconds. */
	maxAgeMs?: number;
	/** Gives up when aborted. */
	signal?: AbortSignal;
}

export interface ${name}Entry {
	id: string;
	updatedAt: string;
	value: Record<string, unknown>;
}

const DEFAULT_MAX_AGE_MS = ${maxAge} * 1000;
const TRIES = ${tries};
const kept = new Map<string, { at: number; entry: ${name}Entry }>();

/** One entry, from what's kept while it's fresh, else from the API. */
export async function load${name}(id: string, options: ${name}Options = {}): Promise<${name}Entry> {
	const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
	const hit = kept.get(id);
	if (hit && Date.now() - hit.at < maxAge) return hit.entry;
	const entry = await withRetries(() => apiFetch<${name}Entry>(\`/api/${kebab(stem(path))}/\${id}\`, options));
	kept.set(id, { at: Date.now(), entry });
	return entry;
}

/** Forgets what's kept, so the next load asks the API. */
export function forget${name}(id?: string): void {
	if (id === undefined) kept.clear();
	else kept.delete(id);
}

/** Every entry changed since \`since\`, newest first. */
export function ${fn}Since(entries: ${name}Entry[], since: string): ${name}Entry[] {
	const from = Date.parse(since);
	return entries
		.filter((entry) => Date.parse(entry.updatedAt) > from)
		.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

async function withRetries<T>(call: () => Promise<T>): Promise<T> {
	let last: unknown;
	for (let attempt = 1; attempt <= TRIES; attempt++) {
		try {
			return await call();
		} catch (error) {
			// Only a server's or the network's trouble is worth another try.
			if (error instanceof ApiError && error.status < 500) throw error;
			last = error;
			await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 100));
		}
	}
	throw last;
}
`;
}

/** A browser test of the checkout, with Playwright. */
function browserTest(path: string): string {
	const flow = words(stem(path).replace(/\.spec$/, ""));
	return `import { expect, test } from "@playwright/test";

// ${title(flow)} in a real browser, against the seeded catalog (npm run seed).

test.describe("${flow}", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto("/p/trail-runner-2");
		await page.getByRole("button", { name: "Add to cart" }).click();
		await page.getByRole("link", { name: "Cart" }).click();
	});

	test("pays with a test card", async ({ page }) => {
		await page.getByRole("button", { name: "Check out" }).click();
		await page.getByLabel("Email").fill("shopper@example.com");
		await page.getByLabel("Street address").fill("Hauptstraße 12");
		await page.getByLabel("City").fill("Berlin");
		await page.getByLabel("Country").selectOption("DE");
		await expect(page.getByText("incl. VAT")).toBeVisible();
		const card = page.frameLocator("iframe[title='Secure card payment']");
		await card.getByPlaceholder("Card number").fill("4242 4242 4242 4242");
		await card.getByPlaceholder("MM / YY").fill("12 / 30");
		await card.getByPlaceholder("CVC").fill("123");
		await page.getByRole("button", { name: "Pay now" }).click();
		await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
	});

	test("keeps a coupon across a reload", async ({ page }) => {
		await page.getByLabel("Coupon code").fill("SAVE10");
		await page.getByRole("button", { name: "Apply" }).click();
		await expect(page.getByText("−10%")).toBeVisible();
		await page.reload();
		await expect(page.getByLabel("Coupon code")).toHaveValue("SAVE10");
	});

	test("shows the declined card's reason", async ({ page }) => {
		await page.getByRole("button", { name: "Check out" }).click();
		const card = page.frameLocator("iframe[title='Secure card payment']");
		await card.getByPlaceholder("Card number").fill("4000 0000 0000 0002");
		await page.getByRole("button", { name: "Pay now" }).click();
		await expect(page.getByRole("alert")).toContainText("Your card was declined");
	});
});
`;
}

function testFile(path: string, repo: string): string {
	if (path.startsWith("test/e2e/")) return browserTest(path);
	const subject = stem(path);
	const fn = camel(subject);
	const name = pascal(subject);
	const target = repo === "acme/storefront" ? `../src/lib/${subject}` : `../src/${subject}`;
	return `import { beforeEach, describe, expect, it } from "vitest";
import { forget${name}, load${name}, ${fn}Since } from "${target}";
import products from "./fixtures/products.json";

describe("${subject}", () => {
	beforeEach(() => forget${name}());

	it("loads an entry once while it's fresh", async () => {
		const first = await load${name}("p-100");
		const second = await load${name}("p-100");
		expect(second).toBe(first);
	});

	it("asks again once the entry is stale", async () => {
		const first = await load${name}("p-100", { maxAgeMs: 0 });
		const second = await load${name}("p-100", { maxAgeMs: 0 });
		expect(second).not.toBe(first);
		expect(second.id).toBe("p-100");
	});

	it("lists what changed since a time, newest first", () => {
		const entries = products.map((product, index) => ({
			id: product.id,
			updatedAt: new Date(Date.UTC(2026, 9, 1 + index)).toISOString(),
			value: product,
		}));
		const since = ${fn}Since(entries, "2026-10-05T00:00:00.000Z");
		expect(since.map((entry) => entry.id)).toEqual(
			entries
				.slice(5)
				.reverse()
				.map((entry) => entry.id),
		);
	});

	it("doesn't retry a request the server refused", async () => {
		await expect(load${name}("missing")).rejects.toThrow(/404/);
	});

	it("gives up when aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(load${name}("p-101", { signal: controller.signal })).rejects.toThrow(/abort/i);
	});
});
`;
}

function scriptFile(path: string): string {
	const name = stem(path);
	return `// scripts/${name}.ts: ${about(path)}.
//
//   node scripts/${name}.ts [--out <dir>] [--dry-run]

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface CatalogItem {
	id: string;
	slug: string;
	name: string;
	category: string;
	updatedAt: string;
}

const args = process.argv.slice(2);
const flag = (name: string) => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const out = flag("--out") ?? "dist";
const dryRun = args.includes("--dry-run");

async function catalog(): Promise<CatalogItem[]> {
	const text = await readFile("test/fixtures/products.json", "utf8");
	return JSON.parse(text) as CatalogItem[];
}

function entry(item: CatalogItem): string {
	const loc = \`https://shop.acme.example/p/\${item.slug}\`;
	return \`  <url><loc>\${loc}</loc><lastmod>\${item.updatedAt.slice(0, 10)}</lastmod></url>\`;
}

async function main() {
	const items = await catalog();
	const byCategory = new Map<string, CatalogItem[]>();
	for (const item of items) {
		const list = byCategory.get(item.category) ?? [];
		list.push(item);
		byCategory.set(item.category, list);
	}
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
		...items.map(entry),
		"</urlset>",
	];
	console.log(\`\${items.length} products in \${byCategory.size} categories\`);
	if (dryRun) return;
	await mkdir(out, { recursive: true });
	await writeFile(join(out, "${name}.xml"), lines.join("\\n"));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
`;
}

const VITE_CONFIG = `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The storefront's build: React, the API proxied in development, and category pages cached at the edge.

export default defineConfig({
	plugins: [react()],
	server: {
		port: 5173,
		proxy: {
			"/api": { target: "http://localhost:8787", changeOrigin: true },
		},
	},
	build: {
		target: "es2022",
		sourcemap: true,
		rollupOptions: {
			output: {
				manualChunks: {
					react: ["react", "react-dom"],
					checkout: ["./src/pages/Checkout.tsx", "./src/components/checkout/PaymentForm.tsx"],
				},
			},
		},
	},
});
`;

function markdown(path: string, repo: string): string {
	const heading = title(words(stem(path)));
	if (repo === "acme/docs") return guide(heading);
	return `# ${heading}

${title(about(path))}. This page is part of ${repo}'s documentation; the README has the overview.

## What it covers

- How ${words(stem(path))} fits with the rest of ${repo.split("/")[1]}.
- What to change, and what to leave alone.
- Where the tests for it live.

## How it works

Each request goes through the same steps:

1. The page asks the API for what it needs, with the shopper's session.
2. The answer is kept for a short while, so moving between pages is quick.
3. Anything that changes an order goes through the checks in \`test/\` first.

\`\`\`sh
npm run dev
npm test
\`\`\`

## Notes

Agents working here claim the files they change. Keep changes small: one goal, one change.
`;
}

/** A page of the docs site. */
function guide(heading: string): string {
	return `# ${heading}

This page is part of Acme's handbook for building with agents in GitHive.

## Before you start

You need a GitHive account in the \`acme\` organization, and an agent: make one on the Agents page, then connect
your client with the steps it shows.

## Step by step

1. Claim the paths you'll change, with what you set out to do.
2. Push your commits to your fork's \`changes/<id>\` branch.
3. Ask for review. Two approvals land a change on \`main\`; \`security\` can block.
4. Merge. The change lands with the next batch once the checks pass on the batch together.

\`\`\`sh
githive claim --change docs-typo --paths docs/index.md --intent "Fix a typo on the home page"
git push fork HEAD:changes/docs-typo
githive merge --change docs-typo
\`\`\`

## When something goes wrong

- **Changes requested**: read the evidence on the change's page, push a fix, and ask again.
- **Conflicts**: the change's page lists who changed each file and the commands that resolve it.
- **A question for a person**: it shows in their Inbox; their vote answers it.

> Claims that go quiet free up: 30 minutes with nothing pushed, two hours on your turn after that.
`;
}

const README: Record<string, string> = {
	"acme/storefront": `# Storefront

Acme's web shop: product pages, search, the cart and checkout, built with React and Vite.

Agents build it in GitHive. Each change claims the files it touches, is reviewed (two approvals; security can
block, and anything under \`src/payments/\` needs the payments team too), and lands with the next batch once
\`npm test\` passes on the batch together.

## Running it

\`\`\`sh
npm ci
npm run dev        # http://localhost:5173, with the API proxied to :8787
npm test           # unit tests
npm run e2e        # checkout in a real browser
\`\`\`

## Layout

| Folder              | What's in it                                        |
| ------------------- | --------------------------------------------------- |
| \`src/pages/\`        | One component per route                             |
| \`src/components/\`   | Shared UI; \`checkout/\` holds the checkout steps     |
| \`src/lib/\`          | Cart, currency, search, session and API helpers     |
| \`src/payments/\`     | Stripe: intents, webhooks and refunds               |
| \`src/i18n/\`         | Strings in English, German and French               |
| \`test/\`             | Vitest unit tests, and Playwright in \`test/e2e/\`    |
| \`scripts/\`          | Seeding and build-time generators                   |

## Money

Prices are integers in minor units. Round once, half-even, per line (see \`src/lib/currency.ts\`); currencies
without minor units (JPY, KRW) are never rounded.

## Releasing

\`main\` deploys on every landing. \`release/2.4\` takes backports only, with three approvals. Before a release:

- [x] \`npm test\` and \`npm run e2e\` pass on \`main\`
- [ ] The changelog names every change since the last release
`,
	"acme/docs": `# Acme docs

The handbook for building with agents at Acme: connecting one, how reviews work, branches, and the API.

Built with MkDocs; \`main\` publishes on every landing.

\`\`\`sh
pip install mkdocs-material
mkdocs serve
\`\`\`
`,
	"robin/notes": `# notes

A small notes app: Markdown notes in local storage, with tags and fuzzy search.

\`\`\`sh
npm install
npm run dev
npm test
\`\`\`

Export a note as Markdown or HTML from its menu. PDF export is on its way.
`,
	"oss-friend/tiny-lib": `# tiny-lib

Four small function helpers, no dependencies:

\`\`\`ts
import { debounce, throttle, memo, once } from "tiny-lib";

const save = debounce(write, 300, { trailing: true });
const onScroll = throttle(measure, 100);
const area = memo((w: number, h: number) => w * h, { size: 64 });
const init = once(connect);
\`\`\`

MIT licensed.
`,
};

function packageJson(repo: string): string {
	const name = repo.split("/")[1]!;
	const shop = repo === "acme/storefront";
	return `${JSON.stringify(
		{
			name,
			version: shop ? "2.5.0" : "0.4.1",
			private: shop,
			type: "module",
			scripts: {
				dev: "vite",
				build: "tsc && vite build",
				test: "vitest run",
				...(shop ? { e2e: "playwright test", typecheck: "tsc --noEmit", seed: "node scripts/seed.ts" } : {}),
			},
			dependencies: shop ? { react: "^19.3.0", "react-dom": "^19.3.0", stripe: "^19.1.0" } : {},
			devDependencies: {
				typescript: "^7.0.2",
				vitest: "^5.0.3",
				...(shop ? { vite: "^8.3.2", "@vitejs/plugin-react": "^6.1.1", "@playwright/test": "^1.64.0" } : {}),
			},
		},
		null,
		"\t",
	)}\n`;
}

const STRINGS: Record<string, Record<string, string>> = {
	en: {
		"home.hero.cta": "Shop the autumn sale",
		"cart.title": "Your cart",
		"cart.empty": "Your cart is empty.",
		"cart.coupon": "Coupon code",
		"checkout.pay": "Pay now",
		"checkout.tax": "Tax",
		"checkout.vatIncluded": "incl. VAT",
		"footer.returns": "Returns",
		"footer.shipping": "Shipping",
		"common.showAll": "Show all {count}",
	},
	de: {
		"home.hero.cta": "Zum Herbstsale",
		"cart.title": "Ihr Warenkorb",
		"cart.empty": "Ihr Warenkorb ist leer.",
		"cart.coupon": "Gutscheincode",
		"checkout.pay": "Jetzt bezahlen",
		"checkout.tax": "Steuer",
		"checkout.vatIncluded": "inkl. MwSt.",
		"footer.returns": "Rücksendungen",
		"footer.shipping": "Versand",
		"common.showAll": "Alle {count} anzeigen",
	},
	fr: {
		"home.hero.cta": "Découvrir les soldes d'automne",
		"cart.title": "Votre panier",
		"cart.empty": "Votre panier est vide.",
		"cart.coupon": "Code promo",
		"checkout.pay": "Payer",
		"checkout.tax": "Taxe",
		"checkout.vatIncluded": "TVA incluse",
		"footer.returns": "Retours",
		"footer.shipping": "Livraison",
		"common.showAll": "Tout afficher ({count})",
	},
};

const PRODUCTS = [
	["p-100", "trail-runner-2", "Trail Runner 2", "shoes"],
	["p-101", "merino-crew", "Merino Crew Sock", "socks"],
	["p-102", "rain-shell", "Packable Rain Shell", "jackets"],
	["p-103", "canvas-tote", "Canvas Tote", "bags"],
	["p-104", "wool-beanie", "Ribbed Wool Beanie", "hats"],
	["p-105", "day-pack-18", "Day Pack 18 L", "bags"],
	["p-106", "fleece-zip", "Grid Fleece Half-Zip", "jackets"],
	["p-107", "court-low", "Court Low Sneaker", "shoes"],
];

function jsonFile(path: string, repo: string): string {
	const name = base(path);
	if (name === "package.json") return packageJson(repo);
	const lang = /i18n\/([a-z]{2})\.json$/.exec(path)?.[1];
	if (lang) return `${JSON.stringify(STRINGS[lang] ?? STRINGS.en, null, "\t")}\n`;
	if (name === "products.json")
		return `${JSON.stringify(
			PRODUCTS.map(([id, slug, productName, category], index) => ({
				id,
				slug,
				name: productName,
				category,
				price: 1900 + index * 1250,
				currency: "EUR",
				inStock: index % 3 !== 2,
				rating: index % 4 === 3 ? null : 3.5 + (index % 3) * 0.5,
				updatedAt: `2026-10-0${1 + index}T08:00:00.000Z`,
			})),
			null,
			"\t",
		)}\n`;
	return `${JSON.stringify(
		{
			compilerOptions: {
				target: "es2022",
				module: "esnext",
				moduleResolution: "bundler",
				jsx: "react-jsx",
				strict: true,
				noUncheckedIndexedAccess: true,
				skipLibCheck: true,
			},
			include: ["src", "test", "scripts"],
		},
		null,
		"\t",
	)}\n`;
}

const CSS: Record<string, string> = {
	"tokens.css": `/* Color, type and spacing tokens. Dark mode swaps the colors only. */

:root {
	--color-ink: #1e2b33;
	--color-paper: #f5f6f4;
	--color-surface: #ffffff;
	--color-accent: #e59a0b;
	--color-accent-ink: #4a3203;
	--color-muted: #5b6a72;
	--color-good: #2f7d4f;
	--color-bad: #b4372f;
	--color-focus: #1f6feb;

	--font-body: "Overpass", system-ui, sans-serif;
	--font-mono: "JetBrains Mono", ui-monospace, monospace;
	--text-sm: 0.875rem;
	--text-md: 1rem;
	--text-lg: 1.25rem;
	--text-xl: 1.75rem;

	--space-1: 4px;
	--space-2: 8px;
	--space-3: 12px;
	--space-4: 16px;
	--space-6: 24px;
	--space-8: 32px;
	--radius: 10px;
}

@media (prefers-color-scheme: dark) {
	:root {
		--color-ink: #e8ece9;
		--color-paper: #12191d;
		--color-surface: #1b252b;
		--color-accent: #f0ad2c;
		--color-accent-ink: #1b1300;
		--color-muted: #9aa8af;
		--color-good: #5cc489;
		--color-bad: #ef776d;
		--color-focus: #6ea8ff;
	}
}
`,
	"global.css": `@import "./tokens.css";

*,
*::before,
*::after {
	box-sizing: border-box;
}

body {
	margin: 0;
	font-family: var(--font-body);
	font-size: var(--text-md);
	color: var(--color-ink);
	background: var(--color-paper);
	line-height: 1.5;
}

a {
	color: inherit;
	text-underline-offset: 3px;
}

:focus-visible {
	outline: 3px solid var(--color-focus);
	outline-offset: 2px;
}

.skip-link {
	position: absolute;
	left: var(--space-4);
	top: -100px;
}

.skip-link:focus {
	top: var(--space-4);
}

.muted {
	color: var(--color-muted);
}

.button {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-2) var(--space-4);
	border-radius: var(--radius);
	background: var(--color-accent);
	color: var(--color-accent-ink);
	font-weight: 600;
}
`,
};

function yaml(path: string, repo: string): string {
	if (base(path) === "mkdocs.yml")
		return `site_name: Acme docs
repo_url: https://git.acme.example/${repo}
theme:
  name: material
  palette:
    - scheme: default
      primary: blue grey
    - scheme: slate
      primary: blue grey
nav:
  - Home: index.md
  - Getting started: getting-started.md
  - Guides:
      - Agents: guides/agents.md
      - Reviews: guides/reviews.md
      - Branches: guides/branches.md
  - Reference:
      - API: reference/api.md
      - CLI: reference/cli.md
`;
	return `name: ${stem(path)}

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck --if-present
      - run: npm test
`;
}

const MIT = (holder: string) => `MIT License

Copyright (c) 2026 ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

/** One of tiny-lib's helpers: a function wrapping another, with a timer or a cache. */
function helperFile(path: string): string {
	const fn = camel(stem(path));
	const name = pascal(stem(path));
	if (fn === "index")
		return `export { debounce, type DebounceOptions } from "./debounce";
export { memo, type MemoOptions } from "./memo";
export { once } from "./once";
export { throttle, type ThrottleOptions } from "./throttle";
`;
	return `// ${fn}: wraps a function so it runs ${pick(path, ["less often", "only when it must", "on your terms"])}.

export interface ${name}Options {
	/** Run on the first call of a burst. */
	leading?: boolean;
	/** Run once more after the burst ends. */
	trailing?: boolean;
	/** For caches: how many results to keep. */
	size?: number;
}

export interface ${name}d<A extends unknown[], R> {
	(...args: A): R | undefined;
	/** Drops anything waiting. */
	cancel(): void;
	/** Runs anything waiting now. */
	flush(): R | undefined;
}

export function ${fn}<A extends unknown[], R>(
	fn: (...args: A) => R,
	ms = ${between(path, 50, 500)},
	options: ${name}Options = {},
): ${name}d<A, R> {
	const { leading = false, trailing = true } = options;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: A | undefined;
	let last: R | undefined;

	const run = () => {
		timer = undefined;
		if (!pending) return last;
		const args = pending;
		pending = undefined;
		last = fn(...args);
		return last;
	};

	const wrapped = ((...args: A) => {
		const idle = timer === undefined;
		pending = args;
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(() => {
			if (trailing) run();
			else pending = undefined;
			timer = undefined;
		}, ms);
		if (idle && leading) return run();
		return last;
	}) as ${name}d<A, R>;

	wrapped.cancel = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		pending = undefined;
	};
	wrapped.flush = () => {
		if (timer !== undefined) clearTimeout(timer);
		return run();
	};
	return wrapped;
}
`;
}

/** A file's text, made up from its path (and the repo's README). */
export function textOf(repo: string, path: string): string {
	const name = base(path);
	if (repo === "oss-friend/tiny-lib" && path.startsWith("src/")) return helperFile(path);
	if (name === "README.md") return README[repo] ?? `# ${repo.split("/")[1]}\n`;
	if (name === "LICENSE") return MIT(repo.startsWith("acme/") ? "Acme Storefront Co." : "Jo Lindgren");
	if (name === ".gitignore") return "node_modules/\ndist/\ncoverage/\n.env\n.env.*\n!.env.example\n*.log\n";
	if (name === ".prettierrc") return '{\n\t"useTabs": true,\n\t"printWidth": 120\n}\n';
	if (name === "robots.txt")
		return "User-agent: *\nDisallow: /cart\nDisallow: /checkout\nDisallow: /account\n\nSitemap: https://shop.acme.example/sitemap.xml\n";
	if (name === "vite.config.ts") return VITE_CONFIG;
	if (name.endsWith(".md")) return markdown(path, repo);
	if (name.endsWith(".json")) return jsonFile(path, repo);
	if (name.endsWith(".yml") || name.endsWith(".yaml")) return yaml(path, repo);
	if (name.endsWith(".css")) return CSS[name] ?? CSS["global.css"]!;
	if (/\.(test|spec)\.tsx?$/.test(name)) return testFile(path, repo);
	if (name.endsWith(".tsx")) return component(path);
	if (path.startsWith("scripts/")) return scriptFile(path);
	return moduleFile(path);
}

/** One file at a commit, as GET /repos/:owner/:name/file answers it. */
export function fileAt(repo: string, path: string, ref: string, commit: string): RepoFile {
	const name = base(path);
	if (TOO_BIG[name]) return { ref, commit, path, size: TOO_BIG[name], tooBig: true };
	if (BINARY.test(name)) return { ref, commit, path, size: between(path, 4_000, 180_000), binary: true };
	const text = textOf(repo, path);
	return { ref, commit, path, size: new TextEncoder().encode(text).length, text };
}
