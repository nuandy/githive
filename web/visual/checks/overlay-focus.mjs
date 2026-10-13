// Overlays with no trigger of their own give focus back as they close: the ⌘K palette and the list of shortcuts to what
// had it (the user menu's button, when the list opened from the menu), and a change's ⋯ → Release claim to the ⋯
// button, or to the decision box once the claim is released. node web/visual/checks/overlay-focus.mjs, with
// npm run dev:web:fixtures on :5173 (or BASE=http://localhost:<port>/).
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:5173/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// What has focus: the decision box by its id, a control by its label or words, or <body> when focus fell off the
// page's controls.
function nameOf(active) {
	if (!active || active === document.body) return "<body>";
	if (active.id === "decide") return "#decide";
	return (active.getAttribute("aria-label") ?? active.textContent ?? active.tagName).trim().slice(0, 40);
}
const focused = () => page.evaluate(`(${nameOf})(document.activeElement)`);
// Focus moves once an overlay's closing motion ends: wait for it, up to a point, before reading it.
const settle = (want) =>
	page
		.waitForFunction(`(${nameOf})(document.activeElement).startsWith(${JSON.stringify(want)})`, null, {
			timeout: 2000,
		})
		.catch(() => {});

const failures = [];
async function expectFocus(what, want) {
	await settle(want);
	const got = await focused();
	if (got !== want && !got.startsWith(want)) failures.push(`${what}: focus on "${got}", not "${want}"`);
}
const dialogs = () => page.locator('[role="dialog"], [role="alertdialog"]').count();

await page.goto(`${BASE}#/repos/acme/storefront`);
const inbox = page.getByRole("link", { name: /^Inbox/ });
await inbox.waitFor();

// ⌘K from a link, closed with Escape.
await inbox.focus();
await page.keyboard.press("Control+k");
await page.getByRole("combobox", { name: "Go to" }).waitFor();
await page.keyboard.press("Escape");
await expectFocus("⌘K, then Escape", "Inbox");

// ? from a link.
await inbox.focus();
await page.keyboard.press("?");
await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
await page.keyboard.press("Escape");
await expectFocus("?, then Escape", "Inbox");

// The list from the user menu: back to the menu's button.
const user = page.getByRole("button", { name: /^Signed in as/ });
await user.focus();
await page.keyboard.press("Enter");
await page.getByRole("menuitem", { name: "Keyboard shortcuts" }).click();
await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
await page.keyboard.press("Escape");
await expectFocus("Keyboard shortcuts from the user menu, then Escape", "Signed in as");

// ⌘K inside an open dialog opens no palette over it.
await page.keyboard.press("?");
await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
await page.keyboard.press("Control+k");
await page.waitForTimeout(300);
if ((await dialogs()) !== 1) failures.push(`⌘K in the shortcuts list: ${await dialogs()} dialogs open`);
await page.keyboard.press("Escape");
await expectFocus("?, ⌘K, then Escape", "Signed in as");

// A change's ⋯ → Release claim: back to ⋯ on Cancel, to the decision box once released.
await page.goto(`${BASE}#/repos/acme/storefront/changes/checkout-tax`);
const more = page.getByRole("button", { name: "More about this change" });
await more.waitFor();
const releaseFromMenu = async () => {
	await more.focus();
	await page.keyboard.press("Enter");
	await page.getByRole("menuitem", { name: /Release claim/ }).click();
	await page.getByRole("alertdialog").waitFor();
};
await releaseFromMenu();
await page.keyboard.press("Escape");
await expectFocus("⋯ → Release claim, then Escape", "More about this change");
await releaseFromMenu();
await page.getByLabel("Why").fill("Stuck on the tax tables");
await page.getByRole("button", { name: "Release claim", exact: true }).click();
await expectFocus("⋯ → Release claim, released", "#decide");

await browser.close();
console.log(failures.length ? `overlay focus:\n  ${failures.join("\n  ")}` : "overlay focus: ok");
process.exit(failures.length ? 1 : 0);
