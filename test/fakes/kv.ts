// Workers KV in memory, as much of it as the OAuth provider uses: get (text
// or JSON), put with an expiry and metadata, delete, and list by prefix.

export function fakeKV() {
	const store = new Map<string, { value: string; metadata?: unknown; expires?: number }>();
	const live = (key: string) => {
		const entry = store.get(key);
		if (entry?.expires && entry.expires <= Date.now()) {
			store.delete(key);
			return undefined;
		}
		return entry;
	};
	return {
		async get(key: string, options?: string | { type?: string }) {
			const entry = live(key);
			if (!entry) return null;
			const type = typeof options === "string" ? options : options?.type;
			return type === "json" ? JSON.parse(entry.value) : entry.value;
		},
		async getWithMetadata(key: string, options?: string | { type?: string }) {
			const entry = live(key);
			const type = typeof options === "string" ? options : options?.type;
			return {
				value: entry ? (type === "json" ? JSON.parse(entry.value) : entry.value) : null,
				metadata: entry?.metadata ?? null,
			};
		},
		async put(
			key: string,
			value: string,
			options?: { expirationTtl?: number; expiration?: number; metadata?: unknown },
		) {
			const expires = options?.expirationTtl
				? Date.now() + options.expirationTtl * 1000
				: options?.expiration
					? options.expiration * 1000
					: undefined;
			store.set(key, { value: String(value), metadata: options?.metadata, expires });
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
			const keys = [...store.keys()].filter((k) => live(k) && k.startsWith(options.prefix ?? "")).sort();
			const start = options.cursor ? Number(options.cursor) : 0;
			const limit = options.limit ?? 1000;
			const page = keys.slice(start, start + limit);
			const complete = start + limit >= keys.length;
			return {
				keys: page.map((name) => ({ name, metadata: store.get(name)?.metadata })),
				list_complete: complete,
				...(complete ? {} : { cursor: String(start + limit) }),
			};
		},
	} as unknown as KVNamespace;
}
