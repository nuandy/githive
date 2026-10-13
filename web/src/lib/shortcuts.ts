// The keyboard's shortcuts, as a key read in turn: g then i or r to go somewhere, / to find a repository, 1 to 8 for
// a repo's tabs, ? for the list, and ⌘K or Ctrl-K for the palette. Keys typed into a field are the field's, and keys
// held with a modifier the browser's, but for ⌘K.

export type Shortcut =
	| { kind: "go"; to: "inbox" | "repos" }
	| { kind: "search" }
	| { kind: "tab"; index: number }
	| { kind: "help" }
	| { kind: "palette" };

export interface KeyPress {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
	/** In a field, where keys type. */
	typing: boolean;
	/** When, in ms. */
	at: number;
}

/** How long after g the next key still finishes it. */
export const CHORD_MS = 1_500;

const GO: Record<string, "inbox" | "repos"> = { i: "inbox", r: "repos" };

/**
 * What a key press does, given when g was last pressed (`pending`, or null): a shortcut or nothing, and when g was
 * pressed now (a g waits for its next key).
 */
export function readShortcut(
	press: KeyPress,
	pending: number | null,
): { shortcut: Shortcut | null; pending: number | null } {
	const none = { shortcut: null, pending: null };
	const key = press.key;
	if ((press.metaKey || press.ctrlKey) && !press.altKey && key.toLowerCase() === "k")
		return { shortcut: { kind: "palette" }, pending: null };
	if (press.typing || press.metaKey || press.ctrlKey || press.altKey) return none;
	if (pending !== null && press.at - pending <= CHORD_MS) {
		const to = GO[key];
		return to ? { shortcut: { kind: "go", to }, pending: null } : none;
	}
	if (key === "g") return { shortcut: null, pending: press.at };
	if (key === "/") return { shortcut: { kind: "search" }, pending: null };
	if (key === "?") return { shortcut: { kind: "help" }, pending: null };
	if (/^[1-8]$/.test(key)) return { shortcut: { kind: "tab", index: Number(key) - 1 }, pending: null };
	return none;
}

// Inputs that take typing; a checkbox, a radio or a button doesn't.
const NOT_TYPED = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/** Whether keys pressed in `element` type into it. */
export function typingIn(element: { tagName: string; isContentEditable?: boolean; type?: unknown } | null): boolean {
	if (!element) return false;
	if (element.isContentEditable) return true;
	if (element.tagName === "TEXTAREA" || element.tagName === "SELECT") return true;
	if (element.tagName !== "INPUT") return false;
	return !NOT_TYPED.has(String(element.type ?? "text").toLowerCase());
}
