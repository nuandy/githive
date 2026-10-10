import { DurableObject } from "cloudflare:workers";
import { countingRequests, describeCounts } from "./git-http";
import { type HiveEvent, pushEvents, settledEvents, withEvents } from "./hive-events";
import { makeAgentFork, makeSeed } from "./toolkit/env";
import { type Stretch, extendStretch, stretchSummary } from "./toolkit/stretch";
import {
	asNews,
	type Checking,
	emptyLanding,
	type LandingState,
	type Settled,
	settleOutcomes,
} from "./toolkit/landing";

// One per repo ("repo:<repo>"). It holds copies and hints that make reads fast: live-update
// sockets for pages, prebuilt views, landing progress, record tips and the fork queue.
// Git stays the source of truth, so losing any of this costs only speed.

interface View {
	json: string;
	/** The write count when it was built; a later write makes it stale. */
	writes: number;
	at: number;
}

/** How long a build may run before another caller may start one. */
const BUILD_LEASE_MS = 2 * 60_000;

/** Where a record's ref points (null: nowhere). `gen` changes on every write, so a slow listing can't overwrite it. */
interface KeptTip {
	tip?: string | null;
	at?: number;
	gen: number;
	listing?: number;
}

/** How long one caller's listing of a ref stands before another caller is sent. */
const TIP_LISTING_MS = 3_000;

/** The most landings one reply tells an agent about; the newest are kept. */
const NEWS_MOST = 20;

/** The latest commit seen on a change's branch (null: nothing pushed), from a read or a push event. */
export interface KnownHead {
	head: string | null;
	at: number;
	fork?: string;
}

/** A push to a change's branch from a push event. A null head means the branch was deleted. */
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
 * Agents' forks made side by side; seeds are made one at a time. A new fork starts as soon as
 * one finishes, since waiting for the slowest of a group made large swarms wait too long to push.
 */
const AGENT_FORKS_AT_ONCE = 16;
/** How long one alarm keeps starting forks before the next alarm continues. */
const FORK_ROUND_MS = 60_000;
/** Tries per fork before the queue gives up; the agent can still make its own fork. */
const FORK_TRIES = 3;

/** Storage reads and writes at most this many keys at once. */
const STORAGE_BATCH = 128;

/** What clearViews forgets: everything kept for a repo. */
const KEPT_PREFIXES = [
	"view:",
	"building:",
	"record:",
	"tip:",
	"forks:",
	"landing:",
	"head:",
	"files:",
	"news:",
	"merge:",
];

/** A change's merge check as status worked it out, for the change head and branch head in `key`. */
export interface KeptMergeCheck {
	key: string;
	result: unknown;
}

