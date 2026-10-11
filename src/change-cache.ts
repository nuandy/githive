import { DurableObject } from "cloudflare:workers";
import { Traffic, objectLabel } from "./cache-traffic";
import type { Placed } from "./toolkit/batch-reads";

// One per repo ("changes:<repo>"): what merges keep for the batch that lands their changes, fetched while they wait
// their turn (see tree-landing.ts). Each change's pack, the objects it adds as its fork packed them, and its place
// on the branch. Packs are the biggest things GitHive keeps, so they have an object of their own. Losing any of this
// costs only speed: a landing fetches what it doesn't find.

/** How long a pack or a place is kept for its landing. */
const KEPT_MS = 2 * 60 * 60_000;
/** Where the time each was kept is stored, before its own key, so finding the old ones never reads the packs. */
const KEPT_AT = "kept-at:";
/** Storage reads and writes at most this many keys at once. */
const STORAGE_BATCH = 128;
/** One reply carries at most this much of the packs; a landing fetches the rest. */
const PACKS_PER_REPLY = 16 * 1024 * 1024;

/** A repo's ChangeCache. */
export const changeCache = (env: Env, repo: string) => env.CHANGE_CACHE.getByName(`changes:${repo}`);

export class ChangeCache extends DurableObject<Env> {
	private readonly traffic = new Traffic(() => objectLabel(this.ctx));
	private lastForgot = 0;

	/** Keeps the objects a change at `head` adds, until its batch lands. */
	async keepChangePack(head: string, pack: Uint8Array) {
		this.traffic.kept("pack", pack.length);
		await this.keepAWhile([[`pack:${head}`, pack]]);
	}

	/** The packs kept for these heads, by head, up to PACKS_PER_REPLY in all. */
	async changePacks(heads: string[]) {
		const packs = await this.keptFor<Uint8Array>("pack:", heads);
		let bytes = 0;
		const fitting: Record<string, Uint8Array> = {};
		for (const [head, pack] of Object.entries(packs)) {
			if (bytes + pack.length > PACKS_PER_REPLY) continue;
			bytes += pack.length;
			fitting[head] = pack;
		}
		this.traffic.sent("packs", bytes);
		return fitting;
	}

	/** Keeps changes' places on `branch` for gathering batches (see batch-reads.ts). */
	async keepPlacements(branch: string, placed: Placed[]) {
		await this.keepAWhile(placed.map((each) => [`placed:${branch}|${each.head.hash}`, each]));
	}

	/** The places kept for these heads on `branch`, by head. */
	async placements(branch: string, heads: string[]) {
		return this.keptFor<Placed>(`placed:${branch}|`, heads);
	}

	/** Forget everything kept, for a deleted repo. */
	async forget() {
		await this.ctx.storage.deleteAll();
	}

	private async keepAWhile(entries: [string, unknown][]) {
		await this.forgetOld();
		const at = Date.now();
		const stored = entries.flatMap(([key, value]) => [
			[key, value],
			[`${KEPT_AT}${key}`, at],
		]);
		for (let i = 0; i < stored.length; i += STORAGE_BATCH)
			await this.ctx.storage.put(Object.fromEntries(stored.slice(i, i + STORAGE_BATCH)));
	}

	private async keptFor<T>(prefix: string, heads: string[]) {
		const found: Record<string, T> = {};
		for (let i = 0; i < heads.length; i += STORAGE_BATCH) {
			const keys = heads.slice(i, i + STORAGE_BATCH).map((head) => `${prefix}${head}`);
			const kept = await this.ctx.storage.get<T>(keys);
			for (const [key, value] of kept) found[key.slice(prefix.length)] = value;
		}
		return found;
	}

	// At most once a minute: a merge keeps something every time it waits.
	private async forgetOld() {
		if (Date.now() - this.lastForgot < 60_000) return;
		this.lastForgot = Date.now();
		const times = await this.ctx.storage.list<number>({ prefix: KEPT_AT });
		const old = [...times]
			.filter(([, at]) => at < Date.now() - KEPT_MS)
			.flatMap(([key]) => [key, key.slice(KEPT_AT.length)]);
		for (let i = 0; i < old.length; i += STORAGE_BATCH) await this.ctx.storage.delete(old.slice(i, i + STORAGE_BATCH));
	}
}
