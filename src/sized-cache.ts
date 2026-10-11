// Caches kept for a Worker isolate, each within a size of its own. An isolate has 128 MB for all its requests and
// can live for hours, so a cache that only grows fails every request in it once it's full.

/** A map that keeps its most recently used entries within `most` in all, dropping the least recently used first. */
export class SizedCache<V> {
	private readonly entries = new Map<string, { value: V; size: number }>();
	private total = 0;

	/** `size` is in whatever unit the cache counts: bytes, entries, or 1 for each value. */
	constructor(
		readonly name: string,
		private readonly most: number,
		private readonly unit: "bytes" | "entries" = "entries",
	) {
		caches.add(this as SizedCache<unknown>);
	}

	get(key: string): V | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		this.entries.delete(key);
		this.entries.set(key, entry);
		return entry.value;
	}

	has(key: string) {
		return this.entries.has(key);
	}

	/** Keeps `value`, unless it's bigger than the whole cache. */
	set(key: string, value: V, size = 1) {
		this.delete(key);
		if (size > this.most) return;
		this.entries.set(key, { value, size });
		this.total += size;
		for (const [oldest, entry] of this.entries) {
			if (this.total <= this.most) break;
			this.entries.delete(oldest);
			this.total -= entry.size;
		}
	}

	delete(key: string) {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		this.total -= entry.size;
	}

	clear() {
		this.entries.clear();
		this.total = 0;
	}

	/** How full it is, for the logs. */
	describe() {
		const amount = this.unit === "bytes" ? `${(this.total / 1024 / 1024).toFixed(1)} MB` : String(this.total);
		return `${this.name} ${this.entries.size} (${amount})`;
	}
}

const caches = new Set<SizedCache<unknown>>();

/** How full each of the isolate's caches is, for a slow request's log line. */
export const describeCaches = () => [...caches].map((cache) => cache.describe()).join(", ");
