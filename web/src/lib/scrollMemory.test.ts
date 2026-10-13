import { describe, expect, it } from "vitest";
import { ScrollMemory, firstTimeIn, reachable, withEntryKey } from "./scrollMemory";

// Where each history entry was scrolled to, so Back and Forward go back to it, and a new place starts at the top.

describe("the scroll memory", () => {
	const keys = () => {
		let n = 0;
		return () => `k${++n}`;
	};

	it("starts a new place at the top, and keeps a tab of the same place where it is", () => {
		const memory = new ScrollMemory("k0", keys());
		memory.scrolled(800);
		expect(memory.arrive(undefined, true)).toEqual({ key: "k1", scroll: "top", fresh: true });
		memory.scrolled(300);
		expect(memory.arrive(undefined, false)).toEqual({ key: "k2", scroll: null, fresh: true });
	});

	it("takes Back and Forward to where each entry was", () => {
		const memory = new ScrollMemory("k0", keys());
		memory.scrolled(1200);
		const inbox = memory.arrive(undefined, true);
		memory.scrolled(40);
		// Back to the list, scrolled down: there again.
		expect(memory.arrive("k0", true)).toEqual({ key: "k0", scroll: 1200, fresh: false });
		memory.scrolled(1250);
		// Forward to the inbox.
		expect(memory.arrive(inbox.key, true)).toEqual({ key: inbox.key, scroll: 40, fresh: false });
		// And back again: where it was left, not where it was first.
		expect(memory.arrive("k0", true)).toMatchObject({ scroll: 1250 });
	});

	it("starts at the top of an entry it never saw scroll, if it's a new place", () => {
		const memory = new ScrollMemory("k0", keys());
		expect(memory.arrive("from-before-a-reload", true)).toEqual({
			key: "from-before-a-reload",
			scroll: "top",
			fresh: false,
		});
		expect(memory.arrive("another", false)).toEqual({ key: "another", scroll: null, fresh: false });
	});

	it("keeps what it's going back to while the page fills in under it", () => {
		const memory = new ScrollMemory("k0", keys());
		memory.scrolled(900);
		memory.arrive(undefined, true);
		const back = memory.arrive("k0", true);
		expect(back.scroll).toBe(900);
		// The page is short until its data is in: the window clamps, and that isn't where the reader left it.
		memory.hold();
		memory.scrolled(0);
		expect(memory.position("k0")).toBe(900);
		memory.release();
		memory.scrolled(880);
		expect(memory.position("k0")).toBe(880);
	});
});

describe("restoring a scroll", () => {
	it("waits until the page is tall enough to scroll that far", () => {
		expect(reachable(900, { scrollHeight: 1000, innerHeight: 800 })).toBe(false);
		expect(reachable(200, { scrollHeight: 1000, innerHeight: 800 })).toBe(true);
		expect(reachable(0, { scrollHeight: 100, innerHeight: 800 })).toBe(true);
	});
});

describe("a history entry's key", () => {
	it("keeps what else the entry holds", () => {
		expect(withEntryKey(null, "k1")).toEqual({ githiveEntry: "k1" });
		expect(withEntryKey({ other: 1 }, "k1")).toEqual({ other: 1, githiveEntry: "k1" });
		expect(withEntryKey("not an object", "k1")).toEqual({ githiveEntry: "k1" });
	});
});

describe("what's done once per history entry", () => {
	it("is done on an entry's first visit, not as Back or Forward return to it", () => {
		const seen = new Set<string>();
		expect(firstTimeIn(seen, "k1")).toBe(true);
		expect(firstTimeIn(seen, "k1")).toBe(false);
		expect(firstTimeIn(seen, "k2")).toBe(true);
		// An entry with no key can't be told apart: each time.
		expect(firstTimeIn(seen, undefined)).toBe(true);
		expect(firstTimeIn(seen, undefined)).toBe(true);
	});
});
