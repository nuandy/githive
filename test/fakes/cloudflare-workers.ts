// Stand-in for the Workers runtime module, so Durable Object classes can be
// constructed in Node tests with fake storage and bindings.
export class DurableObject<E = unknown> {
	constructor(
		readonly ctx: any,
		readonly env: E,
	) {}
}

/** The base of a Worker entrypoint class: the OAuth provider checks handlers against it. */
export class WorkerEntrypoint<E = unknown> {
	constructor(
		readonly ctx: any,
		readonly env: E,
	) {}
}
