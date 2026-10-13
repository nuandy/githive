#!/usr/bin/env node
// githive-browser-check: a merge check that opens a website or web app in headless Chromium and fails when a page
// doesn't load cleanly or a button does nothing. GitHive installs it in every check container whose checks name it,
// and runs it from the top of the merged checkout like any other check.
//
//   githive-browser-check [--page /path]... [--root dir] [--start "command" --url URL] [--ignore selector]...
//
// Without --start it serves the checkout's files itself (--root, default the checkout), for a static site. With
// --start it runs that command and waits for --url to answer, for an app with a server. Each page fails on an uncaught
// error, a console error, or one of its own files failing to load. Then every visible button, [role=button], in-page
// link and <summary> is clicked from a fresh load, one at a time. A click that throws fails, and so does one after
// which the page is the same as before: no change to the DOM or form values, no navigation, no request, no dialog.
// The page is compared before and after, not watched for changes, so two handlers that undo each other count as
// doing nothing. A button that does nothing on a fresh page is tried again after other buttons were used first, as
// a Delete key does nothing until something is typed. Mark a button whose effect the page can't show (copying to the
// clipboard) with data-githive-ignore, or name it with --ignore.

import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, relative, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const CHROMIUM = process.env.GITHIVE_CHROMIUM ?? "/usr/bin/chromium";
/** The whole check stays inside the 10 minutes a check command gets. */
const CHECK_WITHIN_MS = 8 * 60_000;
const LOAD_WITHIN_MS = 30_000;
const START_WITHIN_MS = 120_000;
/** How long a page may stay busy after a click before it's compared: animations end and requests settle. */
const SETTLE_MS = 250;
/** The most clickables tried per page, so a long list can't use up the check's time. */
const CLICKS_PER_PAGE = 40;
/** The most other clickables used first when giving a button that did nothing another chance. */
const SECOND_CHANCES = 3;

const CLICKABLE =
	'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], a[href^="#"], summary';

const CONTENT_TYPES = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".txt": "text/plain",
};

class Usage extends Error {}

function parseArgs(argv) {
	const options = { pages: [], ignore: [], root: ".", start: undefined, url: undefined };
	for (let index = 0; index < argv.length; index += 2) {
		const [flag, value] = [argv[index], argv[index + 1]];
		if (value === undefined) throw new Usage(`${flag} needs a value`);
		if (flag === "--page") options.pages.push(value.startsWith("/") ? value : `/${value}`);
		else if (flag === "--ignore") options.ignore.push(value);
		else if (flag === "--root") options.root = value;
		else if (flag === "--start") options.start = value;
		else if (flag === "--url") options.url = value;
		else throw new Usage(`unknown option ${flag}`);
	}
	const unanswered = options.start ? !options.url : false;
	if (unanswered) throw new Usage("--start needs --url, where the app answers");
	if (!options.pages.length) options.pages.push("/");
	return options;
}

/** Serves `root` on a free local port, as a static host would: a folder's index.html for the folder. */
function serveFiles(root) {
	const base = resolve(root);
	const fileFor = (path) => {
		const file = resolve(join(base, decodeURIComponent(path.split("?")[0])));
		// Nothing outside the served folder, however the path is spelled.
		if (relative(base, file).startsWith("..")) return undefined;
		const found = statSync(file, { throwIfNoEntry: false });
		if (found?.isDirectory()) return fileFor(join(path.split("?")[0], "index.html"));
		return found?.isFile() ? file : undefined;
	};
	const server = createServer((request, response) => {
		const file = fileFor(request.url ?? "/");
		if (!file) {
			response.writeHead(404).end("not found");
			return;
		}
		response.writeHead(200, { "Content-Type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
		createReadStream(file).pipe(response);
	});
	return new Promise((done) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			done({ url: `http://127.0.0.1:${port}`, stop: () => server.close() });
		});
	});
}

