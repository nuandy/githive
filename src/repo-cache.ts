import { DurableObject } from "cloudflare:workers";
import { makeAgentFork, makeSeed } from "./toolkit/env";
import { type Checking, dropLease, emptyLanding, type LandingState, markChecked, renewLease, type Settled, settleOutcomes, takeTurn, wasChecked } from "./toolkit/landing";

// One per repo ("repo:<repo>"): what GitHive keeps of the repo between calls,
// all of it a copy or a hint. Git stays the truth, and throwing any of it away
// costs only speed: nothing here decides what lands.
//
// Live updates. Pages hold a WebSocket open; the toolkit pings the feed after
// each write, and every page refreshes at once instead of waiting
// for its next poll. Sockets hibernate between pings, so an idle feed costs
// nothing. A ping carries no data, only that something changed: pages read
// the state through the usual routes, with the reader's own access.
//
// Ready-made views. Reading a repo from Git takes many round
// trips (its snapshot ~9 s, its audit ~20 s), so the last of each view is kept
// here, with the count of writes it was built after. A write makes it stale;
// a stale view is still served at once while a fresh one is built in the
// background (one at a time), and pages are told when it's ready. Views also
// age out, for what reaches Git without a ping. Git stays the truth: a view
// is only a copy of what was read from it.
//
// Landing. Each branch's lease (which merge is landing a batch into it), the
// batch being checked, and what changes came to lately, for the merges
// waiting on a batch (see toolkit/landing.ts). A hint like the views: the
// branch and the audit are the truth, and losing it costs a check.
//
// Records. Each record's state by tip (a commit never changes, so it's never
// stale) and where its ref points, so a read needn't list the project repo. A
// write that lands updates the tip before it returns; a write built on a stale
// tip is refused by Git and retried.
//
// Forks. The queue that makes a project's seed forks one at a time, then
// agents' forks a few at a time. Lost, agents make their own forks.

interface View {
	/** The view as JSON, as served. */
	json: string;
	/** The count of writes when it was built. */
	writes: number;
	at: number;
}

/** How long a build may run before another caller may start one. */
const BUILD_LEASE_MS = 2 * 60_000;


/** A record's tip as kept: where its ref points (null: nowhere) and when that was known, its generation, and when a listing began. */
interface KeptTip {
	tip?: string | null;
	at?: number;
	gen: number;
	listing?: number;
}

/** How long one caller's listing of a ref stands before another is sent. */
const TIP_LISTING_MS = 3_000;

/** A fork the queue is to make, and how often it has tried. */
interface ForkJob {
	item: string;
	tries: number;
}

/** Agents' forks the queue makes at once (seeds: one at a time). */
const AGENT_FORKS_AT_ONCE = 4;
/** Tries per fork before the queue gives up on it (an agent's own credentials still make it). */
const FORK_TRIES = 3;

