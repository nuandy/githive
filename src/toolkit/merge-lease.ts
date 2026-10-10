import type { Landing } from "./landing";
import type { MergeInput } from "./merge-types";

/** How long a newly taken lease lasts, until its holder's first step renews it. */
export const LEASE_MS = 3 * 60_000;
// The longest each step of landing a batch may take. The heartbeat keeps the lease only while the running step is
// within its bound, so a stuck step loses the lease soon after, and a merge that died loses it within LEASE_TTL_MS.
export const STEP_MS = {
	// Starting the repo's Gate, then reading or landing a batch there.
	gate: 5 * 60_000,
	records: 2 * 60_000,
	// The Gate stops a check command after 10 minutes (CHECK_TIMEOUT_S in gate.ts).
	checkCommand: 10 * 60_000,
};
// How often the lease holder renews the lease, and how far ahead each renewal keeps it.
const HEARTBEAT_MS = 30_000;
export const LEASE_TTL_MS = 2 * 60_000;

// The lease while this merge holds it. The heartbeat renews it only while the running step is within its bound.
export interface Holding {
	step(ms: number): Promise<void>;
	// False once another merge may hold the lease, because a renewal was refused or came too late.
	readonly held: boolean;
}

// Starts renewing the lease `holder` was just given. `stop` ends the heartbeat; it doesn't hand the lease on.
export function holdLease(input: MergeInput, landing: Landing, holder: string): { holding: Holding; stop: () => void } {
	let held = true;
	// Until this time the lease is surely this merge's. Past it without a renewal, another merge may have taken it.
	let until = Date.now() + LEASE_MS;
	// The latest the running steps may finish. The heartbeat stops renewing after it.
	let stepUntil = Date.now() + LEASE_MS;
	const keep = async () => {
		if (!held || Date.now() >= stepUntil) return;
		const ttl = input.leaseTtlMs ?? LEASE_TTL_MS;
		const asked = Date.now();
		const renewed = await landing.renew(holder, ttl).catch(() => null);
		// A renewal may be skipped while more than half is left (see gitLanding), so count on half a ttl.
		if (renewed) until = Math.max(until, asked + ttl / 2);
		else if (renewed === false) held = false;
	};
	// The lease is kept a little ahead only while this merge is alive and its step is within bounds. A merge that dies
	// loses it within LEASE_TTL_MS, and a stuck one soon after its step's bound.
	const beat = setInterval(() => void keep(), input.heartbeatMs ?? HEARTBEAT_MS);
	const holding: Holding = {
		get held() {
			return held && Date.now() < until;
		},
		step: async (ms) => {
			stepUntil = Math.max(stepUntil, Date.now() + ms);
			await keep();
		},
	};
	return { holding, stop: () => clearInterval(beat) };
}
