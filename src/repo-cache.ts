import { DurableObject } from "cloudflare:workers";
import { countingRequests, describeCounts } from "./git-http";
import { makeAgentFork, makeSeed } from "./toolkit/env";
import { type Ahead, asNews, type Checking, emptyLanding, type LandingState, markChecked, type Settled, settleOutcomes, wasChecked } from "./toolkit/landing";

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
// batch being checked, the next batch read ahead, and what changes came to
// lately, for the merges waiting on a batch (see toolkit/landing.ts). A hint
// like the views: the branch and the audit are the truth, and losing it costs
// a check.
//
// Records. Each record's state by tip (a commit never changes, so it's never
// stale) and where its ref points, so a read needn't list the project repo. A
// write that lands updates the tip before it returns; a write built on a stale
// tip is refused by Git and retried.
//
// Forks. The queue that makes a project's seed forks one at a time, then
// agents' forks 16 at a time. Lost, agents make their own forks.

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
/** The most landings one reply tells an agent of: past it, the newest. */
const NEWS_MOST = 20;

/**
 * The latest commit seen on a change's branch (null: nothing pushed), and when:
 * read from its fork (when the read began), or told by a push event (the
 * event's time, and the fork it was pushed to; see push-events.ts).
 */
export interface KnownHead {
	head: string | null;
	at: number;
	fork?: string;
}

/** A push to a change's branch, from a push event: which fork took it, the head it left (null: the branch deleted), and when. */
export interface ChangePush {
	change: string;
	fork: string;
	head: string | null;
	at: number;
}

interface ForkJob {
	item: string;
	tries: number;
}

/**
 * Agents' forks the queue makes at once (seeds: one at a time), each next one
 * started as one finishes: about two per seed, each agent's from its own. Four
 * at a time, each four waiting on its slowest, made 200 agents' forks at about
 * 4 every 30 to 60 s: half an hour before the last could push.
 */
