// Asking twice keeps your place: opening a confirm moves focus to its Cancel, and Escape closes it with focus back on
// the button that asked. node web/visual/checks/confirm-focus.mjs, with npm run dev:web:fixtures on :5173 (or
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
const settle = (text) =>
	page
		.waitForFunction((want) => document.activeElement?.textContent?.trim() === want, text, { timeout: 2000 })
		.catch(() => {});

await remove.focus();
await page.keyboard.press("Enter");
await settle("Cancel");
const asked = await focused();
await page.keyboard.press("Escape");
await settle("Remove");
const back = await focused();
const open = await page.getByRole("button", { name: "Cancel" }).count();
await browser.close();

const ok = asked === "Cancel" && back === "Remove" && open === 0;
console.log(
	ok ? "confirm focus: ok" : `confirm focus: asked on "${asked}", back on "${back}", ${open} question(s) open`,
);
process.exit(ok ? 0 : 1);
