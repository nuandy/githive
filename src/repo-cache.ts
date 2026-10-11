import { DurableObject } from "cloudflare:workers";
import { Traffic, objectLabel } from "./cache-traffic";
import { countingRequests, describeCounts } from "./git-http";
import { EVENTS_KEPT, type HiveEvent, eventKey, pushEvents, settledEvents } from "./hive-events";
import { makeAgentFork, makeSeed } from "./toolkit/env";
import { type Stretch, extendStretch, stretchSummary } from "./toolkit/stretch";
import {
	asNews,
	type Checking,
	emptyLanding,
	type Landed,
	type LandingState,
	type Settled,
	settleOutcomes,
} from "./toolkit/landing";

// One per repo ("repo:<repo>"). It holds copies and hints that make reads fast: live-update sockets for pages,
// prebuilt views, the hive's events, changes' heads, landing progress, agents' news and the fork queue. Record tips
// and states (RecordCache) and what merges keep for their landing (ChangeCache) have objects of their own, so they
// don't share this one's memory. Git stays the source of truth, so losing any of this costs only speed.

interface View {
	json: string;
	/** The write count when it was built; a later write makes it stale. */
	writes: number;
	at: number;
}

/** How long a build may run before another caller may start one. */
const BUILD_LEASE_MS = 2 * 60_000;

/** The most landings one reply tells an agent about; the newest are kept. */
const NEWS_MOST = 20;

/** A message for one agent about its change, kept until told (see docs/awareness.md, "The news channel"). */
export interface Notice {
	/** "interface", "heads_up", "note", ...: an open set, but never "landed", which marks landed news. */
	kind: string;
	/** The ISO time it was noted. */
	at: string;
	/** One line an agent can read. */
	says: string;
	/** What the agent might do about it. */
	next?: string;
	/** The recipient's change it is about. */
	change?: string;
	from?: { agent: string; change?: string };
	detail?: Record<string, unknown>;
}

/** What a reply tells an agent: what others landed, then its notices. */
export type NewsItem = (Landed & { kind: "landed" }) | Notice;

const NOTICE = "notice:";
/** The most notices kept for one agent on one branch; the oldest are dropped. */
const NOTICES_KEPT = 50;
/** How long a notice is kept untold. */
const NOTICE_MS = 24 * 60 * 60_000;

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

/** A queued job, with the key that holds it. Keys sort in the order jobs were queued. */
type QueuedFork = ForkJob & { key: string };

const FORK_JOB = "forks:job:";
const EVENT = "event:";
/** The event log is trimmed to EVENTS_KEPT after this many writes. */
const EVENT_WRITES_PER_TRIM = 20;

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
	"forks:",
	"landing:",
	"head:",
	"files:",
	"news:",
	"notice:",
	"merge:",
	// Record tips and states, and packs, before they had objects of their own.
	"record:",
	"tip:",
	"pack:",
	"placed:",
	"kept-at:",
];

/** Where the names of the repo's RecordCaches are noted, so a deleted repo's can be forgotten too. */
const RECORD_CACHE = "record-cache:";

/** A change's merge check as status worked it out, for the change head and branch head in `key`. */
export interface KeptMergeCheck {
	key: string;
	result: unknown;
}