const AGENT_FORKS_AT_ONCE = 16;
/** How long one alarm keeps starting forks; those started finish, then the next alarm goes on. */
const FORK_ROUND_MS = 60_000;
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

	/**
	 * The latest commit GitHive has seen on each of these changes' branches
	 * (null: nothing pushed), and when: one key a change, read a few at a time
	 * (storage reads 128 keys at once). See openHeads in mcp.ts.
	 */
	async knownHeads(changes: string[]) {
		const known: Record<string, KnownHead> = {};
		for (let i = 0; i < changes.length; i += 128) {
			const got = await this.ctx.storage.get<KnownHead>(changes.slice(i, i + 128).map((c) => `head:${c}`));
			for (const [key, seen] of got) known[key.slice(5)] = seen;
		}
		return known;
	}

	/** Commits' files changed from their first parent, as the audit worked them out (see branch-history.ts): one key a commit. */
	async keptFiles(commits: string[]) {
		const kept: Record<string, string[]> = {};
		for (let i = 0; i < commits.length; i += 128) {
			const got = await this.ctx.storage.get<string[]>(commits.slice(i, i + 128).map((c) => `files:${c}`));
			for (const [key, files] of got) kept[key.slice(6)] = files;
		}
		return kept;
	}

	async keepFiles(files: Record<string, string[]>) {
		const entries = Object.entries(files).map(([commit, paths]) => [`files:${commit}`, paths] as const);
		for (let i = 0; i < entries.length; i += 128) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
	}

	/**
	 * Note the latest commits read on changes' branches (null: nothing pushed),
	 * as of when the reads began: a push event newer than that is kept, since
	 * the read may have missed its push.
	 */
	async noteHeads(seen: Record<string, string | null>, readAt = Date.now()) {
		await this.keepNewest(Object.entries(seen).map(([change, head]) => [change, { head, at: readAt }]));
	}

	/** Note pushes to changes' branches, from push events: each kept unless what's kept is newer (events come late, twice, or out of order). */
	async notePushes(pushes: ChangePush[]) {
		await this.keepNewest(pushes.map(({ change, ...known }) => [change, known]));
	}

	private async keepNewest(heads: [string, KnownHead][]) {
		// The newest of each change's here, then against what's kept: storage reads and writes 128 keys at a time.
		const newest = new Map<string, KnownHead>();
		for (const [change, known] of heads) if ((newest.get(change)?.at ?? -Infinity) <= known.at) newest.set(change, known);
		const entries = [...newest];
		for (let i = 0; i < entries.length; i += 128) {
			const slice = entries.slice(i, i + 128);
			const kept = await this.ctx.storage.get<KnownHead>(slice.map(([change]) => `head:${change}`));
			const put = slice.filter(([change, known]) => (kept.get(`head:${change}`)?.at ?? -Infinity) <= known.at).map(([change, known]) => [`head:${change}`, known] as const);
			if (put.length) await this.ctx.storage.put(Object.fromEntries(put));
		}
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
	 * jobs), then agents' AGENT_FORKS_AT_ONCE at a time, from the seeds. It only
	 * paces fork creation: an agent that needs its fork sooner makes it itself,
	 * and waits for one the queue is making.
	 */
	async queueForks(repo: string, items: string[]) {
		await this.inQueueTurn(async () => {
			const queue = (await this.ctx.storage.get<ForkJob[]>("forks:queue")) ?? [];
			const ready = new Set(((await this.ctx.storage.get<number[]>("forks:seeds")) ?? []).map((k) => `seed:${k}`));
			const fresh = items.filter((item) => !ready.has(item) && !queue.some((job) => job.item === item));
			if (!fresh.length) return;
			await this.ctx.storage.put("forks:queue", [...queue, ...fresh.map((item) => ({ item, tries: 0 }))]);
			await this.ctx.storage.put("forks:repo", repo);
			if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 100);
		});
	}

	/** The fork queue's changes, one at a time: forks finish side by side, and agents queue theirs meanwhile. */
	private queueTurn: Promise<unknown> = Promise.resolve();
	private inQueueTurn<T>(change: () => Promise<T>): Promise<T> {
		const run = this.queueTurn.then(change);
		this.queueTurn = run.catch(() => undefined);
		return run;
	}

	/** The seeds made so far, by number. */
	async readySeeds() {
		return (await this.ctx.storage.get<number[]>("forks:seeds")) ?? [];
	}

	/** How far the forks queue has got: seeds ready, and seeds and agents' forks still to make (for the landing view, and a test waiting on them). */
	async forkQueue() {
		const [queue, seeds] = await Promise.all([this.ctx.storage.get<ForkJob[]>("forks:queue"), this.readySeeds()]);
		const queued = queue ?? [];
		const seedsQueued = queued.filter((job) => job.item.startsWith("seed:")).length;
		return { seedsReady: seeds.length, seedsQueued, agentsQueued: queued.length - seedsQueued };
	}

	async alarm() {
		// What a round of forks asks of Artifacts and Git, logged after it: "fork queue for <repo> artifacts 40: fork 8 (...), get 24 (...)".
		const counting = countingRequests(() => this.makeForks());
		try {
			await counting.done;
		} finally {
			const repo = await this.ctx.storage.get<string>("forks:repo");
			const counts = describeCounts(repo ?? "", counting.requests, counting.artifacts);
			if (counts) console.log(`fork queue for ${repo} ${counts}`);
		}
	}

	/** A round of the forks queue: its seeds one at a time, or agents' forks side by side (see alarm). */
	private async makeForks() {
		const repo = await this.ctx.storage.get<string>("forks:repo");
		const queue = (await this.ctx.storage.get<ForkJob[]>("forks:queue")) ?? [];
		if (!repo || !queue.length) return;
		// Seeds first, one an alarm; then agents' forks, side by side, until the queue is empty or the round is up.
		const seeding = queue.some((job) => job.item.startsWith("seed:"));
		const until = Date.now() + FORK_ROUND_MS;
		const making = new Set<string>();
		const next = () =>
			this.inQueueTurn(async () => {
				const now = (await this.ctx.storage.get<ForkJob[]>("forks:queue")) ?? [];
				// Seeds queued while agents' forks are made (by an agent that found none ready) wait for the next alarm.
				const job = now.find((j) => !making.has(j.item) && j.item.startsWith("seed:") === seeding);
				if (job) making.add(job.item);
				return job;
			});
		const worker = async () => {
			for (let job = await next(); job; job = seeding || Date.now() > until ? undefined : await next()) {
				const made = await (job.item.startsWith("seed:") ? makeSeed(this.env, repo, Number(job.item.slice(5))) : makeAgentFork(this.env, repo, job.item.slice(6))).then(
					() => null,
					(err: unknown) => err,
				);
				await this.inQueueTurn(async () => {
					const now = (await this.ctx.storage.get<ForkJob[]>("forks:queue")) ?? [];
					const rest = now.filter((j) => j.item !== job!.item);
					if (made === null && job!.item.startsWith("seed:")) {
						const ready = (await this.ctx.storage.get<number[]>("forks:seeds")) ?? [];
						await this.ctx.storage.put("forks:seeds", [...new Set([...ready, Number(job!.item.slice(5))])].sort((a, b) => a - b));
					}
					if (made !== null && job!.tries + 1 < FORK_TRIES) rest.push({ ...job!, tries: job!.tries + 1 });
					else if (made !== null) console.error(`fork queue for ${repo} gave up on ${job!.item}: ${String(made).slice(0, 200)}`);
					await this.ctx.storage.put("forks:queue", rest);
				});
				making.delete(job.item);
			}
		};
		await Promise.all(Array.from({ length: seeding ? 1 : AGENT_FORKS_AT_ONCE }, worker));
		if (((await this.ctx.storage.get<ForkJob[]>("forks:queue")) ?? []).length) await this.ctx.storage.setAlarm(Date.now() + 1_000);
	}

	/**
	 * The lease's holder handed it on (the lease itself is a record in Git: see
	 * toolkit/landing-lease.ts): what it showed as checking isn't any more.
	 */
	async dropLanding(branch: string, _holder: string) {
		await this.keepLanding(branch, { ...(await this.landing(branch)), checking: null });
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

	/**
	 * What landed on `branch` since `agent` was last told, others' changes
	 * only, newest last (at most NEWS_MOST); and from now on, nothing before
	 * this. An agent's first call tells it nothing old: news starts there.
	 */
	async landingNews(branch: string, agent: string) {
		const { recent } = await this.landing(branch);
		const key = `news:${branch}:${agent}`;
		const told = await this.ctx.storage.get<string>(key);
		const latest = recent.at(-1)?.at;
		if (latest && latest !== told) await this.ctx.storage.put(key, latest);
		if (!told) return [];
		return asNews(recent.filter((s) => s.at > told && s.agent !== agent)).slice(-NEWS_MOST);
	}

	/** Whether these changes, merged onto `base` in this order, passed the checks into `branch` already (see LandingState.passed). */
	async landingPassed(branch: string, base: string, heads: string[]) {
		return wasChecked(await this.landing(branch), base, heads);
	}

	async landingChecked(branch: string, base: string, heads: string[]) {
		await this.keepLanding(branch, markChecked(await this.landing(branch), base, heads));
	}

	/** The next batch into `branch`, read ahead (see Ahead in toolkit/landing.ts). */
	async landingKeepAhead(branch: string, ahead: Ahead) {
		await this.keepLanding(branch, { ...(await this.landing(branch)), ahead });
	}

	async landingAhead(branch: string) {
		return (await this.landing(branch)).ahead ?? null;
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
		// The heads last seen on changes' branches (see knownHeads): a repo made again under the name reuses change names.
		const heads = await this.ctx.storage.list({ prefix: "head:" });
		// And the files commits changed, as the audit worked them out: a commit's are its own for good, but the repo's gone.
		const files = await this.ctx.storage.list({ prefix: "files:" });
		const news = await this.ctx.storage.list({ prefix: "news:" });
		const keys = [...kept.keys(), ...building.keys(), ...records.keys(), ...tips.keys(), ...forks.keys(), ...landing.keys(), ...heads.keys(), ...files.keys(), ...news.keys()];
		// Storage deletes 128 keys at a time.
		for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128));
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
