import { DurableObject } from "cloudflare:workers";
import { Traffic, objectLabel } from "./cache-traffic";
import { countingRequests, describeCounts } from "./git-http";
import {
	changeNoticesFor,
	type Delivery,
	NEWS_PREFIXES,
	newsFor,
	noticeAtKey,
	type Told,
	keepNoticeTimes,
	toldKey,
	trimTold,
} from "./news-log";
import { keepPageMessage, PAGE_PREFIXES, pageMessagesSince } from "./page-feed";
import type { KeptPushHints } from "./push-hints";
import { pushFlags, type SteeringFlag, withFlag } from "./steering";
import { rpc } from "./rpc";
import { EVENTS_KEPT, type HiveEvent, eventKey, pushEvents, settledEvents } from "./hive-events";
import { makeAgentFork, makeSeed } from "./toolkit/env";
import { type Stretch, extendStretch, freshStretch, stretchSummary } from "./toolkit/stretch";
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

/** How many changes' files (`diff:<change>` views, each up to most of a megabyte) a repo keeps: the last kept. */
const DIFFS_KEPT = 20;
/** The names of the changes' files kept, the last kept last. */
const DIFFS = "diffs-kept";

/** A message for one agent about its change, kept until told (see docs/awareness.md, "The news channel"). */
export interface Notice {
	/** "interface", "heads_up", ...: an open set, but never "landed", which marks landed news. */
	kind: string;
	/** The ISO time it was noted. */
	at: string;
	/** One line an agent can read. */
	says: string;
	/** What the agent might do about it. */
	next?: string;
	/** The recipient's change it is about. */
	change?: string;
	/** The branch that change goes into. notify sets it, so an agent hears of its changes into every branch. */
	branch?: string;
	from?: { agent: string; change?: string };
	detail?: Record<string, unknown>;
}

/** What a reply tells an agent: what others landed, then its notices. */
export type NewsItem = (Landed & { kind: "landed" }) | Notice;

const NOTICE = "notice:";
/** How long a notice is kept untold. */
const NOTICE_MS = 24 * 60 * 60_000;

const ATTEMPTS = "attempts:";
/** The most attempts kept for one change, the newest, and the most characters kept of each. */
const ATTEMPTS_KEPT = 10;
const ATTEMPT_CHARS = 200;

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
	DIFFS,
	"forks:",
	"landing:",
	"head:",
	"files:",
	"news:",
	"notice:",
	...NEWS_PREFIXES,
	...PAGE_PREFIXES,
	"attempts:",
	"merge:",
	// Record tips and states, and packs, before they had objects of their own.
	"record:",
	"tip:",
	"pack:",
	"placed:",
	"kept-at:",
	// The hive's feed and what Clef kept, which a repo made again under the name would otherwise show as its own.
	EVENT,
	"steering:",
	"push-hints:",
	"stretch",
];

/** Where the names of the repo's RecordCaches are noted, so a deleted repo's can be forgotten too. */
const RECORD_CACHE = "record-cache:";
/** The repo's hosted agents to ring (see ringHive), with when they asked, so a stale answer can't drop a new hive. */
const HIVE = "hive";
/** How many times the doorbell has rung, so a waiting agent can tell whether it missed one (see ringAfter). */
const RINGS = "rings";
/** Each ring, by its count, with whom it concerns, so a `wait` can tell what rang for it between two calls. */
const RING = "ring:";
/** How many rings the log keeps: a `seen` older than that looks at once instead. */
export const RINGS_KEPT = 500;
/** The longest one call holds, well inside the 60 s MCP clients commonly allow a call. */
export const LONGEST_HOLD_MS = 45_000;

/** A change's merge check as status worked it out, for the change head and branch head in `key`. */
export interface KeptMergeCheck {
	key: string;
	result: unknown;
}

/** What a writer publishes (see RepoCache.publish). */
interface Published {
	/** What the ring tells agents, kept in the news log under its count. */
	told?: Told;
	events?: HiveEvent[];
	/** What the dashboard's pages are told changed. */
	kind?: string;
	/** Why the doorbell rings, for the hosted agents (see HostedAgent.ring); absent when no agent is concerned. */
	ring?: string;
	/** Whom the ring concerns, for held `wait` calls; every agent when absent. */
	whom?: Concerns;
}

/**
 * Whom a ring concerns: the agents named, and with `opens`, any agent it may offer work to. A ring that says neither is
 * about everything, as rings were before they said.
 */
