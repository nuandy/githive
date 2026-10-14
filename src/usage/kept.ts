// Usage reads kept in the Worker's cache, so one read serves every reader for a while. The cache keeps keys on the
// Worker's own host, so each key is a path there that no route answers.

/** What `read` returns, kept under `path` on `origin` for `seconds`, and whether it came from the cache. */
export async function keptFor<T>(origin: string, path: string, seconds: number, read: () => Promise<T>) {
	const key = new Request(`${origin}/_kept/${path}`);
	const kept = await caches.default.match(key);
	if (kept) return { value: (await kept.json()) as T, kept: true };
	const value = await read();
	const stored = new Response(JSON.stringify(value), { headers: { "Cache-Control": `max-age=${seconds}` } });
	await caches.default.put(key, stored);
	return { value, kept: false };
}
