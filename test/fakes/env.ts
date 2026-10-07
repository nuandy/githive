
/** In-memory Durable Object storage; values are copied in and out, like the real thing. */
export class FakeStorage {
	readonly data = new Map<string, unknown>();
	alarm: number | null = null;
	async get<T>(key: string): Promise<T | undefined> {
		return structuredClone(this.data.get(key)) as T | undefined;
	}
	async put(key: string | Record<string, unknown>, value?: unknown) {
		if (typeof key === "string") this.data.set(key, structuredClone(value));
		else for (const [k, v] of Object.entries(key)) this.data.set(k, structuredClone(v));
	}
	async list<T>(options: { prefix?: string; reverse?: boolean; limit?: number } = {}) {
		const keys = [...this.data.keys()].filter((k) => k.startsWith(options.prefix ?? "")).sort();
		if (options.reverse) keys.reverse();
		return new Map(keys.slice(0, options.limit ?? keys.length).map((k) => [k, structuredClone(this.data.get(k)) as T]));
	}
	async delete(key: string | string[]) {
		for (const k of Array.isArray(key) ? key : [key]) this.data.delete(k);
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