export interface Concerns {
	for?: string[];
	opens?: true;
}

/** A ring as the hive hears it: why it rang, and whom it concerns. */
export type HiveRing = Concerns & { reason: string };

/** A ring as a held `wait` hears it: the count it brought the doorbell to, and why it rang. */
export interface Rung {
	rings: number;
	reasons: string[];
}

type LoggedRing = HiveRing;

interface Listener {
	agent?: string;
	wake(rung: Rung | null): void;
}

const ringKey = (rings: number) => `${RING}${String(rings).padStart(12, "0")}`;

// A held `wait` wakes for a ring about its agent or one that may offer it work. A listener that named no agent hears
// every ring, and every listener hears a ring that says nothing of whom it concerns.
function concerns(ring: LoggedRing, agent: string | undefined) {
	if (!agent) return true;
	if (ring.for === undefined && !ring.opens) return true;
	return !!ring.opens || ring.for!.includes(agent);
}

export class RepoCache extends DurableObject<Env> {
	private readonly traffic = new Traffic(() => objectLabel(this.ctx));
	private eventWrites = 0;
	/** Calls held in ringAfter, each woken by the next ring. */
	private readonly listening = new Set<Listener>();

	/**
	 * A dashboard page's live feed. A page that reconnects with `?since=<seq>`, the last message it had, is first sent
	 * what it missed (see page-feed.ts).
	 */
	async fetch(request: Request) {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		const since = Number(new URL(request.url).searchParams.get("since") ?? "");
		if (Number.isInteger(since) && since >= 0)
			for (const message of await pageMessagesSince(this.ctx.storage, since)) server.send(JSON.stringify(message));
		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Tell watching pages that something changed, and what for the hive's feed. A write makes the views stale, and
	 * rings the repo's hosted agents with the tool that made it.
	 */
	async ping(kind: string, write = true, events: HiveEvent[] = [], tool?: string, whom?: Concerns) {
		if (write) await this.ctx.storage.put("writes", (await this.writes()) + 1);
		await this.publish({ events, kind, ...(write ? { ring: tool ?? kind } : {}), ...(whom ? { whom } : {}) });
	}

	/** How many times the doorbell has rung. */
	async rings() {
		return (await this.ctx.storage.get<number>(RINGS)) ?? 0;
	}

	/**
	 * Holds the call until the doorbell rings past `mark` (from rings) with a ring that concerns `agent`, or any ring
	 * when no agent is named, then answers with the new count and why it rang: at once if it already has. Null if `ms`
	 * passes first. The caller decides whether what changed matters to it.
	 */
	async ringAfter(mark: number, ms: number, agent?: string): Promise<Rung | null> {
		const rings = await this.rings();
		if (rings > mark) {
			const reasons = await this.rungFor(agent, mark);
			// A mark older than the log can't be checked, so it counts as rung.
			if (reasons === null) return { rings, reasons: [] };
			if (reasons.length) return { rings, reasons };
		}
		return new Promise((resolve) => {
			const wake = (answer: Rung | null) => {
				clearTimeout(giveUp);
				this.listening.delete(listener);
				resolve(answer);
			};
			const listener: Listener = { ...(agent ? { agent } : {}), wake };
			const giveUp = setTimeout(() => wake(null), Math.min(Math.max(ms, 0), LONGEST_HOLD_MS));
			this.listening.add(listener);
		});
	}

	/**
	 * Why the doorbell rang for `agent` (for anyone when absent) after `mark`, oldest first: empty if nothing that
	 * concerned it rang. Null if the log no longer reaches back to `mark`.
	 */
	async rungFor(agent: string | undefined, mark: number): Promise<string[] | null> {
		const rings = await this.rings();
		if (rings <= mark) return [];
		if (rings - mark > RINGS_KEPT) return null;
		const range = { prefix: RING, start: ringKey(mark + 1), end: ringKey(rings + 1) };
		const logged = await this.ctx.storage.list<LoggedRing>(range);
		if (logged.size < rings - mark) return null;
		return [...logged.values()].filter((ring) => concerns(ring, agent)).map((ring) => ring.reason);
	}

	/** The repo's hosted agents want to hear when something changes, until none of them is running. */
	async hiveListens(repo: string) {
		await this.ctx.storage.put(HIVE, { repo, since: Date.now() });
	}

	/** The hive's recent events, oldest first (see hive-events.ts). */
	async events() {
		await this.eventsByKey();
		const newest = await this.ctx.storage.list<HiveEvent>({ prefix: EVENT, reverse: true, limit: EVENTS_KEPT });
		return [...newest.values()].reverse();
	}

	// Each event under its own key, by its time then what it was, so an event delivered twice is kept once and
	// adding one never rewrites the others.
	// Returns the events kept, the ones the log didn't have already.
	private async keepEvents(given: HiveEvent[]) {
		const events = await this.newConflicts(given);
		if (!events.length) return events;
		await this.eventsByKey();
		await this.ctx.storage.put(Object.fromEntries(events.map((event) => [`${EVENT}${eventKey(event)}`, event])));
		this.eventWrites += 1;
		if (this.eventWrites % EVENT_WRITES_PER_TRIM === 0) await this.trimEvents();
		return events;
	}

	// Events but the `conflicted` ones the log already has for the same change and head: an agent merging the same
	// conflicting commit again and again is one event, not a feed full of them.
	private async newConflicts(events: HiveEvent[]) {
		const conflicts = events.filter((event) => event.kind === "conflicted" && event.commit);
		if (!conflicts.length) return events;
		const key = (event: HiveEvent) => `${event.change}\0${event.commit}`;
		const kept = new Set(
			[...(await this.ctx.storage.list<HiveEvent>({ prefix: EVENT, reverse: true, limit: EVENTS_KEPT })).values()]
				.filter((event) => event.kind === "conflicted" && event.commit)
				.map(key),
		);
		return events.filter((event) => !conflicts.includes(event) || !kept.has(key(event)));
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

	/** What Clef made of a change's latest push, for its status (see push-hints.ts). */
	async keptPushHints(change: string) {
		return (await this.ctx.storage.get<KeptPushHints>(`push-hints:${change}`)) ?? null;
	}

	async keepPushHints(change: string, kept: KeptPushHints) {
		await this.ctx.storage.put(`push-hints:${change}`, kept);
	}

	/** Keeps what Clef found steering agents in text written about `change` (see steering.ts). */
	async flagSteering(change: string, flag: SteeringFlag) {
		const key = `steering:${change}`;
		const kept = (await this.ctx.storage.get<SteeringFlag[]>(key)) ?? [];
		await this.ctx.storage.put(key, withFlag(kept, flag));
	}

	/** Each change's steering flags: from what was written about it, and from its latest push. Unflagged, left out. */
	async steeringOf(changes: string[]) {
		const flags: Record<string, SteeringFlag[]> = {};
		// Two keys a change: half a batch of changes at a time.
		const step = Math.floor(STORAGE_BATCH / 2);
		for (let i = 0; i < changes.length; i += step) {
			const some = changes.slice(i, i + step);
			const keys = some.flatMap((change) => [`steering:${change}`, `push-hints:${change}`]);
			const got = await this.ctx.storage.get<SteeringFlag[] | KeptPushHints>(keys);
			for (const change of some) {
				const written = (got.get(`steering:${change}`) as SteeringFlag[] | undefined) ?? [];
				const pushed = got.get(`push-hints:${change}`) as KeptPushHints | undefined;
				const all = [...written, ...pushFlags(pushed?.hints ?? [])];
				if (all.length) flags[change] = all;
			}
		}
		return flags;
	}

	/** Note pushes from push events. Events can arrive late, twice or out of order, so the newest wins. */
	async notePushes(pushes: ChangePush[]) {
		await this.keepNewest(pushes.map(({ change, ...known }) => [change, known]));
		const events = pushEvents(pushes);
		if (!events.length) return;
		// A push offers its change for review.
		await this.publish({ events, kind: "pushed", ring: "pushed", whom: { opens: true } });
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
		if (name.startsWith("diff:")) await this.keptDiff(name);
		await this.publish({ kind: `view:${name}` });
		return at;
	}

	// Notes a change's files as kept last, and forgets the oldest past DIFFS_KEPT, to be built again if read again.
	private async keptDiff(name: string) {
		const kept = [...((await this.ctx.storage.get<string[]>(DIFFS)) ?? []).filter((each) => each !== name), name];
		const forgotten = kept.splice(0, Math.max(0, kept.length - DIFFS_KEPT));
		await this.ctx.storage.put(DIFFS, kept);
		if (forgotten.length) await this.ctx.storage.delete(forgotten.map((each) => `view:${each}`));
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
		await this.publish({ kind: "landing" });
	}

	async landingChecking(branch: string, batch: Checking | null) {
		await this.keepLanding(branch, { ...(await this.landing(branch)), checking: batch });
		await this.publish({ kind: "landing" });
	}

	/** Keeps a batch's outcomes, and returns the repo's last stretch of work with them in it (see stretch.ts). */
	async landingSettled(branch: string, outcomes: Settled[]) {
		if (!outcomes.length) return undefined;
		await this.keepLanding(branch, settleOutcomes(await this.landing(branch), outcomes));
		// Attempts are kept by change name, and a name can be claimed again: a landed change's go, so a later claim's
		// story doesn't start with them.
		await this.deleteKeys(outcomes.filter((each) => each.how === "landed").map((each) => `${ATTEMPTS}${each.change}`));
		const stretch = extendStretch(await this.ctx.storage.get<Stretch>("stretch"), outcomes);
		if (stretch) await this.ctx.storage.put("stretch", stretch);
		const landed = asNews(outcomes);
		const told = landed.length ? { told: { landed: { branch, news: landed } } } : {};
		// A landing concerns each change's agent, and may free work waiting on it for anyone.
		const whom: Concerns = { for: [...new Set(outcomes.map((outcome) => outcome.agent))], opens: true };
		await this.publish({ events: settledEvents(outcomes), kind: "landing", ring: "landed", whom, ...told });
		return stretch && stretchSummary(stretch);
	}

	/** Begins a new stretch of work at `at`, whatever landed just before (see freshStretch). */
	async startStretch(at: string) {
		await this.ctx.storage.put("stretch", freshStretch(at));
	}

	/**
	 * What's landing on a branch, and the repo's last stretch of work. `firstStretch` is set when the stretch was
	 * just worked out, so the caller can note it in the repo list's summary.
	 */
	async landingView(branch: string) {
		const { checking, recent } = await this.landing(branch);
		const kept = await this.ctx.storage.get<Stretch>("stretch");
		const stretch = kept ?? (await this.stretchFrom(recent));
		// One begun with nothing in it yet has nothing to say.
		const shown = stretch && stretch.landed + stretch.failed > 0 ? stretch : undefined;
		const view = { checking, recent, ...(shown ? { stretch: stretchSummary(shown) } : {}) };
		return { ...view, ...(stretch && !kept ? { firstStretch: true } : {}) };
	}

	/** The stretch in outcomes that settled before stretches were kept, kept from now on. */
	private async stretchFrom(recent: Settled[]) {
		const stretch = extendStretch(undefined, recent);
		if (stretch) await this.ctx.storage.put("stretch", stretch);
		return stretch;
	}

	/**
	 * What `agent` hasn't been told: other agents' changes that landed on `branch`, then its notices on every branch,
	 * read from its cursor in the news log (see news-log.ts). `delivery` is `wait`'s, whose cursor moves only when the
	 * next call shows the reply arrived.
	 */
	async newsFor(branch: string, agent: string, delivery: Delivery = {}): Promise<NewsItem[]> {
		const news = await newsFor(this.ctx.storage, await this.rings(), { branch, agent }, delivery);
		return [...news, ...(await this.noticesFromBefore(agent))];
	}

	/**
	 * Leave notices for agents about their changes into `branch`, told with their next reply on any branch (see
	 * landingNews), and the hive events that go with them. A notice rings, so an agent in `wait` hears it at once.
	 */
	async notify(branch: string, notices: { agent: string; notice: Notice }[], events: HiveEvent[] = []) {
		const told = notices.map(({ agent, notice }) => ({ agent, notice: { ...notice, branch } }));
		await this.publish({
			...(told.length ? { told: { notices: told } } : {}),
			events,
			...(events.length ? { kind: "awareness" } : {}),
			...(notices.length ? { ring: "notice", whom: { for: [...new Set(notices.map(({ agent }) => agent))] } } : {}),
		});
	}

	/** When `agent`'s newest notice was noted, or null if it has had none: what `wait` watches for notices. */
	async newestNotice(agent: string) {
		return (await this.ctx.storage.get<string>(noticeAtKey(agent))) ?? null;
	}

	/**
	 * What every writer tells the repo, in one call, so none leaves a listener out: what it tells agents and hive events kept, the
	 * dashboard's pages told `kind` (to read again), and the doorbell rung with `ring`, for held `wait` calls and the
	 * hosted agents. A change that concerns no agent, such as a landing being checked, rings nothing.
	 */
	private async publish(published: Published) {
		const events = await this.keepEvents(published.events ?? []);
		if (published.kind) await this.broadcast(published.kind, events);
		if (published.ring) await this.ring(published.ring, published.whom, published.told);
	}

	// Notices kept one per key before the news log, told once and deleted as they were then. None is newer than a day
	// before the log came, so once a day has passed there are none to find.
	private async noticesFromBefore(agent: string) {
		const kept = [...(await this.ctx.storage.list<Notice>({ prefix: noticesOf(agent) }))];
		if (!kept.length) return [];
		await this.deleteKeys(kept.map(([key]) => key));
		return kept.map(([, notice]) => notice).filter((notice) => !expired(notice));
	}

	/**
	 * `agent`'s notices about `change` that GitHive's hosted builder hasn't had, from a cursor of its own: how it hears
	 * about the change it builds, since its toolkit calls aren't the agent's own and bring no news.
	 */
	async changeNotices(agent: string, change: string): Promise<Notice[]> {
		return changeNoticesFor(this.ctx.storage, await this.rings(), agent, change);
	}

	/** Notes an attempt of `change`'s to land, such as a conflict or a failed check, for its merge commit's story. */
	async noteAttempt(change: string, line: string) {
		const key = `${ATTEMPTS}${change}`;
		const kept = (await this.ctx.storage.get<string[]>(key)) ?? [];
		const cut = line.slice(0, ATTEMPT_CHARS);
		// An agent merging the same conflicting commit again, or failing the same way, is one attempt in the story.
		if (kept.at(-1) === cut) return;
		await this.ctx.storage.put(key, [...kept, cut].slice(-ATTEMPTS_KEPT));
	}

	/** Forgets these changes' attempts: their claims were released without merging, and a name can be claimed again. */
	async forgetAttempts(changes: string[]) {
		await this.deleteKeys(changes.map((change) => `${ATTEMPTS}${change}`));
	}

	/** The attempts noted for each change, oldest first. A change with none is left out. */
	async attemptsOf(changes: string[]) {
		const unique = [...new Set(changes)];
		const noted: Record<string, string[]> = {};
		for (let i = 0; i < unique.length; i += STORAGE_BATCH) {
			const keys = unique.slice(i, i + STORAGE_BATCH).map((change) => `${ATTEMPTS}${change}`);
			const got = await this.ctx.storage.get<string[]>(keys);
			for (const [key, lines] of got) noted[key.slice(ATTEMPTS.length)] = lines;
		}
		return noted;
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

	// Wakes the repo's hosted agents (see HostedAgent.ring), without holding up the write that rang. Ringing is a hint:
	// one lost costs only the agents' fallback turn. Once none is running, the repo stops ringing.
	// Counted first, so a call that read the count just before this can't miss it.
	private async ring(reason: string, whom?: Concerns, told?: Told) {
		const rings = (await this.rings()) + 1;
		const logged: LoggedRing = { reason, ...whom };
		if (told) await keepNoticeTimes(this.ctx.storage, told);
		await this.ctx.storage.put({
			[RINGS]: rings,
			[ringKey(rings)]: logged,
			...(told ? { [toldKey(rings)]: told } : {}),
		});
		if (rings > RINGS_KEPT) await this.ctx.storage.delete(ringKey(rings - RINGS_KEPT));
		if (told) await trimTold(this.ctx.storage);
		for (const listener of [...this.listening])
			if (concerns(logged, listener.agent)) listener.wake({ rings, reasons: [reason] });
		this.ringHive(logged);
	}

	private ringHive(rung: HiveRing) {
		const ring = async () => {
			const hive = await this.ctx.storage.get<{ repo: string; since: number }>(HIVE);
			if (!hive || !this.env.HOSTED_AGENT) return;
			const running = await rpc(this.env.HOSTED_AGENT.getByName(`hive:${hive.repo}`).ringAgents(rung));
			const current = await this.ctx.storage.get<{ since: number }>(HIVE);
			if (!running && current?.since === hive.since) await this.ctx.storage.delete(HIVE);
		};
		void ring().catch((err) => console.error(`ringing the hive (${rung.reason}) failed`, String(err)));
	}

	// Sends watching pages what changed, with its events, numbered and kept for a page that reconnects.
	private async broadcast(kind: string, events: HiveEvent[] = []) {
		const message = JSON.stringify(await keepPageMessage(this.ctx.storage, kind, events));
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

/** Where an agent's notices are kept, whatever branch they're about. Agent names don't hold a ":". */
const noticesOf = (agent: string) => `${NOTICE}${agent}:`;

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