export class RepoCache extends DurableObject<Env> {
	async fetch(request: Request) {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Tell every page watching that something changed; a write (the default) also makes the views stale. */
	async ping(kind: string, write = true) {
		if (write) await this.ctx.storage.put("writes", (await this.writes()) + 1);
		this.broadcast(kind);
	}

	/** The kept view `name`: its JSON, whether it's still fresh, whether a build is running, and the write count now. */
	async view(name: string, maxAgeMs: number) {
		const [writes, kept, building] = await Promise.all([this.writes(), this.ctx.storage.get<View>(`view:${name}`), this.ctx.storage.get<number>(`building:${name}`)]);
		return {
			json: kept?.json,
			fresh: !!kept && kept.writes === writes && Date.now() - kept.at < maxAgeMs,
			building: !!building && Date.now() - building < BUILD_LEASE_MS,
			writes,
		};
	}

	/** Take the build of `name`, unless another is running: true if this caller should build it. */
	async startBuild(name: string) {
		const building = await this.ctx.storage.get<number>(`building:${name}`);
		if (building && Date.now() - building < BUILD_LEASE_MS) return false;
		await this.ctx.storage.put(`building:${name}`, Date.now());
		return true;
	}

	/** Keep a built view (built after `writes` writes) and tell pages it's ready. */
	async keep(name: string, json: string, writes: number) {
		await this.ctx.storage.put<View>(`view:${name}`, { json, writes, at: Date.now() });
		await this.ctx.storage.delete(`building:${name}`);
		this.broadcast(`view:${name}`);
	}

	/** A build that failed: let the next caller try. */
	async buildFailed(name: string) {
		await this.ctx.storage.delete(`building:${name}`);
	}

	/** A record's state at `tip`, if a reader kept it (see record-log.ts StateCache). */
	async recordAt(ref: string, tip: string) {
		const kept = await this.ctx.storage.get<{ tip: string; json: string }>(`record:${ref}`);
		return kept?.tip === tip ? kept.json : undefined;
	}

	/** Keep a record's state at `tip`, its latest: a newer tip replaces it. */
	async keepRecord(ref: string, tip: string, json: string) {
		if (json.length > 1_000_000) return;
		await this.ctx.storage.put(`record:${ref}`, { tip, json });
	}

	/**
	 * Where a record's ref points, as kept (see TipCache in record-log.ts),
	 * with its state when kept for that tip, and the generation a listing is
	 * kept under. One caller at a time is sent to list the ref: when nothing
	 * is kept (the others are told to wait for it), or when what's kept is
	 * older than `maxAgeMs` (the others take it meanwhile: a write would have
	 * moved it, so it only ages in case one couldn't).
	 */
	async tipOf(ref: string, stateKey: string, maxAgeMs: number): Promise<{ tip?: string | null; json?: string; gen: number; wait?: boolean }> {
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
		const state = kept.tip ? await this.ctx.storage.get<{ tip: string; json: string }>(`record:${stateKey}`) : undefined;
		return { tip: kept.tip, gen: kept.gen, ...(state?.tip === kept.tip ? { json: state.json } : {}) };
	}

	/** Keep a listing of a record's ref, unless it moved since the listing began (its generation is past `gen`). */
	async keepTip(ref: string, tip: string | null, gen: number) {
		const kept = await this.ctx.storage.get<KeptTip>(`tip:${ref}`);
		if ((kept?.gen ?? 0) === gen) await this.ctx.storage.put(`tip:${ref}`, { tip, at: Date.now(), gen });
	}

	/**
	 * A write moved a record's ref from `parent` to `tip`. Kept as the tip if
	 * the kept one is its parent; otherwise writes are arriving out of order
	 * (or one was lost), and the tip is forgotten until it's listed again.
	 * Either way a listing under way is dropped.
	 */
	async landedTip(ref: string, parent: string | null, tip: string) {
		const kept = (await this.ctx.storage.get<KeptTip>(`tip:${ref}`)) ?? { gen: 0 };
		const gen = kept.gen + 1;
		await this.ctx.storage.put(`tip:${ref}`, kept.tip === parent ? { tip, at: Date.now(), gen } : { gen });
	}

	/** A write built on `parent` found the ref had moved on: if that's the tip kept, it's out of date. */
	async staleTip(ref: string, parent: string | null) {
		const kept = await this.ctx.storage.get<KeptTip>(`tip:${ref}`);
		if (kept && kept.tip === parent) await this.ctx.storage.put(`tip:${ref}`, { gen: kept.gen + 1 });
	}

	/**
	 * Forks to make for this repo in the background: its seeds ("seed:<k>")
	 * and agents' own ("agent:<name>"), queued once each. Its alarm makes them,
	 * seeds one at a time (a burst of forks from one repo stalls Artifacts' fork
	 * jobs), then agents' a few at a time. It only paces fork creation: an
	 * agent that needs its fork sooner makes it itself, and waits for one the
	 * queue is making.
	 */
	async queueForks(repo: string, items: string[]) {
		const queue = (await this.ctx.storage.get<ForkJob[]>("forks:queue")) ?? [];
		const ready = new Set(((await this.ctx.storage.get<number[]>("forks:seeds")) ?? []).map((k) => `seed:${k}`));
		const fresh = items.filter((item) => !ready.has(item) && !queue.some((job) => job.item === item));
		if (!fresh.length) return;
		await this.ctx.storage.put("forks:queue", [...queue, ...fresh.map((item) => ({ item, tries: 0 }))]);
		await this.ctx.storage.put("forks:repo", repo);
		if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 100);
	}

	/** The seeds made so far, by number. */
	async readySeeds() {
		return (await this.ctx.storage.get<number[]>("forks:seeds")) ?? [];
	}

