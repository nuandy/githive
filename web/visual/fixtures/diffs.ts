import type { ChangeDiff, FileDiff } from "../../src/api.ts";
import { inLane } from "../../../src/claim-paths.ts";
import { unifiedDiff } from "../../../src/unified-diff.ts";
import { textOf } from "./files.ts";
import { sha } from "./ids.ts";
import type { RepoFixture } from "./repo.ts";

// Each change's files, as GET /repos/:owner/:name/changes/:change/diff answers them. The texts are the fixtures' own
// made-up files (files.ts) with an edit each, diffed by the server's own code, so the hunks are real ones. A few
// storefront changes have their edits written out, so their Files tabs read like the work they claim: checkout-tax
// touches a file outside its claim, cart-coupons has a test long enough to start folded, hero-banner a binary image,
// and sitemap-script a lock file too big to diff.

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?)$/;
const TOO_BIG = /package-lock\.json$/;

/** An edit to a file: lines added about `at` of the way through, and a line replaced; or the file added or removed. */
type Edit = { add?: string[]; at?: number; replace?: [from: string, to: string] } | "added" | "removed";

const range = <T>(count: number, line: (index: number) => T): T[] => Array.from({ length: count }, (_, i) => line(i));

const EDITS: Record<string, Record<string, Edit>> = {
	"checkout-tax": {
		"src/components/checkout/OrderSummary.tsx": {
			replace: [
				"\treturn (",
				[
					"\tconst tax = taxLine(subtotal, address.country);",
					'\tconst taxLabel = tax.included ? t("summary.vat") : t("summary.tax");',
					"",
					"\treturn (",
				].join("\n"),
			],
			at: 0.75,
			add: ["\t\t\t<SummaryRow label={taxLabel} amount={tax.amount} muted={tax.included} />"],
		},
		"src/lib/currency.ts": {
			at: 0.8,
			add: [
				"",
				"/** The order's tax for a shipping country: a line of its own, or included (EU addresses show incl. VAT). */",
				"export function taxLine(subtotal: number, country: string): { amount: number; included: boolean } {",
				"\tconst rate = TAX_RATES[country] ?? 0;",
				"\tconst included = EU.has(country);",
				"\tconst amount = included ? subtotal - subtotal / (1 + rate) : subtotal * rate;",
				"\treturn { amount: roundHalfEven(amount), included };",
				"}",
			],
		},
		"test/currency.test.ts": {
			at: 0.7,
			add: [
				'describe("taxLine", () => {',
				'\tit("includes VAT for EU addresses", () => {',
				'\t\texpect(taxLine(119, "DE")).toEqual({ amount: 19, included: true });',
				"\t});",
				'\tit("adds tax as its own line elsewhere", () => {',
				'\t\texpect(taxLine(100, "CA")).toEqual({ amount: 5, included: false });',
				"\t});",
				"});",
			],
		},
		"src/i18n/en.json": { at: 0.4, add: ['\t"summary.tax": "Tax",', '\t"summary.vat": "incl. VAT",'] },
	},
	"cart-coupons": {
		"src/lib/cart.ts": {
			at: 0.6,
			add: [
				"",
				"/** Applies a coupon code to the cart and keeps it with the cart, so a reload keeps the discount. */",
				"export function applyCoupon(cart: Cart, code: string): Cart {",
				"\tconst coupon = COUPONS[code.trim().toUpperCase()];",
				'\tif (!coupon) return { ...cart, couponError: "That code isn\'t valid." };',
				"\treturn persist({ ...cart, coupon: coupon.code, discount: coupon.percent });",
				"}",
			],
			replace: ["export", "export interface Cart { items: CartItem[]; coupon?: string; discount?: number }"],
		},
		"src/components/CartDrawer.tsx": {
			at: 0.5,
			add: [
				'\t\t\t<form className="coupon" onSubmit={applyCode}>',
				'\t\t\t\t<label htmlFor="coupon">Coupon code</label>',
				'\t\t\t\t<input id="coupon" value={code} onChange={(event) => setCode(event.target.value)} />',
				'\t\t\t\t<button type="submit">Apply</button>',
				"\t\t\t</form>",
			],
		},
		"test/cart.test.ts": {
			at: 0.9,
			add: [
				'describe("coupons", () => {',
				...range(54, (i) => [
					`\tit("applies SAVE${10 + i} to a cart of ${i + 1} items", () => {`,
					`\t\tconst cart = applyCoupon(cartOf(${i + 1}), "SAVE${10 + i}");`,
					`\t\texpect(totalOf(cart)).toBe(${((i + 1) * 20 * (90 - i)) / 100});`,
					"\t});",
				]).flat(),
				"});",
			],
		},
	},
	"hero-banner": {
		"src/pages/Home.tsx": {
			at: 0.4,
			add: ['\t\t\t<HeroBanner crops={HERO_CROPS} promo="/promo/autumn" />'],
			replace: ["return", "\treturn ("],
		},
		"src/components/HeroBanner.tsx": "added",
		"public/images/hero.webp": { add: [] },
	},
	"stock-sync": {
		"src/lib/inventory.ts": {
			at: 0.3,
			add: [
				"/** How often the warehouse feed is read: every 5 minutes, backing off when it answers 429. */",
				"export const SYNC_EVERY_MS = 5 * 60_000;",
			],
		},
		"scripts/seed.ts": { at: 0.5, add: ["\tawait syncStock({ every: SYNC_EVERY_MS });"] },
	},
	"sitemap-script": {
		"scripts/build-sitemap.ts": {
			at: 0.5,
			add: ["\tconst urls = catalog.map((product) => `${SITE}/p/${product.slug}`);"],
		},
		"public/robots.txt": { add: [] },
		"package-lock.json": { add: [] },
	},
};

