import { DurableObject } from "cloudflare:workers";
import { Traffic, objectLabel } from "./cache-traffic";

// One per record log ("record:<repo>:<log>"): where the log's ref points, and its state at that tip, shared by
// every Worker instance so a read needn't list the ref or fetch the commit (see TipCache and StateCache in
// record-log.ts). Each log has its own object, so a busy repo's records don't share one object's 128 MB. Git stays
// the truth, so losing any of this costs only speed.

/** Where a record's ref points (null: nowhere). `gen` changes on every write, so a slow listing can't overwrite it. */
interface KeptTip {
	tip?: string | null;
	at?: number;
	gen: number;
	listing?: number;
}

interface KeptState {
	tip: string;
	json: string;
}

/** How long one caller's listing of a ref stands before another caller is sent. */
const TIP_LISTING_MS = 3_000;
/** A state bigger than this isn't kept: each reader then fetches it. */
const STATE_MOST = 1_000_000;
/** A log nobody has written to for this long is forgotten, so a deleted repo's logs don't stay. */
const IDLE_MS = 3 * 24 * 60 * 60_000;

export class RecordCache extends DurableObject<Env> {
	private readonly traffic = new Traffic(() => objectLabel(this.ctx));

	/** The state kept for `ref` at `tip`, if a reader kept it. */
	async recordAt(ref: string, tip: string) {
		const kept = await this.ctx.storage.get<KeptState>(`record:${ref}`);
		const json = kept?.tip === tip ? kept.json : undefined;
		this.traffic.sent("state", json?.length ?? 0);
		return json;
	}

	/** Only the latest tip's state is kept. */
	async keepRecord(ref: string, tip: string, json: string) {
		if (json.length > STATE_MOST) return;
		this.traffic.kept("state", json.length);
		await this.ctx.storage.put(`record:${ref}`, { tip, json });
		await this.stayAWhile();
	}

	/**
	 * Where a record's ref points, and its state there unless the caller already `has` that tip's state. Only one
	 * caller at a time is sent to list the ref. When nothing is kept, the others wait; when the tip is old, they use
	 * it anyway.
	 */
	async tipOf(
		ref: string,
		stateKey: string,
		maxAgeMs: number,
		has?: string,
	): Promise<{ tip?: string | null; json?: string; gen: number; wait?: boolean }> {
		const key = `tip:${ref}`;
		const kept = (await this.ctx.storage.get<KeptTip>(key)) ?? { gen: 0 };
		const now = Date.now();
		const listing = kept.listing !== undefined && now - kept.listing < TIP_LISTING_MS;
		if (kept.tip === undefined || now - (kept.at ?? 0) > maxAgeMs) {
			if (!listing) {
				await this.ctx.storage.put(key, { ...kept, listing: now });
				return { gen: kept.gen };
			}
			if (kept.tip === undefined) return { gen: kept.gen, wait: true };
		}
		if (!kept.tip || kept.tip === has) return { tip: kept.tip, gen: kept.gen };
		const state = await this.ctx.storage.get<KeptState>(`record:${stateKey}`);
		if (state?.tip !== kept.tip) return { tip: kept.tip, gen: kept.gen };
		this.traffic.sent("state", state.json.length);
		return { tip: kept.tip, gen: kept.gen, json: state.json };
	}

	/** Keep a listing of a record's ref, unless a write moved it since the listing began. */
	async keepTip(ref: string, tip: string | null, gen: number) {
		const kept = await this.ctx.storage.get<KeptTip>(`tip:${ref}`);
		if ((kept?.gen ?? 0) === gen) await this.ctx.storage.put(`tip:${ref}`, { tip, at: Date.now(), gen });
	}

	/** A write moved the ref from `parent` to `tip`. If the kept tip isn't `parent`, writes arrived out of order. */
	async landedTip(ref: string, parent: string | null, tip: string) {
		const kept = (await this.ctx.storage.get<KeptTip>(`tip:${ref}`)) ?? { gen: 0 };
		const gen = kept.gen + 1;
		await this.ctx.storage.put(`tip:${ref}`, kept.tip === parent ? { tip, at: Date.now(), gen } : { gen });
		await this.stayAWhile();
	}

	/** A write built on `parent` found the ref had moved, so a kept `parent` tip is out of date. */
	async staleTip(ref: string, parent: string | null) {
		const kept = await this.ctx.storage.get<KeptTip>(`tip:${ref}`);
		if (kept && kept.tip === parent) await this.ctx.storage.put(`tip:${ref}`, { gen: kept.gen + 1 });
	}

	/** Forget everything kept, for a deleted repo. */
	async forget() {
		await this.ctx.storage.deleteAll();
	}

	async alarm() {
		await this.forget();
	}

	private async stayAWhile() {
		await this.ctx.storage.setAlarm(Date.now() + IDLE_MS);
	}
}
