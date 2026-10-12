// A small seeded random source for the playground's simulator, so the same seed plays the same hive every time.
// Nothing in the simulator may use Math.random or the wall clock; everything random comes from here.

/** mulberry32: a tiny, fast generator with a 32-bit state, good enough for a simulation. */
export function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export class Rand {
	private readonly next: () => number;

	constructor(seed: number) {
		this.next = mulberry32(seed);
	}

	/** A whole number from `low` to `high`, both included. */
	int(low: number, high: number) {
		return low + Math.floor(this.next() * (high - low + 1));
	}

	/** A duration in milliseconds between `low` and `high`. */
	between(low: number, high: number) {
		return Math.round(low + this.next() * (high - low));
	}

	chance(p: number) {
		return this.next() < p;
	}

	pick<T>(list: readonly T[]): T {
		const item = list[Math.floor(this.next() * list.length)];
		if (item === undefined) throw new Error("picked from an empty list");
		return item;
	}

	/** A commit id: 40 hex digits. */
	sha() {
		let hex = "";
		for (let i = 0; i < 5; i++)
			hex += Math.floor(this.next() * 4294967296)
				.toString(16)
				.padStart(8, "0");
		return hex;
	}

	/** A few hex digits, like the suffix GitHive puts on a hosted builder's change id. */
	hex(digits: number) {
		return this.sha().slice(0, digits);
	}
}

/** A small, stable hash of a name, the one GitHive uses to spread agents over equally good choices (toolkit/work.ts). */
export function spread(name: string, count: number) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193);
	return (hash >>> 0) % count;
}
