// The skip link moves focus to the page's main column and leaves the address alone.
// node web/visual/checks/skip-link.mjs (needs npm run dev:web:fixtures on :5173, or BASE=http://localhost:<port>/)
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
