// The goals hold still only while someone reads them. Clicking "N new" brings the goals in and the button goes; once
// the reader leaves the panel, what comes next comes straight in, though the button had the focus when it went (and
// the same for the filter's chip). From the keyboard, Enter on it leaves the focus in the panel, on In flight.
// node web/visual/checks/goals-hold.mjs, with npm run dev:web:fixtures on :5173 (or BASE=http://localhost:<port>/).
import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:5173/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
await page.goto(`${BASE}playground.html?scenario=mixed&seed=1&speed=1`);
await page.getByRole("button", { name: "Pause", exact: true }).click();
const panel = page.locator('section[aria-labelledby="goals-title"]');
const pending = panel.getByRole("button", { name: /: show them$/ });
// The rows as drawn, in order: in flight, then finished.
const drawn = () => panel.locator("li[data-key]").evaluateAll((rows) => rows.map((row) => row.dataset.key).join(" "));
// The run moves on ten minutes without the pointer or the focus going anywhere.
const skipButton = page.getByRole("button", { name: "Skip 10 min", exact: true });
const skip = () => skipButton.evaluate((button) => button.click());
/** Skips until `done` says so, up to a point; whether it did. */
async function skipUntil(done) {
	for (let tries = 0; tries < 12; tries++) {
		if (await done()) return true;
		await skip();
		await page.waitForTimeout(50);
	}
	return done();
}
const problems = [];

// Reading: the focus on a row holds what arrives behind "N new". (The pointer would too, but the playground's bar grows
// as people are needed, and the panel moves out from under a pointer that stays put.)
const firstRow = panel.locator('button[aria-expanded="false"]').first();
await firstRow.focus();
if (!(await skipUntil(async () => (await pending.count()) > 0))) problems.push("nothing waited behind “N new”");
else {
	await pending.click();
	// Gone: the pointer leaves, and nothing else is clicked or focused.
	await page.mouse.move(4, 600);
	const before = await drawn();
	let held = false;
	const moved = await skipUntil(async () => {
		held ||= (await pending.count()) > 0;
		return held || (await drawn()) !== before;
	});
	if (held) problems.push("after “N new” and leaving the panel, the goals were still held");
	else if (!moved) problems.push("no goal arrived or finished to check with");
}

// The same once a filter's chip is cleared: it goes too.
await panel
	.getByRole("button", { name: /^Only .*'s goals$/ })
	.first()
	.click();
await panel.getByRole("button", { name: /: show every goal$/ }).click();
await page.mouse.move(4, 600);
{
	const before = await drawn();
	let held = false;
	const moved = await skipUntil(async () => {
		held ||= (await pending.count()) > 0;
		return held || (await drawn()) !== before;
	});
	if (held) problems.push("after clearing the filter and leaving the panel, the goals were still held");
	else if (!moved) problems.push("no goal arrived or finished to check the filter with");
}

// From the keyboard: the focus stays in the panel once the button goes.
await firstRow.focus();
if (await skipUntil(async () => (await pending.count()) > 0)) {
	await pending.focus();
	await page.keyboard.press("Enter");
	await page.waitForTimeout(50);
	const focused = await page.evaluate(() => {
		const active = document.activeElement;
		const inPanel = !!active?.closest('section[aria-labelledby="goals-title"]');
		if (!active || active === document.body) return "on <body>";
		return `${inPanel ? "in the panel" : "outside the panel"}: ${active.textContent?.trim().slice(0, 30) || active.tagName}`;
	});
	if (!focused.startsWith("in the panel: In flight")) problems.push(`Enter on “N new” left the focus ${focused}`);
} else problems.push("nothing waited behind “N new” the second time");
await browser.close();

console.log(problems.length ? `goals hold: ${problems.join("; ")}` : "goals hold: ok");
process.exit(problems.length ? 1 : 0);
