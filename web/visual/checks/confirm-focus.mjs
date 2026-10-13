// Asking twice keeps your place: opening a confirm moves focus to the button that keeps things as they are ("Keep lee",
// or Cancel), and Escape closes it with focus back on the button that asked. node web/visual/checks/confirm-focus.mjs, with npm run dev:web:fixtures on :5173 (or
// BASE=http://localhost:<port>/).
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:5173/";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${BASE}#/repos/acme/storefront/settings`);
const remove = page.getByRole("button", { name: "Remove", exact: true }).first();
await remove.waitFor();
// What has focus: a button by its words, or <body> when focus fell off the page's controls.
const focused = () =>
	page.evaluate(() => {
		const active = document.activeElement;
		return !active || active === document.body ? "<body>" : (active.textContent?.trim().slice(0, 40) ?? active.tagName);
	});
// Focus moves in an effect after the render a key causes: wait for it, up to a point, before reading it.
const settle = (pattern) =>
	page
		.waitForFunction((source) => new RegExp(source).test(document.activeElement?.textContent?.trim() ?? ""), pattern, {
			timeout: 2000,
		})
		.catch(() => {});
// The button that keeps things as they are: "Keep <what>", or Cancel where nothing more specific fits.
const KEEP = "^(Keep\\b.*|Cancel)$";

await remove.focus();
await page.keyboard.press("Enter");
await settle(KEEP);
const asked = await focused();
await page.keyboard.press("Escape");
await settle("^Remove$");
const back = await focused();
const open = await page.getByRole("button", { name: new RegExp(KEEP) }).count();
await browser.close();

const ok = new RegExp(KEEP).test(asked) && back === "Remove" && open === 0;
console.log(
	ok ? "confirm focus: ok" : `confirm focus: asked on "${asked}", back on "${back}", ${open} question(s) open`,
);
process.exit(ok ? 0 : 1);
