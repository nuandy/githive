// Commit ids and other names that look random but are worked out from a seed, so they never change between runs.

/** A 32-bit hash of `seed`, salted (FNV-1a, then mixed). */
export function hash32(seed: string, salt = 0): number {
	let hash = (0x811c9dc5 ^ salt) >>> 0;
	for (let index = 0; index < seed.length; index++) {
		hash ^= seed.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x85ebca6b) >>> 0;
	hash ^= hash >>> 13;
	hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
	hash ^= hash >>> 16;
	return hash >>> 0;
}

/** A 40-character commit id for `seed`. */
export function sha(seed: string): string {
	let out = "";
	for (let part = 0; part < 5; part++)
		out += hash32(seed, part * 0x9e3779b9)
			.toString(16)
			.padStart(8, "0");
	return out;
}

/** One of `items`, chosen by `seed`. */
export function pick<T>(seed: string, items: readonly T[]): T {
	return items[hash32(seed) % items.length]!;
}

/** A whole number from `min` to `max`, chosen by `seed`. */
export function between(seed: string, min: number, max: number): number {
	return min + (hash32(seed, 7) % (max - min + 1));
}