/** The text a file has after an edit, or null where the edit removes it. */
function edited(before: string, edit: Exclude<Edit, "added" | "removed">): string {
	const lines = before.split("\n");
	if (edit.replace) {
		// The line itself, else the first that holds it.
		const exact = lines.indexOf(edit.replace[0]);
		const index = exact >= 0 ? exact : lines.findIndex((line) => line.includes(edit.replace![0]));
		if (index >= 0) lines[index] = edit.replace[1];
	}
	if (edit.add?.length) {
		const at = Math.max(1, Math.round((lines.length - 1) * (edit.at ?? 0.5)));
		lines.splice(at, 0, ...edit.add);
	}
	return lines.join("\n");
}

/** A change's claimed paths as files: a claimed folder as the repo's files in it, or a new one there. */
function claimedFiles(repo: RepoFixture, paths: string[]): string[] {
	return paths.flatMap((path) => {
		if (!path.endsWith("/")) return [path];
		const inside = repo.files.filter((file) => file.startsWith(path)).slice(0, 3);
		return inside.length ? inside : [`${path}index.ts`];
	});
}

/** One file's diff: its sides made up from its path and the edit. */
function fileDiff(repo: RepoFixture, path: string, edit: Edit, claimed: string[] | null): FileDiff {
	const exists = repo.files.includes(path);
	const status = edit === "added" || !exists ? "added" : edit === "removed" ? "removed" : "modified";
	const file: FileDiff = { path, status, ...(claimed && !inLane(path, claimed) ? { outside: true as const } : {}) };
	if (BINARY.test(path)) return { ...file, binary: true };
	if (TOO_BIG.test(path)) return { ...file, tooBig: true };
	const text = textOf(repo.fullName, path);
	const before = status === "added" ? "" : text;
	const after =
		status === "removed"
			? ""
			: status === "added" && typeof edit !== "object"
				? text
				: edited(status === "added" ? text : before, typeof edit === "object" ? edit : {});
	const { hunks, added, removed } = unifiedDiff(before, after);
	return { ...file, added, removed, hunks };
}

/** A generic edit for a file no story writes out: a few lines in its middle, after what the change says it does. */
const generic = (intent: string): Edit => ({
	at: 0.5,
	add: ["", `// ${intent.split("\n")[0]}`, "export const changed = true;"],
});

/** A change's files: its pushed head against where it left its branch, or what it landed as. Null for no change. */
export function diffOf(repo: RepoFixture, change: string): ChangeDiff | null {
	const hive = repo.hive;
	if (!hive) return null;
	const claim = hive.snapshot.claims.find((each) => each.change === change);
	const history = hive.changes.get(change);
	if (!claim && !history) return null;
	const landedAs = history?.released.find((release) => release.mergedAs)?.mergedAs;
	const head = claim ? claim.head : (landedAs ?? history?.commits[0]?.commit ?? null);
	if (!head) return { change, of: "head", base: null, head: null, files: [], total: 0 };
	// A landed change's files are the ones its merge touched, as the branch's history lists them.
	const landed = Object.values(hive.histories)
		.flatMap((branch) => branch.changes)
		.find((each) => each.change === change);
	const paths = claim?.paths ?? history?.claim?.paths ?? landed?.files ?? [];
	const intent = claim?.intent ?? history?.claim?.intent ?? landed?.intent ?? change;
	const edits = EDITS[change] ?? Object.fromEntries(claimedFiles(repo, paths).map((path) => [path, generic(intent)]));
	const files = Object.entries(edits)
		.map(([path, edit]) => fileDiff(repo, path, edit, claim ? claim.paths : null))
		.sort((a, b) => a.path.localeCompare(b.path));
	return {
		change,
		of: landedAs && !claim ? "landed" : "head",
		base: landedAs && !claim ? sha(`${repo.fullName}:${change}:before`) : sha(`${repo.fullName}:base:${change}`),
		head,
		files,
		total: files.length,
	};
}
