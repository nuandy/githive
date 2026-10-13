// A map cell's details and the goals' filter stay in step. With one cell's details open, a click on another opens its
// details and filters to it; a click on that cell again closes them and clears the filter. Escape closes the details
// and keeps the filter; Enter opens them again.
// node web/visual/checks/hive-map-details.mjs, with npm run dev:web:fixtures on :5173 (or BASE=http://localhost:<port>/).
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:5173/";
const A = "src/auth/tokens.ts";
const B = "test/cart.test.ts";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
await page.goto(`${BASE}#/repos/acme/storefront`);
const cell = (key) => page.locator(`g[role="button"][data-cell="${key}"]`);
await cell(A).waitFor();

/** What shows: whose details are open, and what the goals are filtered to. */
const state = () =>
	page.evaluate(() => {
		const details = [...document.querySelectorAll('[role="dialog"]')].map((each) => each.getAttribute("aria-label"));
		const chip = [
			...document.querySelectorAll('section[aria-labelledby="goals-title"] button[aria-label$=": show every goal"]'),
		];
		const filter = chip.map((each) => each.getAttribute("aria-label").replace(/^Only (.*): show every goal$/, "$1"));
		const focused = document.activeElement?.getAttribute("data-cell") ?? "";
		return `details ${details.join(", ") || "closed"}; only ${filter.join(", ") || "nothing"}; focus ${focused || "off the map"}`;
	});
const problems = [];
/** Waits for the map to say `want`, up to a point, and notes it if it never does. */
async function expectState(step, want) {
	let got = "";
	for (let tries = 0; tries < 40; tries++) {
		got = await state();
		if (got.startsWith(want)) return;
		await page.waitForTimeout(50);
	}
	problems.push(`${step}: wanted ${want}, got ${got}`);
}

await cell(A).click();
await expectState(`a click on ${A}`, `details ${A}; only ${A}`);
await cell(B).click();
await expectState(`then a click on ${B}`, `details ${B}; only ${B}`);
await cell(B).click();
await expectState(`then ${B} again`, "details closed; only nothing");
await cell(B).focus();
await page.keyboard.press("Enter");
await expectState("Enter", `details ${B}; only ${B}`);
await page.keyboard.press("Escape");
await expectState("then Escape", `details closed; only ${B}; focus ${B}`);
await page.keyboard.press("Enter");
await expectState("then Enter again", `details ${B}; only ${B}`);
await browser.close();

console.log(problems.length ? `hive map details:\n  ${problems.join("\n  ")}` : "hive map details: ok");
process.exit(problems.length ? 1 : 0);
