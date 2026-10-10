// RPC results from Durable Objects and bindings may hold stubs, and the runtime warns about each one left to
// the garbage collector. GitHive only reads data back, so it disposes each result as soon as it arrives.

const DISPOSE = (Symbol as unknown as { dispose?: symbol }).dispose;

/** The result of an RPC `call`, disposed once it arrives. */
export async function rpc<T>(call: PromiseLike<T>): Promise<T> {
	const value = await call;
	if (!DISPOSE || value === null || typeof value !== "object") return value;
	const dispose = (value as Record<symbol, unknown>)[DISPOSE];
	if (typeof dispose === "function") dispose.call(value);
	return value;
}

/**
 * Whether an RPC failed only because its Durable Object or container was briefly unavailable: a reset after a
 * code update, a dropped container connection, or Cloudflare's "internal error; reference = ...". The runtime
 * marks such errors retryable unless the object is overloaded.
 */
export function briefOutage(err: unknown) {
	const flags = err as { retryable?: boolean; overloaded?: boolean } | null;
	if (flags?.overloaded) return false;
	if (flags?.retryable) return true;
	return /Durable Object reset|temporarily unavailable|internal error; reference =/i.test(String(err));
}

/** How long to wait before trying an RPC again after a brief outage. */
export const OUTAGE_RETRY_MS = 2_000;

/** Like rpc, but tries once more after a short wait if the call failed for a brief outage. */
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
