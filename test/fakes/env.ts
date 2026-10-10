/** The most keys a single get, put or delete takes in Durable Object storage. More than that throws. */
const KEYS_AT_ONCE = 128;
const atMost128 = (n: number) => {
	if (n > KEYS_AT_ONCE)
		throw new RangeError(`${n} keys in one call: Durable Object storage takes at most ${KEYS_AT_ONCE}`);
};

/** In-memory Durable Object storage; values are copied in and out, and calls take as many keys, like the real thing. */
export class FakeStorage {
	readonly data = new Map<string, unknown>();
	alarm: number | null = null;
	async get<T>(key: string): Promise<T | undefined>;
	async get<T>(keys: string[]): Promise<Map<string, T>>;
	async get<T>(key: string | string[]): Promise<T | undefined | Map<string, T>> {
		if (!Array.isArray(key)) return structuredClone(this.data.get(key)) as T | undefined;
		atMost128(key.length);
		return new Map(key.filter((k) => this.data.has(k)).map((k) => [k, structuredClone(this.data.get(k)) as T]));
	}
	async put(key: string | Record<string, unknown>, value?: unknown) {
		if (typeof key === "string") this.data.set(key, structuredClone(value));
		else {
			atMost128(Object.keys(key).length);
			for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
		}
	}
	async list<T>(options: { prefix?: string; reverse?: boolean; limit?: number } = {}) {
		const keys = [...this.data.keys()].filter((k) => k.startsWith(options.prefix ?? "")).sort();
		if (options.reverse) keys.reverse();
		return new Map(keys.slice(0, options.limit ?? keys.length).map((k) => [k, structuredClone(this.data.get(k)) as T]));
	}
	async delete(key: string | string[]) {
		if (Array.isArray(key)) atMost128(key.length);
		for (const k of Array.isArray(key) ? key : [key]) this.data.delete(k);
	}
	async getAlarm() {
		return this.alarm;
	}
	async setAlarm(at: number) {
		this.alarm = at;
	}
	async deleteAlarm() {
		this.alarm = null;
	}
	async deleteAll() {
		this.data.clear();
	}
}

/** A Durable Object namespace whose stubs record calls; `make` builds each stub. */
export function namespace<T>(make: (name: string) => T) {
	const stubs = new Map<string, T>();
	return {
		stubs,
		getByName(name: string) {
			if (!stubs.has(name)) stubs.set(name, make(name));
			return stubs.get(name)!;
		},
	};
}
