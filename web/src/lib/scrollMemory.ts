// Where each history entry was scrolled to. Each entry the dashboard shows gets a key in its history state; as the
// window scrolls, the entry shown keeps its position. Back and Forward go back to where an entry was; a new place
// starts at the top; a new tab of the same place stays where it is.

/** The name the entry's key goes by in history.state. */
export const ENTRY_KEY = "githiveEntry";

/** An entry's key, from its history state. */
export function entryKeyOf(state: unknown): string | undefined {
	if (!state || typeof state !== "object") return undefined;
	const key = (state as Record<string, unknown>)[ENTRY_KEY];
	return typeof key === "string" ? key : undefined;
}

/** A history state with the entry's key in it, and whatever else it held. */
export function withEntryKey(state: unknown, key: string): Record<string, unknown> {
	const kept = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
	return { ...kept, [ENTRY_KEY]: key };
}

let made = 0;
const newKey = () => `${Date.now().toString(36)}-${++made}`;

export interface Arrival {
	/** The entry's key; `fresh` when it had none and is to keep this one. */
	key: string;
	fresh: boolean;
	/** Where to scroll: back to a position, to the top of a new place, or nowhere. */
	scroll: number | "top" | null;
}

export class ScrollMemory {
	private positions = new Map<string, number>();
	private held = false;
	current: string;

	constructor(current?: string, private makeKey: () => string = newKey) {
		this.current = current ?? makeKey();
	}

	/** The window scrolled to `y`, on the entry shown, unless a restore holds it. */
	scrolled(y: number) {
		if (!this.held) this.positions.set(this.current, y);
	}

	/** While a restore waits for the page to fill in, the clamped scrolls on the way aren't where the reader was. */
	hold() {
		this.held = true;
	}

	release() {
		this.held = false;
	}

	position(key: string): number | undefined {
		return this.positions.get(key);
	}

	/**
	 * Moved to a history entry: one with a key of its own (Back, Forward), or a new one. A known entry goes back to
	 * where it was; anything else starts at the top if it's a new place, and stays where it is if not.
	 */
	arrive(key: string | undefined, newPlace: boolean): Arrival {
		this.held = false;
		const fresh = key === undefined;
		this.current = key ?? this.makeKey();
		const saved = fresh ? undefined : this.positions.get(this.current);
		return { key: this.current, fresh, scroll: saved ?? (newPlace ? "top" : null) };
	}
}

/** Whether the page is tall enough yet to scroll down to `y`. */
export const reachable = (y: number, page: { scrollHeight: number; innerHeight: number }) =>
	y <= 0 || page.scrollHeight - page.innerHeight >= y;
