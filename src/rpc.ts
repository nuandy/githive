// What an RPC call returns (a Durable Object's method, a binding's) may hold
// stubs, which the runtime wants disposed explicitly, not left to the garbage
// collector: it warns of each one left. GitHive only reads data back, so each
// result is disposed once it has arrived. A plain value has nothing to
// dispose, and is returned as it is.

const DISPOSE = (Symbol as unknown as { dispose?: symbol }).dispose;

/** The result of an RPC `call`, disposed once it's here. */
export async function rpc<T>(call: PromiseLike<T>): Promise<T> {
	const value = await call;
	const dispose = DISPOSE && value !== null && typeof value === "object" ? (value as Record<symbol, unknown>)[DISPOSE] : undefined;
	if (typeof dispose === "function") dispose.call(value);
	return value;
}

/**
 * Whether an RPC failed only because its Durable Object or container was
 * briefly away: reset by a runtime update ("Durable Object reset because its
 * code was updated"), or a container connection briefly unavailable. The
 * runtime marks such errors retryable, unless the object is overloaded.
 */
export function briefOutage(err: unknown) {
	const e = err as { retryable?: boolean; overloaded?: boolean } | null;
	return (!!e?.retryable && !e?.overloaded) || /Durable Object reset|temporarily unavailable/i.test(String(err));
}

/** How long to wait before trying an RPC again after a brief outage. */
export const OUTAGE_RETRY_MS = 2_000;

/** An RPC `call`'s result, disposed (see rpc), with one more try a moment later if it failed for a brief outage. */
export async function rpcRetried<T>(call: () => PromiseLike<T>, waitMs = OUTAGE_RETRY_MS): Promise<T> {
	try {
		return await rpc(call());
	} catch (err) {
		if (!briefOutage(err)) throw err;
		console.error(`an RPC failed for a brief outage, trying once more: ${String(err).slice(0, 200)}`);
		await new Promise((resolve) => setTimeout(resolve, waitMs));
		return rpc(call());
	}
}
