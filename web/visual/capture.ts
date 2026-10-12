// Captures every scene of the dashboard as screenshots, for comparing one build with another (compare.ts).
//
//   node web/visual/capture.ts <label> [--only <regex>] [--jobs <n>]
//
// Starts the dashboard's dev server, answers every API request from fixtures.ts with the clock frozen at FIXED_NOW,
// and writes web/visual/out/<label>/<scene>.<light|dark>.<width>.png. Motion scenes also write one frame per sampled
// time, with every animation paused and seeked there, so a motion compares frame by frame.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { createServer } from "vite";
import { answer, FIXED_NOW } from "./fixtures.ts";
import { SCENES, type Scene, type Scheme } from "./scenes.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const OUT = join(ROOT, "web/visual/out");
const API = /^\/(repos|api|summaries|live|me|auth|orgs|admin|demo)(\/|$|\?)/;

const args = process.argv.slice(2);
const label = args[0];
if (!label || label.startsWith("-")) {
	console.error("usage: node web/visual/capture.ts <label> [--only <regex>] [--jobs <n>]");
	process.exit(2);
}
const flag = (name: string) => {
	const at = args.indexOf(name);
	return at >= 0 ? args[at + 1] : undefined;
};
const only = flag("--only") ? new RegExp(flag("--only")!) : null;
// More pages at once than this and Chromium, short of CPU, now and then sets text with other glyph advances.
const jobs = Number(flag("--jobs") ?? 3);

const dir = join(OUT, label);
if (!only) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

/** Every page gets the same "random" numbers, so nothing drawn at random moves between runs. */
const SEEDED_RANDOM = `(() => {
	let seed = 0x2f6b9c1d;
	Math.random = () => {
		seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
})();`;

/** Counts DOM changes, so a page counts as settled once nothing has changed for a while. */
const MUTATIONS = `(() => {
	window.__mutations = 0;
	new MutationObserver(() => window.__mutations++).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();`;

interface Job {
	scene: Scene;
	scheme: Scheme;
	width: number;
}

const realWait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function newContext(browser: Browser, job: Job): Promise<{ context: BrowserContext; pending: () => number }> {
	const { scene, scheme, width } = job;
	const context = await browser.newContext({
		viewport: { width, height: scene.height ?? 900 },
		deviceScaleFactor: 1,
		colorScheme: scheme,
		reducedMotion: "no-preference",
		locale: "en-US",
		timezoneId: "UTC",
	});
	let inFlight = 0;
	await context.route(
		(url) => API.test(url.pathname),
		async (route) => {
			inFlight++;
			try {
				const request = route.request();
				const url = new URL(request.url());
				const reply = answer(request.method(), url, scene.who ?? "admin");
				if (!reply) console.warn(`  no fixture: ${request.method()} ${url.pathname}${url.search}`);
				await route.fulfill({
					status: reply?.status ?? 404,
					contentType: "application/json",
					body: JSON.stringify(reply?.body ?? { error: "no fixture" }),
				});
			} finally {
				inFlight--;
			}
		},
	);
	// The live feed connects and then never says anything.
	await context.routeWebSocket(/\/live/, () => {});
	await context.addInitScript(SEEDED_RANDOM);
	await context.addInitScript(MUTATIONS);
	if (scene.storage) await context.addInitScript(storageScript(scene.storage));
	return { context, pending: () => inFlight };
}

const storageScript = (entries: Record<string, string>) =>
	`(() => { const entries = ${JSON.stringify(entries)}; for (const key in entries) localStorage.setItem(key, entries[key]); })();`;

/** Waits until no request is pending, no frame's DOM has changed for a while and no finite animation is still
 * running in any frame, then for fonts. */
async function settle(page: Page, pending: () => number, quietMs = 400, mostMs = 15_000) {
	const started = Date.now();
	let last = "";
	let quietSince = Date.now();
	while (Date.now() - started < mostMs) {
		await realWait(100);
		const states = await Promise.all(
			page.frames().map((frame) =>
				frame
					.evaluate(() => {
						const moving = document
							.getAnimations()
							.filter(
								(each) => each.playState === "running" && each.effect?.getComputedTiming().iterations !== Infinity,
							).length;
						return `${(window as unknown as { __mutations?: number }).__mutations ?? 0}:${moving}`;
					})
					.catch(() => "gone"),
			),
		);
		const state = states.join(" ");
		const moving = states.some((each) => !each.endsWith(":0") && each !== "gone");
		if (state !== last || moving || pending() > 0) {
			last = state;
			quietSince = Date.now();
		} else if (Date.now() - quietSince >= quietMs) break;
	}
	await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Infinite animations (a pulse, a blink) hold their first frame; finite ones jump to their end. In every frame:
 * the playground's narrow view draws into an iframe, whose animations run on a timeline of its own. */
async function stillAnimations(page: Page) {
	for (const frame of page.frames())
		await frame.evaluate(() => {
			for (const animation of document.getAnimations()) {
				const timing = animation.effect?.getComputedTiming();
				if (timing && timing.iterations === Infinity) {
					animation.pause();
					animation.currentTime = 0;
				} else {
					try {
						animation.finish();
					} catch {
						animation.cancel();
					}
				}
			}
		});
}

/** Makes the window as tall as the page, so one ordinary screenshot holds all of it. Playwright's full-page capture
 * paints what lies beyond the window in a way that moves a select's text by a pixel between builds that lay it out
 * identically. */
async function growToPage(page: Page, job: Job, pending: () => number) {
	const least = job.scene.height ?? 900;
	for (let tries = 0; tries < 3; tries++) {
		const tall = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight));
		const height = Math.max(least, tall);
		if (height === page.viewportSize()?.height) return;
		await page.setViewportSize({ width: job.width, height });
		if (job.scene.clock === "paused") await page.clock.runFor(1_000);
		await settle(page, pending);
	}
}

