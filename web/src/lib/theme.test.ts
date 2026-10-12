import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