	async alarm() {
		const repo = await this.ctx.storage.get<string>("forks:repo");
		const queue = (await this.ctx.storage.get<ForkJob[]>("forks:queue")) ?? [];
		if (!repo || !queue.length) return;
		const seeds = queue.filter((job) => job.item.startsWith("seed:"));
		const batch = seeds.length ? seeds.slice(0, 1) : queue.slice(0, AGENT_FORKS_AT_ONCE);
		const outcomes = await Promise.allSettled(
			batch.map((job) => (job.item.startsWith("seed:") ? makeSeed(this.env, repo, Number(job.item.slice(5))) : makeAgentFork(this.env, repo, job.item.slice(6)))),
		);
		const ready = (await this.ctx.storage.get<number[]>("forks:seeds")) ?? [];
		const retry: ForkJob[] = [];
		batch.forEach((job, i) => {
			if (outcomes[i].status === "fulfilled") {
				if (job.item.startsWith("seed:")) ready.push(Number(job.item.slice(5)));
			} else if (job.tries + 1 < FORK_TRIES) retry.push({ ...job, tries: job.tries + 1 });
			else console.error(`fork queue for ${repo} gave up on ${job.item}: ${String((outcomes[i] as PromiseRejectedResult).reason).slice(0, 200)}`);
		});
		// Read again: callers may have queued more meanwhile.
		const now = (await this.ctx.storage.get<ForkJob[]>("forks:queue")) ?? [];
		const rest = [...now.filter((job) => !batch.some((b) => b.item === job.item)), ...retry];
		await this.ctx.storage.put("forks:seeds", [...new Set(ready)].sort((a, b) => a - b));
		await this.ctx.storage.put("forks:queue", rest);
		if (rest.length) await this.ctx.storage.setAlarm(Date.now() + 1_000);
	}

	/** What `change` at `head` came to in `branch`, or whether `holder` holds its lease now (see Landing.turn). */
	async landingTurn(branch: string, holder: string, change: string, head: string, since: number, ttlMs: number) {
		const taken = takeTurn(await this.landing(branch), holder, change, head, since, ttlMs);
		if ("lease" in taken.turn && taken.turn.lease) await this.keepLanding(branch, taken.state);
		return taken.turn;
	}

	async renewLanding(branch: string, holder: string, ttlMs: number) {
		const renewed = renewLease(await this.landing(branch), holder, ttlMs);
		if (renewed.held) await this.keepLanding(branch, renewed.state);
		return renewed.held;
	}

	async dropLanding(branch: string, holder: string) {
		await this.keepLanding(branch, dropLease(await this.landing(branch), holder));
		this.broadcast("landing");
	}

	async landingChecking(branch: string, batch: Checking | null) {
		await this.keepLanding(branch, { ...(await this.landing(branch)), checking: batch });
		this.broadcast("landing");
	}

	async landingSettled(branch: string, outcomes: Settled[]) {
		if (!outcomes.length) return;
		await this.keepLanding(branch, settleOutcomes(await this.landing(branch), outcomes));
		this.broadcast("landing");
	}

	/** What's being checked into `branch` now, and what changes came to lately. */
	async landingView(branch: string) {
		const { checking, recent } = await this.landing(branch);
		return { checking, recent };
	}

	/** Whether these changes, merged onto `base` in this order, passed the checks into `branch` already (see LandingState.passed). */
	async landingPassed(branch: string, base: string, heads: string[]) {
		return wasChecked(await this.landing(branch), base, heads);
	}

	async landingChecked(branch: string, base: string, heads: string[]) {
		await this.keepLanding(branch, markChecked(await this.landing(branch), base, heads));
	}

	private async landing(branch: string) {
		return (await this.ctx.storage.get<LandingState>(`landing:${branch}`)) ?? emptyLanding();
	}

	private async keepLanding(branch: string, state: LandingState) {
		await this.ctx.storage.put(`landing:${branch}`, state);
	}

	/** Forget the kept views: the repo was deleted. */
	async clearViews() {
		const kept = await this.ctx.storage.list({ prefix: "view:" });
		const building = await this.ctx.storage.list({ prefix: "building:" });
		const records = await this.ctx.storage.list({ prefix: "record:" });
		const tips = await this.ctx.storage.list({ prefix: "tip:" });
		const forks = await this.ctx.storage.list({ prefix: "forks:" });
		const landing = await this.ctx.storage.list({ prefix: "landing:" });
		await this.ctx.storage.delete([...kept.keys(), ...building.keys(), ...records.keys(), ...tips.keys(), ...forks.keys(), ...landing.keys()]);
	}

	private async writes() {
		return (await this.ctx.storage.get<number>("writes")) ?? 0;
	}

	private broadcast(kind: string) {
		const message = JSON.stringify({ kind, at: new Date().toISOString() });
		for (const socket of this.ctx.getWebSockets()) {
			try {
				socket.send(message);
			} catch {
				// A page that went away; the runtime closes it.
			}
		}
	}

	// Pages only listen; anything they send is ignored.
	async webSocketMessage() {}

	async webSocketClose(socket: WebSocket, code: number) {
		socket.close(code === 1005 ? 1000 : code, "closed");
	}
}