function fileName(job: Job, suffix = "") {
	return `${job.scene.name}.${job.scheme}.${job.width}${suffix}.png`;
}

async function capture(browser: Browser, job: Job) {
	const { scene } = job;
	const { context, pending } = await newContext(browser, job);
	const page = await context.newPage();
	page.on("pageerror", (error) => console.warn(`  ${scene.name}: page error: ${error.message}`));
	try {
		await page.clock.install({ time: FIXED_NOW });
		if (scene.clock === "paused") await page.clock.pauseAt(FIXED_NOW);
		else await page.clock.setFixedTime(FIXED_NOW);
		await page.goto(scene.url, { waitUntil: "load" });
		await settle(page, pending);
		if (scene.act) {
			await scene.act(page);
			await settle(page, pending);
		}
		if (!scene.motion) {
			// Nothing hovered, and the page at its top: whatever the act's click left under the pointer, or scrolled to,
			// settles before the capture, so sticky bars sit where they always do in a full-page shot.
			await page.mouse.move(0, 0);
			await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
			if (scene.clock === "paused") await page.clock.runFor(2_000);
			await settle(page, pending);
		}
		if (scene.motion) {
			await captureMotion(page, job);
			return;
		}
		await growToPage(page, job, pending);
		await stillAnimations(page);
		await page.screenshot({ path: join(dir, fileName(job)), animations: "disabled", caret: "hide" });
	} finally {
		await context.close();
	}
}

/** Triggers the scene's motion, pauses every animation it starts, and captures each sampled time. */
async function captureMotion(page: Page, job: Job) {
	const motion = job.scene.motion!;
	await stillAnimations(page);
	await page.evaluate(() => {
		(window as unknown as { __before: Set<Animation> }).__before = new Set(document.getAnimations());
	});
	await motion.trigger(page);
	// Wait for the motion's animations to start, then a little longer for any its first frame starts in turn.
	const started = Date.now();
	while (Date.now() - started < 2_000) {
		const fresh = await page.evaluate(
			() =>
				document
					.getAnimations()
					.filter((each) => !(window as unknown as { __before: Set<Animation> }).__before.has(each)).length,
		);
		if (fresh > 0) break;
		await realWait(10);
	}
	await realWait(60);
	await page.evaluate(() => {
		const before = (window as unknown as { __before: Set<Animation> }).__before;
		const moving = document.getAnimations().filter((each) => !before.has(each));
		for (const animation of moving) animation.pause();
		(window as unknown as { __moving: Animation[] }).__moving = moving;
	});
	const clip = motion.clip ? await page.locator(motion.clip).first().boundingBox() : null;
	for (const at of motion.at) {
		await page.evaluate((time) => {
			for (const animation of (window as unknown as { __moving: Animation[] }).__moving) animation.currentTime = time;
		}, at);
		await page.screenshot({
			path: join(dir, fileName(job, `.t${String(at).padStart(4, "0")}`)),
			...(clip ? { clip } : {}),
			caret: "hide",
		});
	}
}

async function main() {
	const server = await createServer({
		configFile: join(ROOT, "web/vite.config.ts"),
		server: { port: 5191, strictPort: true },
		logLevel: "error",
	});
	await server.listen();
	const address = server.httpServer?.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const base = `http://localhost:${port}`;

	const queue: Job[] = [];
	for (const scene of SCENES) {
		if (only && !only.test(scene.name)) continue;
		for (const scheme of scene.schemes ?? (["light", "dark"] as Scheme[]))
			for (const width of scene.widths ?? [1280, 390])
				queue.push({ scene: { ...scene, url: `${base}${scene.url}` }, scheme, width });
	}

	const browser = await chromium.launch();
	console.log(`capturing ${queue.length} shots into ${dir}`);
	const startedAt = Date.now();
	let done = 0;
	let failed = 0;
	const worker = async () => {
		for (let job = queue.shift(); job; job = queue.shift()) {
			try {
				await capture(browser, job);
			} catch (error) {
				failed++;
				console.error(`  failed: ${fileName(job)}: ${(error as Error).message.split("\n")[0]}`);
			}
			done++;
			if (done % 20 === 0) console.log(`  ${done} done`);
		}
	};
	await Promise.all(Array.from({ length: jobs }, worker));
	await browser.close();
	await server.close();
	console.log(`${done} shots in ${Math.round((Date.now() - startedAt) / 1000)} s${failed ? `, ${failed} failed` : ""}`);
	if (failed) process.exitCode = 1;
}

await main();