export class RepoCache extends DurableObject<Env> {
	private readonly traffic = new Traffic(() => objectLabel(this.ctx));
	private eventWrites = 0;

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
		await this.eventsByKey();
		const newest = await this.ctx.storage.list<HiveEvent>({ prefix: EVENT, reverse: true, limit: EVENTS_KEPT });
		return [...newest.values()].reverse();
	}

	// Each event under its own key, by its time then what it was, so an event delivered twice is kept once and
	// adding one never rewrites the others.
	private async keepEvents(events: HiveEvent[]) {
		if (!events.length) return;
		await this.eventsByKey();
		await this.ctx.storage.put(Object.fromEntries(events.map((event) => [`${EVENT}${eventKey(event)}`, event])));
		this.eventWrites += 1;
		if (this.eventWrites % EVENT_WRITES_PER_TRIM === 0) await this.trimEvents();
	}

	private async trimEvents() {
		const keys = [...(await this.ctx.storage.list({ prefix: EVENT })).keys()];
		const old = keys.slice(0, Math.max(0, keys.length - EVENTS_KEPT));
		for (let i = 0; i < old.length; i += STORAGE_BATCH) await this.ctx.storage.delete(old.slice(i, i + STORAGE_BATCH));
	}

	// The log was once one list under "events"; its events move under keys of their own.
	private async eventsByKey() {
		const listed = await this.ctx.storage.get<HiveEvent[]>("events");
		if (!listed) return;
		await this.ctx.storage.put(Object.fromEntries(listed.map((event) => [`${EVENT}${eventKey(event)}`, event])));
		await this.ctx.storage.delete("events");
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

	/**
	 * The kept view `name`, whether it's fresh, and whether a build is running. Its JSON is left out when the caller
	 * already `has` this version of it, since a view can be large and many callers ask at once.
	 */
	async view(name: string, maxAgeMs: number, has?: number) {
		const [writes, kept, building] = await Promise.all([
			this.writes(),
			this.ctx.storage.get<View>(`view:${name}`),
			this.ctx.storage.get<number>(`building:${name}`),
		]);
		const sent = kept && kept.at !== has ? kept.json : undefined;
		this.traffic.sent(`view:${name}`, sent?.length ?? 0);
		return {
			json: sent,
			...(kept ? { version: kept.at } : {}),
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

	/** Keeps a view, and returns its version. */
	async keep(name: string, json: string, writes: number) {
		this.traffic.kept(`view:${name}`, json.length);
		const at = Date.now();
		await this.ctx.storage.put<View>(`view:${name}`, { json, writes, at });
		await this.ctx.storage.delete(`building:${name}`);
		this.broadcast(`view:${name}`);
		return at;
	}

	async buildFailed(name: string) {
		await this.ctx.storage.delete(`building:${name}`);
	}

	/**
	 * Queue forks to make in the background: seeds ("seed:<k>") and agents' forks ("agent:<name>").
	 * Seeds go one at a time because a burst of forks from one repo stalls Artifacts' fork jobs.
	 * The queue only paces creation; an agent that needs its fork sooner makes it itself.
	 */
	async queueForks(repo: string, items: string[]) {
		await this.inQueueTurn(async () => {
			const queued = new Set((await this.queuedForks()).map((job) => job.item));
			const ready = new Set((await this.readySeeds()).map((seed) => `seed:${seed}`));
			const fresh = [...new Set(items)].filter((item) => !ready.has(item) && !queued.has(item));
			if (!fresh.length) return;
			await this.addForkJobs(fresh.map((item) => ({ item, tries: 0 })));
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
		const [queued, seeds] = await Promise.all([this.queuedForks(), this.readySeeds()]);
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

	// Each job under its own key, numbered as queued, so finishing one never rewrites the rest.
	private async queuedForks(): Promise<QueuedFork[]> {
		await this.forkJobsByKey();
		const listed = await this.ctx.storage.list<ForkJob>({ prefix: FORK_JOB });
		return [...listed].map(([key, job]) => ({ ...job, key }));
	}

	private async addForkJobs(jobs: ForkJob[]) {
		const next = (await this.ctx.storage.get<number>("forks:next")) ?? 0;
		const entries = jobs.map((job, index) => [`${FORK_JOB}${String(next + index).padStart(12, "0")}`, job]);
		for (let i = 0; i < entries.length; i += STORAGE_BATCH)
			await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + STORAGE_BATCH)));
		await this.ctx.storage.put("forks:next", next + jobs.length);
	}

	// The queue was once one list under "forks:queue"; its jobs move under keys of their own.
	private async forkJobsByKey() {
		const listed = await this.ctx.storage.get<ForkJob[]>("forks:queue");
		if (!listed) return;
		await this.ctx.storage.delete("forks:queue");
		await this.addForkJobs(listed);
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
	private finishForkJob(repo: string, job: QueuedFork, failure: unknown) {
		return this.inQueueTurn(async () => {
			await this.ctx.storage.delete(job.key);
			if (failure === null && isSeed(job.item)) {
				const ready = await this.readySeeds();
				const seeds = [...new Set([...ready, seedNumber(job.item)])].sort((a, b) => a - b);
				await this.ctx.storage.put("forks:seeds", seeds);
			}
			// A failed job goes to the back of the queue.
			if (failure !== null && job.tries + 1 < FORK_TRIES)
				await this.addForkJobs([{ item: job.item, tries: job.tries + 1 }]);
			else if (failure !== null)
				console.error(`fork queue for ${repo} gave up on ${job.item}: ${String(failure).slice(0, 200)}`);
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

	/**
	 * What's landing on a branch, and the repo's last stretch of work. `firstStretch` is set when the stretch was
	 * just worked out, so the caller can note it in the repo list's summary.
	 */
	async landingView(branch: string) {
		const { checking, recent } = await this.landing(branch);
		const kept = await this.ctx.storage.get<Stretch>("stretch");
		const stretch = kept ?? (await this.stretchFrom(recent));
		const view = { checking, recent, ...(stretch ? { stretch: stretchSummary(stretch) } : {}) };
		return { ...view, ...(stretch && !kept ? { firstStretch: true } : {}) };
	}

	/** The stretch in outcomes that settled before stretches were kept, kept from now on. */
	private async stretchFrom(recent: Settled[]) {
		const stretch = extendStretch(undefined, recent);
		if (stretch) await this.ctx.storage.put("stretch", stretch);
		return stretch;
	}

	/**
	 * What `agent` hasn't been told on `branch`: other agents' changes that landed since it was last told, newest
	 * last, then its notices, oldest first. Landings start from an agent's first call; notices reach it on that call.
	 */
	async landingNews(branch: string, agent: string): Promise<NewsItem[]> {
		const { recent } = await this.landing(branch);
		const key = `news:${branch}:${agent}`;
		const told = await this.ctx.storage.get<string>(key);
		// The newest outcome, not the last kept: a failure noted later can carry an earlier time.
		const newest = recent
			.map((settled) => settled.at)
			.sort()
			.at(-1);
		// A first call starts the cursor even when nothing has landed, so the first landings on a new repo are told.
		if (!told) await this.ctx.storage.put(key, newest ?? new Date().toISOString());
		else if (newest && newest > told) await this.ctx.storage.put(key, newest);
		const landed = told
			? asNews(recent.filter((settled) => settled.at > told && settled.agent !== agent)).slice(-NEWS_MOST)
			: [];
		const notices = await this.takeNotices(branch, agent);
		return [...landed.map((news) => ({ kind: "landed" as const, ...news })), ...notices];
	}

	/**
	 * Leave notices for agents on `branch`, told with their next reply (see landingNews). Each agent keeps its newest
	 * NOTICES_KEPT, for a day at most.
	 */
	async notify(branch: string, notices: { agent: string; notice: Notice }[]) {
		// Keyed by time, so an agent's notices list oldest first.
		const entries = notices.map(
			({ agent, notice }) => [`${noticesOf(branch, agent)}${notice.at}:${crypto.randomUUID()}`, notice] as const,
		);
		for (let i = 0; i < entries.length; i += STORAGE_BATCH)
			await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + STORAGE_BATCH)));
		for (const agent of new Set(notices.map((each) => each.agent))) {
			const kept = [...(await this.ctx.storage.list<Notice>({ prefix: noticesOf(branch, agent) }))];
			const dropped = kept.filter(([, notice], index) => index < kept.length - NOTICES_KEPT || expired(notice));
			await this.deleteKeys(dropped.map(([key]) => key));
		}
	}

	// An agent's notices that are still current, oldest first. All of them are deleted: told once, a reply lost on
	// the way loses them, which is fine for advice.
	private async takeNotices(branch: string, agent: string) {
		const kept = [...(await this.ctx.storage.list<Notice>({ prefix: noticesOf(branch, agent) }))];
		if (!kept.length) return [];
		await this.deleteKeys(kept.map(([key]) => key));
		return kept
			.map(([, notice]) => notice)
			.filter((notice) => !expired(notice))
			.slice(-NOTICES_KEPT);
	}

	private async deleteKeys(keys: string[]) {
		for (let i = 0; i < keys.length; i += STORAGE_BATCH)
			await this.ctx.storage.delete(keys.slice(i, i + STORAGE_BATCH));
	}

	private async landing(branch: string) {
		return (await this.ctx.storage.get<LandingState>(`landing:${branch}`)) ?? emptyLanding();
	}

	private async keepLanding(branch: string, state: LandingState) {
		await this.ctx.storage.put(`landing:${branch}`, state);
	}

	/** Notes a RecordCache of the repo's, so clearViews can name it. */
	async noteRecordCache(name: string) {
		await this.ctx.storage.put(`${RECORD_CACHE}${name}`, true);
	}

	/**
	 * Forget everything kept for the repo once it's deleted. Returns the names of its RecordCaches, for the caller
	 * to forget too.
	 */
	async clearViews() {
		const recordCaches = [...(await this.ctx.storage.list({ prefix: RECORD_CACHE })).keys()];
		// A repo created again under the same name reuses change names, so the old heads go too.
		const keys: string[] = [...recordCaches];
		for (const prefix of KEPT_PREFIXES) keys.push(...(await this.ctx.storage.list({ prefix })).keys());
		for (let i = 0; i < keys.length; i += STORAGE_BATCH)
			await this.ctx.storage.delete(keys.slice(i, i + STORAGE_BATCH));
		return recordCaches.map((key) => key.slice(RECORD_CACHE.length));
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

/** Where an agent's notices on a branch are kept. Neither branch nor agent names hold a ":". */
const noticesOf = (branch: string, agent: string) => `${NOTICE}${branch}:${agent}:`;

const expired = (notice: Notice, now = Date.now()) => now - Date.parse(notice.at) > NOTICE_MS;

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
