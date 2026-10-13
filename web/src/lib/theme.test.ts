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

// Text on a solid status fill (Merge, a solid badge, the inbox count) takes that fill's -foreground, which must read
// on it in each scheme. A scheme that doesn't set a value inherits :root's.
describe("text on a solid status color", () => {
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

	for (const scheme of [":root", ".dark"])
		for (const tone of ["good", "bad", "warn", "needs"])
			it(`reads at 4.5:1 or more: ${tone}, ${scheme}`, () => {
				const fill = value(scheme, tone);
				const text = value(scheme, `${tone}-foreground`);
				expect(fill).toBeDefined();
				expect(text, `--${tone}-foreground`).toBeDefined();
				expect(contrast(fill!, text!)).toBeGreaterThanOrEqual(4.5);
			});
});