/** Runs the app's start command and waits for its URL to answer. Its output goes into a failure's evidence. */
async function startApp(command, url) {
	let output = "";
	const app = spawn("bash", ["-lc", command], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
	const keep = (chunk) => {
		output = (output + chunk).slice(-2_000);
	};
	app.stdout.on("data", keep);
	app.stderr.on("data", keep);
	let exited = null;
	app.on("exit", (code) => {
		exited = code;
	});
	const stop = () => {
		try {
			process.kill(-app.pid, "SIGTERM");
		} catch {
			// It has already stopped.
		}
	};
	const until = Date.now() + START_WITHIN_MS;
	while (Date.now() < until) {
		if (exited !== null) throw new Error(`"${command}" exited with ${exited} before ${url} answered:\n${output}`);
		const answered = await fetch(url).then(
			() => true,
			() => false,
		);
		if (answered) return { url: new URL(url).origin, stop };
		await new Promise((done) => setTimeout(done, 500));
	}
	stop();
	throw new Error(`${url} didn't answer within ${START_WITHIN_MS / 1000} s of "${command}":\n${output}`);
}

/** Where the pages are: the app the start command runs, a URL already answering, or the checkout's files. */
function hostFor(options) {
	if (options.start) return startApp(options.start, options.url);
	if (options.url) return { url: new URL(options.url).origin, stop: () => undefined };
	return serveFiles(options.root);
}

/** Cloudflare's own scripts, which it adds to pages it serves (analytics under /cdn-cgi/): not the site's doing. */
const injected = (text) => text.includes("/cdn-cgi/");

const firstLine = (text) => String(text).split("\n")[0].slice(0, 300);

/** Opens `url` in a new tab, recording what goes wrong on it and what it does. */
async function open(browser, url, origin) {
	const page = await browser.newPage();
	const seen = { problems: [], requests: 0, dialogs: 0, popups: 0 };
	const own = (address) => {
		if (!address.startsWith(origin)) return false;
		if (injected(address)) return false;
		// Browsers ask for /favicon.ico whether or not a page names one.
		return new URL(address).pathname !== "/favicon.ico";
	};
	const answeredBadly = new Set();
	page.on("pageerror", (error) => seen.problems.push(`uncaught error: ${firstLine(error.message)}`));
	page.on("console", (message) => {
		if (message.type() !== "error") return;
		// A file that failed to load is reported once, from its response.
		if (message.text().startsWith("Failed to load resource")) return;
		if (injected(message.text())) return;
		seen.problems.push(`console error: ${firstLine(message.text())}`);
	});
	page.on("requestfailed", (request) => {
		if (!own(request.url())) return;
		// A file that answered with an error is reported once, for that answer.
		if (answeredBadly.has(request.url())) return;
		seen.problems.push(`${request.url()} failed to load: ${request.failure()?.errorText}`);
	});
	page.on("response", (response) => {
		if (!own(response.url())) return;
		if (response.status() < 400) return;
		answeredBadly.add(response.url());
		seen.problems.push(`${response.url()} answered ${response.status()}`);
	});
	page.on("request", () => {
		seen.requests += 1;
	});
	page.on("dialog", (dialog) => {
		seen.dialogs += 1;
		dialog.dismiss().catch(() => undefined);
	});
	page.on("popup", () => {
		seen.popups += 1;
	});
	await page.goto(url, { waitUntil: "load", timeout: LOAD_WITHIN_MS });
	return { page, seen };
}

async function settle(page) {
	await page.waitForNetworkIdle({ idleTime: 150, timeout: 3_000 }).catch(() => undefined);
	await new Promise((done) => setTimeout(done, SETTLE_MS));
}

/** The clickables a person could click now, in document order, each marked with its place for clicking it. */
function clickablesOn(page, ignore) {
	return page.evaluate(
		(selector, ignored) => {
			const visible = (element) => {
				if (!element.getClientRects().length) return false;
				return getComputedStyle(element).visibility !== "hidden";
			};
			const skipped = (element) => {
				if (element.closest("[data-githive-ignore]")) return true;
				return ignored.some((rule) => element.matches(rule));
			};
			const usable = [...document.querySelectorAll(selector)]
				.filter(visible)
				.filter((element) => !element.disabled)
				.filter((element) => !skipped(element));
			return usable.map((element, index) => {
				element.setAttribute("data-githive-click", String(index));
				const label = element.getAttribute("aria-label") || element.textContent?.trim() || element.value || element.id;
				const id = element.id ? `#${element.id}` : "";
				return `${element.tagName.toLowerCase()}${id} "${String(label || "").slice(0, 40)}"`;
			});
		},
		CLICKABLE,
		ignore,
	);
}

/** What a person would see change: the page's markup, its form values and its address. */
function stateOf(page) {
	return page.evaluate(() => {
		const markup = document.documentElement.outerHTML.replace(/ data-githive-click="\d+"/g, "");
		const fields = [...document.querySelectorAll("input, textarea, select")];
		const ticked = new Set(["checkbox", "radio"]);
		const values = fields.map((field) => (ticked.has(field.type) ? field.checked : field.value));
		return `${location.href}\u0001${markup}\u0001${values.join("\u0000")}`;
	});
}

/** Clicks the clickable at `index` and says what it did: whether anything changed, and any errors it caused. */
async function clickAndCompare(page, seen, index) {
	const before = { state: await stateOf(page), requests: seen.requests, dialogs: seen.dialogs, popups: seen.popups };
	const problems = seen.problems.length;
	const target = `[data-githive-click="${index}"]`;
	await page.click(target).catch(() => page.$eval(target, (element) => element.click()));
	await settle(page);
	const after = await stateOf(page).catch(() => "");
	const effect =
		after !== before.state ||
		seen.requests > before.requests ||
		seen.dialogs > before.dialogs ||
		seen.popups > before.popups;
	return { effect, errors: seen.problems.slice(problems) };
}

/** A fresh tab on the page, with its clickables listed. */
async function fresh(browser, url, origin, ignore) {
	const opened = await open(browser, url, origin);
	await settle(opened.page);
	const labels = await clickablesOn(opened.page, ignore);
	return { ...opened, labels };
}

async function tryClickable(browser, url, origin, ignore, index) {
	const { page, seen, labels } = await fresh(browser, url, origin, ignore);
	try {
		if (index >= labels.length) return { effect: true, errors: [] };
		return await clickAndCompare(page, seen, index);
	} finally {
		await page.close();
	}
}

/** Whether the clickable labelled `label` does something once the one at `helper` has been clicked first. */
async function worksAfter(browser, url, origin, ignore, helper, label) {
	const { page, seen } = await fresh(browser, url, origin, ignore);
	try {
		await clickAndCompare(page, seen, helper);
		// The helper may have changed which elements are clickable, so find this one again by its label.
		const index = (await clickablesOn(page, ignore)).indexOf(label);
		if (index < 0) return false;
		return (await clickAndCompare(page, seen, index)).effect;
	} finally {
		await page.close();
	}
}

async function checkPage(browser, origin, path, ignore, deadline) {
	const url = new URL(path, origin).href;
	const problems = [];
	const first = await fresh(browser, url, origin, ignore);
	problems.push(...first.seen.problems.map((problem) => `${path}: ${problem}`));
	const labels = first.labels;
	await first.page.close();
	if (labels.length > CLICKS_PER_PAGE)
		problems.push(`${path}: only the first ${CLICKS_PER_PAGE} of ${labels.length} clickables were tried`);
	const working = [];
	const dead = [];
	for (let index = 0; index < Math.min(labels.length, CLICKS_PER_PAGE); index++) {
		if (Date.now() > deadline) break;
		const clicked = await tryClickable(browser, url, origin, ignore, index);
		for (const error of clicked.errors) problems.push(`${path}: clicking ${labels[index]} caused ${error}`);
		// A click that failed is reported for its error, not again for doing nothing.
		if (clicked.errors.length) continue;
		if (clicked.effect) working.push(index);
		else dead.push(index);
	}
	for (const index of dead) {
		const helpers = working.slice(0, SECOND_CHANCES);
		let works = false;
		for (const helper of helpers) {
			if (Date.now() > deadline) break;
			works = await worksAfter(browser, url, origin, ignore, helper, labels[index]);
			if (works) break;
		}
		if (works) continue;
		const tried = helpers.length ? `, also after clicking ${helpers.map((helper) => labels[helper]).join(", ")}` : "";
		problems.push(`${path}: clicking ${labels[index]} changed nothing on the page${tried}`);
	}
	return { problems, clickables: Math.min(labels.length, CLICKS_PER_PAGE) };
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const deadline = Date.now() + CHECK_WITHIN_MS;
	const host = await hostFor(options);
	const origin = host.url;
	const browser = await puppeteer.launch({
		executablePath: CHROMIUM,
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
	});
	// As a person's browser allows a page to copy on a click. Headless Chromium otherwise refuses some runs and not
	// others, which would make a Copy or Share button pass or fail by chance.
	await browser
		.defaultBrowserContext()
		.overridePermissions(origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
	const problems = [];
	let clickables = 0;
	try {
		for (const path of options.pages) {
			const checked = await checkPage(browser, origin, path, options.ignore, deadline);
			problems.push(...checked.problems);
			clickables += checked.clickables;
		}
	} finally {
		await browser.close();
		host.stop();
	}
	if (Date.now() > deadline)
		problems.push(`stopped after ${CHECK_WITHIN_MS / 60_000} minutes: not every click was tried`);
	const counted = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
	const pages = counted(options.pages.length, "page");
	if (!problems.length) {
		console.log(`browser check passed: ${pages}, ${counted(clickables, "clickable")}, each did something, no errors`);
		return 0;
	}
	console.log(`browser check failed on ${pages}:`);
	for (const problem of problems) console.log(`- ${problem}`);
	console.log(
		"A button whose effect the page can't show (copying to the clipboard) can be marked data-githive-ignore.",
	);
	return 1;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.log(error instanceof Usage ? `githive-browser-check: ${error.message}` : `browser check: ${error.message}`);
		process.exit(error instanceof Usage ? 2 : 1);
	},
);