export class RepoCache extends DurableObject<Env> {
	async fetch(request: Request) {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Tell watching pages that something changed, and what for the hive's feed. A write makes the views stale. */
	async ping(kind: string, write = true, events: HiveEvent[] = []) {
		if (write) await this.ctx.storage.put("writes", (await this.writes()) + 1);
		await this.keepEvents(events);
		this.broadcast(kind);
	}

	/** The hive's recent events, oldest first (see hive-events.ts). */
	async events() {
		return (await this.ctx.storage.get<HiveEvent[]>("events")) ?? [];
	}

	private async keepEvents(events: HiveEvent[]) {
		if (events.length) await this.ctx.storage.put("events", withEvents(await this.events(), events));
	}

	/** The latest commit seen on each change's branch. */
	async knownHeads(changes: string[]) {
		const known: Record<string, KnownHead> = {};
		for (let i = 0; i < changes.length; i += STORAGE_BATCH) {
			const keys = changes.slice(i, i + STORAGE_BATCH).map((change) => `head:${change}`);
			const got = await this.ctx.storage.get<KnownHead>(keys);
			for (const [key, seen] of got) known[key.slice(5)] = seen;
		}
		return known;
	}

	/** The files each commit changed from its first parent, as the audit computed them (see branch-history.ts). */
	async keptFiles(commits: string[]) {
		const kept: Record<string, string[]> = {};
		for (let i = 0; i < commits.length; i += STORAGE_BATCH) {
			const keys = commits.slice(i, i + STORAGE_BATCH).map((commit) => `files:${commit}`);
			const got = await this.ctx.storage.get<string[]>(keys);
			for (const [key, files] of got) kept[key.slice(6)] = files;
		}
		return kept;
	}

	async keepFiles(files: Record<string, string[]>) {
		const entries = Object.entries(files).map(([commit, paths]) => [`files:${commit}`, paths] as const);
		for (let i = 0; i < entries.length; i += STORAGE_BATCH)
			await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + STORAGE_BATCH)));
	}

	/**
	 * Note the heads read from changes' branches, timed from when the reads began.
	 * A newer push event wins, since the read may have missed its push.
	 */
	async noteHeads(seen: Record<string, string | null>, readAt = Date.now()) {
		await this.keepNewest(Object.entries(seen).map(([change, head]) => [change, { head, at: readAt }]));
	}

	/** A change's merge check, as status last worked it out (see KeptMergeCheck). */
	async keptMergeCheck(change: string) {
		return (await this.ctx.storage.get<KeptMergeCheck>(`merge:${change}`)) ?? null;
	}

	async keepMergeCheck(change: string, kept: KeptMergeCheck) {
		await this.ctx.storage.put(`merge:${change}`, kept);
	}

	/** Note pushes from push events. Events can arrive late, twice or out of order, so the newest wins. */
	async notePushes(pushes: ChangePush[]) {
		await this.keepNewest(pushes.map(({ change, ...known }) => [change, known]));
		const events = pushEvents(pushes);
		await this.keepEvents(events);
		if (events.length) this.broadcast("pushed");
	}

	private async keepNewest(heads: [string, KnownHead][]) {
		const newest = new Map<string, KnownHead>();
		for (const [change, known] of heads)
			if ((newest.get(change)?.at ?? -Infinity) <= known.at) newest.set(change, known);
		const entries = [...newest];
		for (let i = 0; i < entries.length; i += STORAGE_BATCH) {
			const slice = entries.slice(i, i + STORAGE_BATCH);
			const kept = await this.ctx.storage.get<KnownHead>(slice.map(([change]) => `head:${change}`));
			const put = slice
				.filter(([change, known]) => (kept.get(`head:${change}`)?.at ?? -Infinity) <= known.at)
				.map(([change, known]) => [`head:${change}`, known] as const);
			if (put.length) await this.ctx.storage.put(Object.fromEntries(put));
		}
	}

	/** The kept view `name`, whether it's fresh, and whether a build is running. */
	async view(name: string, maxAgeMs: number) {
		const [writes, kept, building] = await Promise.all([
			this.writes(),
			this.ctx.storage.get<View>(`view:${name}`),
			this.ctx.storage.get<number>(`building:${name}`),
		]);
		return {
			json: kept?.json,
			fresh: !!kept && kept.writes === writes && Date.now() - kept.at < maxAgeMs,
			building: !!building && Date.now() - building < BUILD_LEASE_MS,
			writes,
		};
	}

	/** Returns true if this caller should build `name`, so only one build runs at a time. */
	async startBuild(name: string) {
		const building = await this.ctx.storage.get<number>(`building:${name}`);
		if (building && Date.now() - building < BUILD_LEASE_MS) return false;
		await this.ctx.storage.put(`building:${name}`, Date.now());
		return true;
	}

	async keep(name: string, json: string, writes: number) {
		await this.ctx.storage.put<View>(`view:${name}`, { json, writes, at: Date.now() });
		await this.ctx.storage.delete(`building:${name}`);
		this.broadcast(`view:${name}`);
	}

	async buildFailed(name: string) {
		await this.ctx.storage.delete(`building:${name}`);
	}

	/** A record's state at `tip`, if a reader kept it (see StateCache in record-log.ts). */
	async recordAt(ref: string, tip: string) {
		const kept = await this.ctx.storage.get<{ tip: string; json: string }>(`record:${ref}`);
		return kept?.tip === tip ? kept.json : undefined;
	}

	/** Only the latest tip's state is kept. */
	async keepRecord(ref: string, tip: string, json: string) {
		if (json.length > 1_000_000) return;
		await this.ctx.storage.put(`record:${ref}`, { tip, json });
	}

	/**
	 * Where a record's ref points (see TipCache in record-log.ts). Only one caller at a time is sent
	 * to list the ref. When nothing is kept, the others wait; when the tip is old, they use it anyway.
	 */
	async tipOf(
		ref: string,
		stateKey: string,
		maxAgeMs: number,
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
		const state = kept.tip
			? await this.ctx.storage.get<{ tip: string; json: string }>(`record:${stateKey}`)
			: undefined;
		if (state?.tip !== kept.tip) return { tip: kept.tip, gen: kept.gen };
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
	}

	/** A write built on `parent` found the ref had moved, so a kept `parent` tip is out of date. */
	async staleTip(ref: string, parent: string | null) {
		const kept = await this.ctx.storage.get<KeptTip>(`tip:${ref}`);
		if (kept && kept.tip === parent) await this.ctx.storage.put(`tip:${ref}`, { gen: kept.gen + 1 });
	}

	/**
	 * Queue forks to make in the background: seeds ("seed:<k>") and agents' forks ("agent:<name>").
	 * Seeds go one at a time because a burst of forks from one repo stalls Artifacts' fork jobs.
	 * The queue only paces creation; an agent that needs its fork sooner makes it itself.
	 */
	async queueForks(repo: string, items: string[]) {
		await this.inQueueTurn(async () => {
			const queue = (await this.ctx.storage.get<ForkJob[]>("forks:queue")) ?? [];
			const ready = new Set((await this.readySeeds()).map((seed) => `seed:${seed}`));
			const fresh = items.filter((item) => !ready.has(item) && !queue.some((job) => job.item === item));
			if (!fresh.length) return;
			await this.ctx.storage.put("forks:queue", [...queue, ...fresh.map((item) => ({ item, tries: 0 }))]);
			await this.ctx.storage.put("forks:repo", repo);
			if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 100);
		});
	}

	/** Serializes changes to the fork queue, since forks finish side by side while agents add more. */
	private queueTurn: Promise<unknown> = Promise.resolve();
	private inQueueTurn<T>(change: () => Promise<T>): Promise<T> {
		const run = this.queueTurn.then(change);
		this.queueTurn = run.catch(() => undefined);
		return run;
	}

	async readySeeds() {
		return (await this.ctx.storage.get<number[]>("forks:seeds")) ?? [];
	}

	/** Progress of the fork queue, for the landing view and tests. */
	async forkQueue() {
		const [queue, seeds] = await Promise.all([this.ctx.storage.get<ForkJob[]>("forks:queue"), this.readySeeds()]);
		const queued = queue ?? [];
		const seedsQueued = queued.filter((job) => job.item.startsWith("seed:")).length;
		return { seedsReady: seeds.length, seedsQueued, agentsQueued: queued.length - seedsQueued };
	}

	async alarm() {
		// Log the Artifacts and Git requests each round makes.
		const counting = countingRequests(() => this.makeForks());
		try {
			await counting.done;
		} finally {
			const repo = await this.ctx.storage.get<string>("forks:repo");
			const counts = describeCounts(repo ?? "", counting.requests, counting.artifacts);
			if (counts) console.log(`fork queue for ${repo} ${counts}`);
		}
	}

	private async makeForks() {
		const repo = await this.ctx.storage.get<string>("forks:repo");
		const queue = await this.queuedForks();
		if (!repo || !queue.length) return;
		// Seeds first, one per alarm. Then agents' forks side by side until the queue is empty or the round ends.
		const seeding = queue.some((job) => isSeed(job.item));
		const until = Date.now() + FORK_ROUND_MS;
		const making = new Set<string>();
		const next = () => this.takeForkJob(making, seeding);
		const worker = async () => {
			for (let job = await next(); job; job = seeding || Date.now() > until ? undefined : await next()) {
				const failure = await makeFork(this.env, repo, job.item);
				await this.finishForkJob(repo, job, failure);
				making.delete(job.item);
			}
		};
		await Promise.all(Array.from({ length: seeding ? 1 : AGENT_FORKS_AT_ONCE }, worker));
		if ((await this.queuedForks()).length) await this.ctx.storage.setAlarm(Date.now() + 1_000);
	}

	private async queuedForks() {
		return (await this.ctx.storage.get<ForkJob[]>("forks:queue")) ?? [];
	}

	/** The next queued job no worker is making, of this round's kind. */
	private takeForkJob(making: Set<string>, seeding: boolean) {
		return this.inQueueTurn(async () => {
			const queue = await this.queuedForks();
			// A seed queued during an agents' round waits for the next alarm.
			const job = queue.find((queued) => !making.has(queued.item) && isSeed(queued.item) === seeding);
			if (job) making.add(job.item);
			return job;
		});
	}

	/** Take a finished job off the queue: a made seed is ready, and a failed job is tried again or given up on. */
	private finishForkJob(repo: string, job: ForkJob, failure: unknown) {
		return this.inQueueTurn(async () => {
			const rest = (await this.queuedForks()).filter((queued) => queued.item !== job.item);
			if (failure === null && isSeed(job.item)) {
				const ready = await this.readySeeds();
				const seeds = [...new Set([...ready, seedNumber(job.item)])].sort((a, b) => a - b);
				await this.ctx.storage.put("forks:seeds", seeds);
			}
			if (failure !== null && job.tries + 1 < FORK_TRIES) rest.push({ ...job, tries: job.tries + 1 });
			else if (failure !== null)
				console.error(`fork queue for ${repo} gave up on ${job.item}: ${String(failure).slice(0, 200)}`);
			await this.ctx.storage.put("forks:queue", rest);
		});
	}

	/** The lease holder handed the lease on (see toolkit/landing-lease.ts), so nothing is being checked. */
	async dropLanding(branch: string, _holder: string) {
		await this.keepLanding(branch, { ...(await this.landing(branch)), checking: null });
		this.broadcast("landing");
	}

	async landingChecking(branch: string, batch: Checking | null) {
		await this.keepLanding(branch, { ...(await this.landing(branch)), checking: batch });
		this.broadcast("landing");
	}

	/** Keeps a batch's outcomes, and returns the repo's last stretch of work with them in it (see stretch.ts). */
	async landingSettled(branch: string, outcomes: Settled[]) {
		if (!outcomes.length) return undefined;
		await this.keepLanding(branch, settleOutcomes(await this.landing(branch), outcomes));
		await this.keepEvents(settledEvents(outcomes));
		const stretch = extendStretch(await this.ctx.storage.get<Stretch>("stretch"), outcomes);
		if (stretch) await this.ctx.storage.put("stretch", stretch);
		this.broadcast("landing");
		return stretch && stretchSummary(stretch);
	}

	async landingView(branch: string) {
		const [{ checking, recent }, stretch] = await Promise.all([
			this.landing(branch),
			this.ctx.storage.get<Stretch>("stretch"),
		]);
		return { checking, recent, ...(stretch ? { stretch: stretchSummary(stretch) } : {}) };
	}

	/**
	 * Other agents' changes that landed on `branch` since `agent` was last told, newest last.
	 * An agent's first call returns nothing, so news starts from there.
	 */
	async landingNews(branch: string, agent: string) {
		const { recent } = await this.landing(branch);
		const key = `news:${branch}:${agent}`;
		const told = await this.ctx.storage.get<string>(key);
		const latest = recent.at(-1)?.at;
		if (latest && latest !== told) await this.ctx.storage.put(key, latest);
		if (!told) return [];
		return asNews(recent.filter((settled) => settled.at > told && settled.agent !== agent)).slice(-NEWS_MOST);
	}

	private async landing(branch: string) {
		return (await this.ctx.storage.get<LandingState>(`landing:${branch}`)) ?? emptyLanding();
	}

	private async keepLanding(branch: string, state: LandingState) {
		await this.ctx.storage.put(`landing:${branch}`, state);
	}

	/** Forget everything kept for the repo once it's deleted. */
	async clearViews() {
		// A repo created again under the same name reuses change names, so the old heads go too.
		const keys: string[] = [];
		for (const prefix of KEPT_PREFIXES) keys.push(...(await this.ctx.storage.list({ prefix })).keys());
		for (let i = 0; i < keys.length; i += STORAGE_BATCH)
			await this.ctx.storage.delete(keys.slice(i, i + STORAGE_BATCH));
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
				// The page went away; the runtime closes the socket.
			}
		}
	}

	// Pages only listen; anything they send is ignored.
	async webSocketMessage() {}

	async webSocketClose(socket: WebSocket, code: number) {
		socket.close(code === 1005 ? 1000 : code, "closed");
	}
}

const isSeed = (item: string) => item.startsWith("seed:");
const seedNumber = (item: string) => Number(item.slice("seed:".length));

/** Make a queued seed or agent's fork. Returns null when it was made, else the failure. */
function makeFork(env: Env, repo: string, item: string): Promise<unknown> {
	const making = isSeed(item)
		? makeSeed(env, repo, seedNumber(item))
		: makeAgentFork(env, repo, item.slice("agent:".length));
	return making.then(
		() => null,
		(err: unknown) => err,
	);
}
