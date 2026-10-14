import { describe, expect, it } from "vitest";
import { type KeyPress, keysTaken, readShortcut, typingIn } from "./shortcuts";

// The keyboard's shortcuts: g i, g r, /, 1 to 8, ?, and ⌘K or Ctrl-K; none while typing or with a modifier.

const press = (key: string, more: Partial<KeyPress> = {}): KeyPress => ({
	key,
	metaKey: false,
	ctrlKey: false,
	altKey: false,
	typing: false,
	at: 1_000,
	...more,
});

describe("the keyboard's shortcuts", () => {
	it("goes to the Inbox with g then i, and to Repositories with g then r", () => {
		const g = readShortcut(press("g"), null);
		expect(g).toEqual({ shortcut: null, pending: 1_000 });
		expect(readShortcut(press("i", { at: 1_400 }), g.pending)).toEqual({
			shortcut: { kind: "go", to: "inbox" },
			pending: null,
		});
		expect(readShortcut(press("r", { at: 1_400 }), g.pending).shortcut).toEqual({ kind: "go", to: "repos" });
		// Too long after the g, or another key, and it's forgotten.
		expect(readShortcut(press("i", { at: 3_000 }), g.pending)).toEqual({ shortcut: null, pending: null });
		expect(readShortcut(press("x", { at: 1_200 }), g.pending)).toEqual({ shortcut: null, pending: null });
		// i alone does nothing.
		expect(readShortcut(press("i"), null).shortcut).toBeNull();
	});

	it("finds a repository with /, switches tabs with 1 to 8, and shows itself with ?", () => {
		expect(readShortcut(press("/"), null).shortcut).toEqual({ kind: "search" });
		expect(readShortcut(press("1"), null).shortcut).toEqual({ kind: "tab", index: 0 });
		expect(readShortcut(press("8"), null).shortcut).toEqual({ kind: "tab", index: 7 });
		expect(readShortcut(press("9"), null).shortcut).toBeNull();
		expect(readShortcut(press("0"), null).shortcut).toBeNull();
		expect(readShortcut(press("?"), null).shortcut).toEqual({ kind: "help" });
	});

	it("opens the palette with ⌘K or Ctrl-K, even while typing", () => {
		expect(readShortcut(press("k", { metaKey: true }), null).shortcut).toEqual({ kind: "palette" });
		expect(readShortcut(press("K", { ctrlKey: true, typing: true }), null).shortcut).toEqual({ kind: "palette" });
		expect(readShortcut(press("k", { ctrlKey: true, altKey: true }), null).shortcut).toBeNull();
		expect(readShortcut(press("k"), null).shortcut).toBeNull();
	});

	it("opens no palette over another dialog", () => {
		expect(readShortcut(press("k", { metaKey: true, dialog: true }), null).shortcut).toBeNull();
		expect(readShortcut(press("k", { ctrlKey: true, typing: true, dialog: true }), null).shortcut).toBeNull();
		expect(readShortcut(press("k", { metaKey: true, dialog: false, typing: true }), null).shortcut).toEqual({
			kind: "palette",
		});
	});

	it("leaves keys alone while typing in a field, and with a modifier", () => {
		expect(readShortcut(press("/", { typing: true }), null).shortcut).toBeNull();
		expect(readShortcut(press("g", { typing: true }), null).pending).toBeNull();
		expect(readShortcut(press("i", { typing: true }), 900).shortcut).toBeNull();
		expect(readShortcut(press("1", { metaKey: true }), null).shortcut).toBeNull();
		expect(readShortcut(press("1", { ctrlKey: true }), null).shortcut).toBeNull();
		expect(readShortcut(press("g", { altKey: true }), null).pending).toBeNull();
	});

	it("knows typing when it sees it", () => {
		const el = (tagName: string, more: Record<string, unknown> = {}) => ({
			tagName,
			isContentEditable: false,
			...more,
		});
		expect(typingIn(el("INPUT", { type: "text" }))).toBe(true);
		expect(typingIn(el("INPUT", { type: "search" }))).toBe(true);
		expect(typingIn(el("INPUT", { type: "checkbox" }))).toBe(false);
		expect(typingIn(el("TEXTAREA"))).toBe(true);
		expect(typingIn(el("SELECT"))).toBe(true);
		expect(typingIn(el("DIV", { isContentEditable: true }))).toBe(true);
		expect(typingIn(el("A"))).toBe(false);
		expect(typingIn(null)).toBe(false);
	});

	it("leaves keys to a form's controls, an open menu or dialog, and anything editable", () => {
		// An element, and the selectors it's inside of.
		const el = (tagName: string, within: string[] = [], more: Record<string, unknown> = {}) => ({
			tagName,
			isContentEditable: false,
			closest: (selector: string) =>
				selector
					.split(",")
					.map((each) => each.trim())
					.some((each) => within.includes(each))
					? {}
					: null,
			...more,
		});
		// A verdict's radio, or the vote's submit button: a 2 typed there stays in the vote.
		expect(keysTaken(el("INPUT", ["form"], { type: "radio" }))).toBe(true);
		expect(keysTaken(el("BUTTON", ["form"]))).toBe(true);
		expect(keysTaken(el("BUTTON", ['[role="dialog"]']))).toBe(true);
		expect(keysTaken(el("BUTTON", ['[role="alertdialog"]']))).toBe(true);
		expect(keysTaken(el("DIV", ['[role="menu"]']))).toBe(true);
		expect(keysTaken(el("INPUT", [], { type: "search" }))).toBe(true);
		expect(keysTaken(el("DIV", [], { isContentEditable: true }))).toBe(true);
		// A link or a button on the page: the shortcuts are the page's.
		expect(keysTaken(el("A"))).toBe(false);
		expect(keysTaken(el("BUTTON"))).toBe(false);
		expect(keysTaken(null)).toBe(false);
	});
});
