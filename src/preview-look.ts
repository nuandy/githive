// What a change's site preview looks like, as Clef sees it, beside a push's other hints (see push-hints.ts). A public
// repo that's a static site serves each change's latest push as a preview (src/routes/site.ts); Browser Run takes a
// wide and a narrow screenshot of it, and Clef is asked whether a person opening it would find it broken: blank,
// unstyled, laid out wrong, or showing an error. That catches what the browser check can't (a page with no errors that
// looks wrong), before review rather than after landing. It's a hint, so nothing waits on it and nothing is refused.

import type { Clef, ClefQuestion } from "./clef";
import type { PushHint } from "./push-hints";
import type { HistorySource } from "./toolkit/branch-history";

/** Takes screenshots of a page, as data URLs: the first wide, the next narrow. Empty when it couldn't. */
export type TakeShots = (url: string) => Promise<string[]>;

/** How sure Clef must be of a way the page looks broken before its agent is told. */
const BROKEN_AT = 0.7;
/** How long the page has to load, so a slow site still makes a push's hints within the queue's batch. */
const LOAD_MS = 15_000;
/** The windows the page is seen in: a laptop's, then a phone's. */
const WINDOWS = [
	{ width: 1280, height: 800 },
	{ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
];
/** The files a site's look depends on. A push that changes none of them is not looked at. */
const SITE_FILE = /\.(html?|css|m?js|svg|png|jpe?g|gif|webp|avif|woff2?)$/i;

const LOOKS: Record<string, string> = {
	fine: "Looks like a working page: styled, laid out, nothing in the way",
	blank: "Blank or nearly blank",
	unstyled: "Unstyled: plain HTML without its styles",
	layout: "Content overlaps, is cut off, or spills off the screen",
	error: "Shows an error message, a stack trace, or a page not found",
};

/** What each broken look is called in a hint. */
const SAID: Record<string, string> = {
	blank: "a blank page",
	unstyled: "no styles",
	layout: "content overlapping or cut off",
	error: "an error on the page",
};

const QUESTION: ClefQuestion = {
	type: "choice",
	instructions: "How does this web page look to a person who opens it, in these screenshots?",
	criteria: LOOKS,
};

/** Screenshots through a Browser Run binding, each as a JPEG data URL. A window that fails is left out. */
export function browserShots(browser: BrowserRun): TakeShots {
	return async (url) => {
		const shots = await Promise.all(
			WINDOWS.map((viewport) =>
				browser
					.quickAction("screenshot", {
						url,
						viewport,
						gotoOptions: { waitUntil: "networkidle0", timeout: LOAD_MS },
						bestAttempt: true,
						cacheTTL: 0,
						screenshotOptions: { type: "jpeg", quality: 70, encoding: "base64" },
					})
					.then(async (response) => (response.ok ? (await response.text()).trim() : null))
					.catch((err) => {
						console.error(`a screenshot of ${url} failed`, String(err));
						return null;
					}),
			),
		);
		return shots.filter((shot): shot is string => !!shot?.startsWith("data:image/"));
	};
}

/** Whether a push changes what its site looks like, and the site has a page to open at its root. */
export async function changesSite(source: HistorySource, push: { head: string; files: string[] }) {
	if (!push.files.some((file) => SITE_FILE.test(file))) return false;
	const [head] = await source.log(push.head, 1, 0);
	if (!head) return false;
	return !!(await source.readTree(head.treeHash))?.some((entry) => entry.name === "index.html");
}

/** What Clef makes of the preview at `url`, or null if it looks fine, or nothing could say. */
export async function previewHint(clef: Clef, shots: TakeShots, url: string): Promise<PushHint | null> {
	const images = await shots(url);
	if (!images.length) return null;
	const state = "Screenshots of one web page as a person opens it: in a laptop's window first, then on a phone.";
	const answer = (await clef.ask("clef", state, { looks: QUESTION }, images))?.looks;
	if (answer?.type !== "choice" || answer.choice === "fine") return null;
	const likelihood = Math.round((answer.probabilities[answer.choice] ?? 0) * 100) / 100;
	const said = SAID[answer.choice];
	if (!said || likelihood < BROKEN_AT) return null;
	return { kind: "looks_broken", says: `Its preview seems to show ${said}`, likelihood, url };
}
