import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import css from "../theme.css?raw";

// lib/theme.ts keeps the choice in a module-level store, so each test loads it fresh into a fake window: storage,
// the system's color scheme (which a test can flip) and <html>'s class and data-theme.

type Listener = () => void;

function fakeWindow({ stored, systemDark = false }: { stored?: string | null; systemDark?: boolean }) {
	const storage = new Map<string, string>(stored ? [["githive.theme", stored]] : []);
	const schemeListeners: Listener[] = [];
	const scheme = { matches: systemDark };
	const classes = new Set<string>();
	const html = {
		classList: {
			toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
			contains: (name: string) => classes.has(name),
		},
		dataset: {} as Record<string, string>,
	};
	vi.stubGlobal("document", { documentElement: html });
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		matchMedia: (query: string) => ({
			matches: query.includes("dark") ? scheme.matches : false,
			addEventListener: (_: string, listener: Listener) => schemeListeners.push(listener),
		}),
		addEventListener: () => {},
	});
	return {
		storage,
		dark: () => classes.has("dark"),
		chosen: () => html.dataset.theme,
		setSystemDark(dark: boolean) {
			scheme.matches = dark;
			for (const listener of schemeListeners) listener();
		},
	};
}

const load = () => import("./theme");

describe("the theme", () => {
	beforeEach(() => vi.resetModules());
	afterEach(() => vi.unstubAllGlobals());

	it("reads the stored choice, and falls back to the system's for anything else", async () => {
		fakeWindow({ stored: "dark" });
		expect((await load()).readChoice()).toBe("dark");
		vi.resetModules();
		fakeWindow({ stored: "purple" });
		expect((await load()).readChoice()).toBe("system");
		vi.resetModules();
		fakeWindow({ stored: null });
		expect((await load()).readChoice()).toBe("system");
	});

	it("falls back to the system's when storage can't be read", async () => {
		fakeWindow({});
		(window as unknown as { localStorage: { getItem: () => never } }).localStorage.getItem = () => {
			throw new Error("denied");
		};
		expect((await load()).readChoice()).toBe("system");
	});

	it("resolves system to what the system shows", async () => {
		fakeWindow({ systemDark: true });
		const theme = await load();
		expect(theme.resolveTheme("system")).toBe("dark");
		expect(theme.resolveTheme("light")).toBe("light");
	});

	it("keeps a choice, shows it, and holds native controls to it", async () => {
		const page = fakeWindow({});
		const theme = await load();
		theme.setThemeChoice("dark");
		expect(page.storage.get("githive.theme")).toBe("dark");
		expect(page.dark()).toBe(true);
		expect(page.chosen()).toBe("dark");

		theme.setThemeChoice("system");
		expect(page.storage.has("githive.theme")).toBe(false);
		expect(page.dark()).toBe(false);
		expect(page.chosen()).toBeUndefined();
	});

	it("follows the system while the choice is system, and not otherwise", async () => {
		const page = fakeWindow({});
		const theme = await load();
		theme.keepThemeCurrent();
		page.setSystemDark(true);
		expect(page.dark()).toBe(true);

		theme.setThemeChoice("light");
		page.setSystemDark(false);
		page.setSystemDark(true);
		expect(page.dark()).toBe(false);
	});
});

// What theme.css says, scheme by scheme: a scheme that doesn't set a value inherits :root's.
const block = (selector: string) => {
	const start = css.indexOf(`\n${selector} {`);
	return css.slice(start, css.indexOf("}", start));
};
const declared = (selector: string, name: string) =>
	block(selector).match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\b`, "i"))?.[1];
const value = (selector: string, name: string) => declared(selector, name) ?? declared(":root", name);
const luminance = (hex: string) => {
	const [r, g, b] = [1, 3, 5]
		.map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
		.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
	const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (light! + 0.05) / (dark! + 0.05);
};
const SCHEMES = [":root", ".dark"];

/** Asserts `fore` reads on each of `backs` at `least`, in every scheme. */
function reads(fore: string, backs: string[], least: number) {
	for (const scheme of SCHEMES)
		for (const back of backs)
			it(`${fore} on ${back}, ${scheme}: ${least}:1 or more`, () => {
				const [a, b] = [value(scheme, fore), value(scheme, back)];
				expect(a, `--${fore}`).toBeDefined();
				expect(b, `--${back}`).toBeDefined();
				expect(contrast(a!, b!)).toBeGreaterThanOrEqual(least);
			});
}

// Text on a solid status fill (Merge, a solid badge, the inbox count) takes that fill's -foreground, which must read
// on it in each scheme.
describe("text on a solid status color", () => {
	for (const tone of ["good", "bad", "warn", "needs"]) reads(`${tone}-foreground`, [tone], 4.5);
});

// A status in words (a soft pill, a step, a banner) sits on its own tint, or on the muted surfaces rows and boxes use.
describe("status text", () => {
	for (const tone of ["good", "bad", "warn", "needs", "neutral"])
		reads(tone, [`${tone}-soft`, "surface-2", "surface-3", "card", "background"], 4.5);
	reads("link", ["link-soft", "surface-2", "surface-3", "card", "background"], 4.5);
});

// Muted words, placeholders among them, read wherever they're set.
describe("muted text", () => {
	reads("muted-foreground", ["card", "background", "surface-2", "surface-3"], 4.5);
});

// What says where a control is, or which one has focus, stands out from the paper around it (WCAG 1.4.11).
describe("edges and the focus ring", () => {
	reads("input", ["card", "background"], 3);
	reads("border-strong", ["card", "background"], 3);
	reads("ring", ["card", "background", "surface-2", "surface-3", "link-soft"], 3);
});

// A hovered or highlighted item's surface shows on the muted surfaces too, not only on the card.
describe("the hover surface", () => {
	it("is surface-3, a step under surface-2", () => {
		expect(block(":root")).toMatch(/--accent:\s*var\(--surface-3\);/);
		expect(block(".dark")).not.toMatch(/--accent:/);
	});
});

// A link in a sentence is told from the words around it by more than its color (WCAG 1.4.1); one standing on its own
// (navigation, a row's title, a button) keeps the bare look.
describe("links in running text", () => {
	it("are underlined in paragraphs, callouts and prose blocks, but not in rows laid out as flex or grid", () => {
		const rule =
			/:where\(p:not\(\.flex, \.inline-flex, \.grid\),[^{]*\.prose\) a:not\(\[data-slot\]\) \{([^}]*)\}/.exec(css);
		expect(rule?.[1]).toMatch(/text-decoration-line: underline;/);
	});
});

// Eight sizes, far enough apart to tell: 11 for counts only, 12 the smallest for words (Overpass's x-height is small),
// then 13, 14, 15, 17, 20 and 26. The roles are names for them.
describe("the type scale", () => {
	const sizes = [...css.matchAll(/--text-([a-z-]+):\s*([\d.]+)px;/g)].map(
		([, name, px]) => [name!, Number(px)] as const,
	);

	it("has eight whole-pixel steps", () => {
		expect(sizes.length).toBeGreaterThan(8);
		expect([...new Set(sizes.map(([, px]) => px))].sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 15, 17, 20, 26]);
	});

	it("keeps 11px to the counts", () => {
		expect(sizes.filter(([, px]) => px < 12).map(([name]) => name)).toEqual(["micro"]);
	});
});
