// Light, dark, or whatever the system says: the reader's choice, kept in this browser. index.html applies it before
// the first paint (the same few lines as applyTheme); from then on this module keeps <html> in step with the choice
// and, under "system", with the system.

import { useSyncExternalStore } from "react";

export type ThemeChoice = "light" | "dark" | "system";
export type Theme = "light" | "dark";

export const THEME_KEY = "githive.theme";
export const THEME_CHOICES: ThemeChoice[] = ["light", "dark", "system"];

const DARK_QUERY = "(prefers-color-scheme: dark)";

const isChoice = (value: unknown): value is ThemeChoice => THEME_CHOICES.includes(value as ThemeChoice);

/** The stored choice; "system" when there's none, or storage can't be read. */
export function readChoice(): ThemeChoice {
	try {
		const stored = window.localStorage.getItem(THEME_KEY);
		return isChoice(stored) ? stored : "system";
	} catch {
		return "system";
	}
}

const systemTheme = (): Theme => (window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light");

/** What a choice comes to now. */
export const resolveTheme = (choice: ThemeChoice): Theme => (choice === "system" ? systemTheme() : choice);

const listeners = new Set<() => void>();
let current: { choice: ThemeChoice; theme: Theme } | null = null;

function snapshot() {
	if (!current) {
		const choice = readChoice();
		current = { choice, theme: resolveTheme(choice) };
	}
	return current;
}

function paint(theme: Theme) {
	document.documentElement.classList.toggle("dark", theme === "dark");
	// The browser's own bar in the top bar's color (index.html's theme-color, which follows the system until now).
	const bar = window.getComputedStyle?.(document.documentElement).getPropertyValue("--card").trim();
	if (bar)
		for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) meta.content = bar;
}

/** Shows `theme`, cross-fading the page unless the reader asks for less motion or the browser can't. */
function show(theme: Theme, animate: boolean) {
	if (document.documentElement.classList.contains("dark") === (theme === "dark")) return;
	const still = !animate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
	if (still || !document.startViewTransition) paint(theme);
	else document.startViewTransition(() => paint(theme));
}

function update(choice: ThemeChoice, animate: boolean) {
	const theme = resolveTheme(choice);
	current = { choice, theme };
	// An explicit choice holds native controls to it too (theme.css); under "system" the browser follows the system.
	if (choice === "system") delete document.documentElement.dataset.theme;
	else document.documentElement.dataset.theme = choice;
	show(theme, animate);
	for (const listener of listeners) listener();
}

/** Keeps the choice, and shows it. */
export function setThemeChoice(choice: ThemeChoice) {
	try {
		if (choice === "system") window.localStorage.removeItem(THEME_KEY);
		else window.localStorage.setItem(THEME_KEY, choice);
	} catch {
		// Private windows can refuse storage; the choice still holds until the page closes.
	}
	update(choice, true);
}

let watching = false;

/** Follows the system while the choice is "system", and a choice made in another tab. The entry points call it. */
export function keepThemeCurrent() {
	if (watching || typeof window === "undefined") return;
	watching = true;
	window.matchMedia?.(DARK_QUERY).addEventListener("change", () => {
		if (snapshot().choice === "system") update("system", true);
	});
	window.addEventListener("storage", (event) => {
		if (event.key === THEME_KEY || event.key === null) update(readChoice(), true);
	});
}

function subscribe(listener: () => void) {
	keepThemeCurrent();
	listeners.add(listener);
	return () => listeners.delete(listener);
}

const SERVER = { choice: "system" as ThemeChoice, theme: "light" as Theme };

/** The reader's choice and what it shows now, kept current. */
export function useTheme(): { choice: ThemeChoice; theme: Theme; setChoice: (choice: ThemeChoice) => void } {
	const { choice, theme } = useSyncExternalStore(subscribe, snapshot, () => SERVER);
	return { choice, theme, setChoice: setThemeChoice };
}
