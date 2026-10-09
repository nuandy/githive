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
