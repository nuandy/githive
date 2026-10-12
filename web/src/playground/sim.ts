import type { BacklogItem, HiveEvent, RepoLanding, RepoSnapshot, RepoTree } from "../api";
import { leaseFor } from "../../../src/toolkit/staleness";
import { Rand, spread } from "./random";
import {
	type AgentPlan,
	type BacklogPlan,
	type Fate,
	type GoalPlan,
	PERSON,
	SCENARIOS,
	type ScenarioName,
	type ScenarioPlan,
	scenarioPlan,
} from "./scenarios";

// The playground's simulator: agents from several owners arrive, claim work, build, push, review each other with
// evidence, fix what's rejected, ask a person, land in batches (sometimes failing) and give up, on a virtual clock.
// It keeps the records the server would and emits exactly the API's shapes, so the real Hive tab can draw them. The
// server's quirks are kept on purpose (see the notes where they arise): what the playground shows is what ships.

export { SCENARIOS };
export type { ScenarioName };

export interface SimState {
	/** Claims in force, and the votes on their commits, newest first. */
	snapshot: RepoSnapshot;
	/** The batch being checked, recent outcomes (newest last) and the current stretch of work. */
	landing: RepoLanding;
	/** Newest first, at most EVENTS_KEPT. */
	events: HiveEvent[];
	/** Main's files; files a change creates appear once it lands. */
	tree: RepoTree;
	/** Items not done yet: taken ones stay listed until their change lands. */
	backlog: BacklogItem[];
	/** The virtual clock, in ms since the epoch. */
	now: number;
}

/** A claim the server refused because another change held the item or its paths. It records no event for one. */
export interface Refusal {
	agent: string;
	change: string;
	at: number;
}

export interface Sim {
	readonly scenario: ScenarioName;
	/** The state now: parts that changed are new objects, so React sees them change. */
	state(): SimState;
	/** Moves the clock forward, running every action due on the way, in time order. */
	advance(ms: number): void;
	/** When the next action is due, or null when nothing is scheduled. */
	nextAt(): number | null;
	/** Jumps the clock to the next action and runs everything due then. */
	step(): void;
	/** A person votes on a change that waits on one: as the role it awaits, or answering its agent's question. */
	personVotes(change: string, verdict: "approve" | "reject"): void;
	/** Changes waiting on a person right now. */
	needsPerson(): string[];
	/** Nothing is scheduled and nothing waits on a person. */
	done(): boolean;
	/** How many events were emitted in all (the log keeps only the newest), and the claims refused. */
	stats(): { events: number; refused: Refusal[] };
}

/** When a run starts unless told otherwise: a fixed time, so runs compare. */
export const DEFAULT_START = Date.UTC(2026, 9, 12, 9, 0, 0);

/** How many events the log keeps (the server's EVENTS_KEPT). */
export const EVENTS_KEPT = 100;

const SECOND = 1_000;
const MINUTE = 60_000;
/** How many settled outcomes the landing keeps (the server's RECENT_KEPT). */
const RECENT_KEPT = 200;
/** How long with nothing landing ends a stretch of work (the server's STRETCH_GAP_MS). */
const STRETCH_GAP_MS = 15 * MINUTE;
/** How long a review a blocking role owes may wait unheld before GitHive flags it for people (ROLE_WAIT_MS). */
const ROLE_WAIT_MS = 10 * MINUTE;
const BATCH_MOST = 16;
/** How many times a change may be sent back before its agent gives it up (a hosted builder's revisions). */
const MOST_SENT_BACK = 3;
/** The role an ordinary review is cast in: what the toolkit's `reviews` hands out and its hosted reviewers vote as. */
const REVIEW_ROLE = "review";
const CHECKS_REVIEWER = "githive-checks";
/** Who holds a blocking role the policy doesn't grant: people, and GitHive's reviewers. */
const DEFAULT_GRANT = ["person:*", "githive"];

export function createSim(scenario: ScenarioName, seed: number, start = DEFAULT_START): Sim {
	return new Simulation(scenario, seed, start);
}

type Claim = RepoSnapshot["claims"][number];
type Vote = RepoSnapshot["votes"][number];
type Outcome = RepoLanding["recent"][number];

interface Agent {
	name: string;
	/** The identity its records are stamped with. */
	by: string;
	owner: string;
	hosted: boolean;
	/** Goals of its own still to do. */
	goals: GoalPlan[];
	reach?: AgentPlan["reach"];
	current: Change | null;
	arrived: boolean;
	/** A look for work, or a claim, is scheduled. */
	seeking: boolean;
	reviews: number;
	/** Items it gave up, which it won't take again. */
	dropped: Set<string>;
}

interface Change {
	id: string;
	agent: Agent;
	goal: GoalPlan;
	fate: Fate;
	/** A backlog item. */
	item: boolean;
	paths: string[];
	since: number;
	active: number;
	head: string | null;
	heads: string[];
	attention?: { reason: string; agent: string; at: number };
	/** Scripted rejections still to come. */
	rejections: string[];
	/** Whether its chance of a rejection by chance has been drawn (or ruled out). */
	drawn: boolean;
	/** How many more times its batch fails the checks. */
	failsLeft: number;
	failDrawn: boolean;
	asked: boolean;
	toldHeadsUp: boolean;
	/** Bumped by each push, so actions meant for an older head drop out. */
	epoch: number;
	/** How many of its heads were sent back. */
	sentBack: number;
	/** Follow-ups scheduled for the current head. */
	pending: Set<"fix" | "land">;
	wantsToLand: boolean;
	inBatch: boolean;
	open: boolean;
}

interface Cast {
	commit: string;
	reviewer: string;
	role: string;
	verdict: "approve" | "reject";
	evidence: string;
	at: number;
	by?: string;
}

interface Action {
	at: number;
	run: () => void;
}

interface Stretch {
	landed: number;
	failed: number;
	agents: string[];
	from: number;
	to: number;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** Whether two claimed entries can hold a common path (the server's entriesOverlap): a trailing slash is a folder. */
function overlap(a: string, b: string) {
	const dirA = a.endsWith("/") ? a : `${a}/`;
	const dirB = b.endsWith("/") ? b : `${b}/`;
	return a === b || dirA.startsWith(dirB) || dirB.startsWith(dirA);
}

const ownerOf = (plan: AgentPlan) => {
	if (plan.owner) return plan.owner;
	if (plan.hosted) return "githive";
	// Numbered agents ("agent-12") are each their own; a named one is its person's ("alice-claude" is alice's).
	return /^agent-\d+$/.test(plan.name) ? plan.name : (plan.name.split(/[-/]/)[0] ?? plan.name);
};

class Simulation implements Sim {
	readonly scenario: ScenarioName;
	private readonly plan: ScenarioPlan;
	private readonly rand: Rand;
	private readonly start: number;
	private now: number;
	private queue: Action[] = [];

	private readonly agents: Agent[];
	/** Claims in force, oldest first. */
	private claims: Change[] = [];
	private readonly open = new Map<string, Change>();
	private readonly merged = new Set<string>();
	private readonly announced = new Set<string>();
	private casts: Cast[] = [];
	private events: HiveEvent[] = [];
	private emitted = 0;
	private readonly refused: Refusal[] = [];

	private checking: RepoLanding["checking"] = null;
	private batchSoon = false;
	private recent: Outcome[] = [];
	private stretch: Stretch | undefined;
	private main: string;
	private files: string[];
	private backlog: BacklogItem[];

	private snapshotView?: RepoSnapshot;
	private landingView?: RepoLanding;
	private treeView?: RepoTree;
	private backlogView?: BacklogItem[];

	constructor(scenario: ScenarioName, seed: number, start: number) {
		this.scenario = scenario;
		// The scenario's name goes into the seed, so two scenarios on the same seed don't share commit ids.
		this.rand = new Rand(seed ^ spread(scenario, 0x7fffffff));
		this.plan = scenarioPlan(scenario, this.rand);
		this.start = start;
		this.now = start;
		this.main = this.rand.sha();
		this.files = [...this.plan.files];
		const added = iso(start - this.plan.backlogAge * MINUTE);
		this.backlog = this.plan.backlog.map((item) => ({
			id: item.change,
			title: item.title,
			intent: item.intent,
			paths: [...item.paths],
			...(item.after ? { after: [...item.after] } : {}),
			by: this.plan.backlogBy,
			at: added,
		}));
		this.agents = this.plan.agents.map((plan) => ({
			name: plan.name,
			// A hosted builder's records carry GitHive's builder; anyone else's the agent it registered as.
			by: plan.hosted ? "githive-builder" : `agent:${plan.name}`,
			owner: ownerOf(plan),
			hosted: !!plan.hosted,
			goals: [...(plan.goals ?? [])],
			...(plan.reach ? { reach: plan.reach } : {}),
			current: null,
			arrived: false,
			seeking: false,
			reviews: 0,
			dropped: new Set(),
		}));
		this.plan.agents.forEach((plan, index) => {
			const agent = this.agents[index]!;
			this.schedule(plan.arrives * MINUTE, () => this.arrive(agent));
		});
	}

	// The clock.

	state(): SimState {
		this.snapshotView ??= this.snapshotNow();
		this.landingView ??= this.landingNow();
		this.treeView ??= { ref: "main", commit: this.main, files: [...this.files], truncated: false };
		this.backlogView ??= this.backlog.map((item) => ({
			...item,
			...(item.paths ? { paths: [...item.paths] } : {}),
			...(item.after ? { after: [...item.after] } : {}),
		}));
		return {
			snapshot: this.snapshotView,
			landing: this.landingView,
			events: this.events,
			tree: this.treeView,
			backlog: this.backlogView,
			now: this.now,
		};
	}

	advance(ms: number) {
		const target = Math.round(this.now + Math.max(0, ms));
		for (let next = this.queue[0]; next && next.at <= target; next = this.queue[0]) this.runNext();
		this.now = target;
	}

	nextAt() {
		return this.queue[0]?.at ?? null;
	}

	step() {
		const due = this.queue[0]?.at;
		if (due === undefined) return;
		for (let next = this.queue[0]; next && next.at <= due; next = this.queue[0]) this.runNext();
	}

	done() {
		return !this.queue.length && !this.needsPerson().length;
	}

	stats() {
		return { events: this.emitted, refused: [...this.refused] };
	}

	private runNext() {
		const action = this.queue.shift();
		if (!action) return;
		this.now = Math.max(this.now, action.at);
		action.run();
		this.changed();
	}

	/** Runs `run` after `delay` ms. Actions due at the same time run in the order they were scheduled. */
	private schedule(delay: number, run: () => void) {
		const at = this.now + Math.max(0, Math.round(delay));
		let low = 0;
		let high = this.queue.length;
		while (low < high) {
			const mid = (low + high) >> 1;
			if (this.queue[mid]!.at <= at) low = mid + 1;
			else high = mid;
		}
		this.queue.splice(low, 0, { at, run });
	}

	/** Runs `run` after `delay` ms if the change is still open on the same head. */
	private later(change: Change, delay: number, run: () => void) {
		const epoch = change.epoch;
		this.schedule(delay, () => {
			if (change.open && change.epoch === epoch) run();
		});
	}

	private changed() {
		this.snapshotView = undefined;
		this.landingView = undefined;
	}

	private emit(event: Omit<HiveEvent, "at">) {
		this.events = [{ ...event, at: iso(this.now) }, ...this.events].slice(0, EVENTS_KEPT);
		this.emitted++;
	}

	// Agents finding work. Nothing assigns it: each looks at its own goals and the backlog and picks.

	private arrive(agent: Agent) {
		agent.arrived = true;
		this.look(agent);
	}

	private lookSoon(agent: Agent, delay: number) {
		if (agent.current || agent.seeking) return;
		agent.seeking = true;
		this.schedule(delay, () => {
			agent.seeking = false;
			this.look(agent);
		});
	}

	private look(agent: Agent) {
		if (agent.current || agent.seeking) return;
		const reach = agent.reach;
		const reached = reach && this.plan.backlog.find((item) => item.change === reach.item);
		if (reach && reached) {
			delete agent.reach;
			this.reachFor(agent, reached, reach.fate, reach.afterSeconds * SECOND);
			return;
		}
		const own = agent.goals.find((goal) => this.available(goal));
		if (own) {
			agent.goals = agent.goals.filter((goal) => goal !== own);
			// A hosted builder starts when someone asks GitHive to build: that's its event, before its claim.
			if (own.requestedBy && !this.announced.has(own.change)) {
				this.announced.add(own.change);
				this.emit({ kind: "building", agent: own.requestedBy, detail: own.intent });
			}
			this.reachFor(agent, own, undefined, this.rand.between(3 * SECOND, 15 * SECOND));
			return;
		}
		const free = agent.hosted ? [] : this.freeItems(agent);
		if (free.length) {
			// Each agent sees the free items in an order of its own, so a crowd spreads out; some take the top one anyway.
			const item = this.rand.chance(this.plan.crowd) ? free[0]! : free[spread(agent.name, free.length)]!;
			this.reachFor(agent, item, undefined, this.rand.between(3 * SECOND, 15 * SECOND));
			return;
		}
		// Nothing to take now. It looks again when something frees up, or comes back for a later goal.
		const back = agent.goals
			.map((goal) => this.start + (goal.notBefore ?? 0) * MINUTE)
			.filter((at) => at > this.now)
			.sort((a, b) => a - b)[0];
		if (back !== undefined) this.lookSoon(agent, back - this.now + this.rand.between(0, 20 * SECOND));
	}

	/** The agent decides on `goal` now; its claim reaches the server after `delay`, by when another may have it. */
	private reachFor(agent: Agent, goal: GoalPlan, fate: Fate | undefined, delay: number) {
		agent.seeking = true;
		this.schedule(delay, () => {
			agent.seeking = false;
			this.tryClaim(agent, goal, fate);
		});
	}

	private tryClaim(agent: Agent, goal: GoalPlan, fate: Fate | undefined) {
		const item = this.plan.backlog.some((planned) => planned.change === goal.change);
		const blocked =
			this.open.has(goal.change) ||
			this.merged.has(goal.change) ||
			this.overlapsOpen(goal.paths) ||
			(item && !this.dependenciesMerged(goal as BacklogPlan));
		if (blocked) {
			// Refused, naming the holder. The server records no event for it; the agent picks other work.
			this.refused.push({ agent: agent.name, change: goal.change, at: this.now });
			if (!item) agent.goals.unshift(goal);
			this.lookSoon(agent, this.rand.between(5 * SECOND, 25 * SECOND));
			return;
		}
		this.claim(agent, goal, fate ?? goal.fate ?? {}, item);
	}

	private claim(agent: Agent, goal: GoalPlan, fate: Fate, item: boolean) {
		const change: Change = {
			id: goal.change,
			agent,
			goal,
			fate,
			item,
			paths: [...goal.paths],
			since: this.now,
			active: this.now,
			head: null,
			heads: [],
			rejections: [...(fate.rejections ?? [])],
			drawn: !!fate.clean || !!fate.rejections?.length,
			failsLeft: fate.failsChecks ? 1 : 0,
			failDrawn: !!fate.clean || !!fate.failsChecks,
			asked: false,
			toldHeadsUp: false,
			epoch: 0,
			sentBack: 0,
			pending: new Set(),
			wantsToLand: false,
			inBatch: false,
			open: true,
		};
		this.open.set(change.id, change);
		this.claims.push(change);
		agent.current = change;
		this.emit({ kind: "claimed", agent: agent.name, change: change.id, detail: goal.intent });
		const { widens, releases } = fate;
		const build =
			goal.buildMinutes !== undefined
				? goal.buildMinutes * MINUTE + this.rand.between(-10 * SECOND, 10 * SECOND)
				: this.rand.between(this.plan.build[0] * MINUTE, this.plan.build[1] * MINUTE);
		// An agent that's going to give up does so while it's still building.
		const pushAt = releases ? Math.max(build, (releases.afterMinutes + 1) * MINUTE) : build;
		this.later(change, pushAt, () => this.push(change));
		if (widens) this.schedule(widens.afterMinutes * MINUTE, () => this.widen(change, widens.paths));
		if (releases) this.schedule(releases.afterMinutes * MINUTE, () => this.release(change, releases.why));
	}

	/** Claiming more paths for the same change: another claimed event, and the claim is active again. */
	private widen(change: Change, paths: string[]) {
		if (!change.open) return;
		const more = paths.filter((path) => !change.paths.includes(path));
		// A claim on paths another change holds is refused, silently as ever.
		if (!more.length || this.overlapsOpen(more, change)) return;
		change.paths.push(...more);
		change.active = this.now;
		this.emit({ kind: "claimed", agent: change.agent.name, change: change.id, detail: change.goal.intent });
	}

	private release(change: Change, why: string) {
		if (!change.open || change.inBatch) return;
		this.emit({ kind: "released", agent: change.agent.name, change: change.id, detail: why });
		// Its backlog item is free again, for anyone but the agent that gave it up.
		if (change.item) change.agent.dropped.add(change.id);
		this.close(change, this.rand.between(30 * SECOND, 90 * SECOND));
	}

	/** The claim is gone (landed or released): its agent looks for more, and so does anyone waiting for room. */
	private close(change: Change, lookAfter: number) {
		change.open = false;
		this.open.delete(change.id);
		this.claims = this.claims.filter((other) => other !== change);
		change.agent.current = null;
		this.lookSoon(change.agent, lookAfter);
		for (const agent of this.agents)
			if (agent.arrived && !agent.current && !agent.seeking && this.canWork(agent))
				this.lookSoon(agent, this.rand.between(10 * SECOND, 60 * SECOND));
	}

	private available(goal: GoalPlan) {
		const due = goal.notBefore === undefined || this.start + goal.notBefore * MINUTE <= this.now;
		return due && !this.overlapsOpen(goal.paths);
	}

	private canWork(agent: Agent) {
		return (
			!!agent.reach ||
			agent.goals.some((goal) => this.available(goal)) ||
			(!agent.hosted && this.freeItems(agent).length > 0)
		);
	}

	/** Backlog items free to take: unclaimed, clear of claims in force, and with what they wait for merged. */
	private freeItems(agent: Agent) {
		return this.plan.backlog.filter(
			(item) =>
				!this.open.has(item.change) &&
				!this.merged.has(item.change) &&
				!agent.dropped.has(item.change) &&
				!this.overlapsOpen(item.paths) &&
				this.dependenciesMerged(item),
		);
	}

	private dependenciesMerged(item: BacklogPlan) {
		return (item.after ?? []).every((dependency) => this.merged.has(dependency));
	}

	private overlapsOpen(paths: string[], except?: Change) {
		return this.claims.some(
			(change) => change !== except && change.paths.some((held) => paths.some((path) => overlap(path, held))),
		);
	}

	// Building and review.

	private push(change: Change) {
		const head = this.rand.sha();
		change.head = head;
		change.heads.push(head);
		change.epoch++;
		change.pending.clear();
		change.wantsToLand = false;
		// A push names only its change: the claim says whose it is.
		this.emit({ kind: "pushed", change: change.id, commit: head });
		const headsUp = change.fate.headsUp;
		const other = headsUp && this.open.get(headsUp.change);
		if (headsUp && other && !change.toldHeadsUp) {
			change.toldHeadsUp = true;
			this.emit({
				kind: "heads_up",
				agent: change.agent.name,
				change: change.id,
				other: other.agent.name,
				detail: headsUp.names,
			});
		}
		const asks = change.fate.asks;
		if (asks && !change.asked) this.later(change, this.rand.between(20 * SECOND, 60 * SECOND), () => this.ask(change));
		this.later(change, this.rand.between(MINUTE, 3 * MINUTE), () => this.review(change));
		for (const role of this.policyFor(change.paths).vetoes) {
			if (this.grantsOf(role).includes("githive"))
				this.later(change, this.rand.between(1.5 * MINUTE, 4 * MINUTE), () => this.roleReview(change, role));
			else if (this.peopleOnly(role)) this.later(change, ROLE_WAIT_MS, () => this.flagWaitingRole(change, role));
		}
	}

	private review(change: Change) {
		const head = change.head!;
		const reviewer = this.reviewerFor(change);
		let verdict: "approve" | "reject" = "approve";
		let evidence = "";
		const scripted = change.rejections.shift();
		if (scripted !== undefined) {
			verdict = "reject";
			evidence = scripted;
		} else if (!change.drawn && !this.approvalOf(change).approved) {
			change.drawn = true;
			if (this.rand.chance(this.plan.rejectRate)) {
				verdict = "reject";
				evidence = this.plan.voices.reject(change.goal, this.rand);
			}
		}
		if (verdict === "approve") evidence = change.fate.approval ?? this.plan.voices.approve(change.goal, this.rand);
		this.cast({ commit: head, reviewer: reviewer.name, role: REVIEW_ROLE, verdict, evidence, by: reviewer.by });
		// A vote names only its commit: the claim whose head it is says which change.
		this.emit({ kind: "voted", agent: reviewer.name, commit: head, verdict, detail: REVIEW_ROLE });
		this.afterVote(change);
	}

	/** A different agent, never the author nor another of its person's agents; a hosted builder's goes to GitHive's. */
	private reviewerFor(change: Change): { name: string; by: string } {
		const hosted = { name: `githive-${REVIEW_ROLE}`, by: `service:githive-reviewer:${REVIEW_ROLE}` };
		if (change.agent.hosted) return hosted;
		const candidates = this.agents.filter(
			(agent) => agent.arrived && !agent.hosted && agent.owner !== change.agent.owner,
		);
		if (!candidates.length) return hosted;
		const fewest = Math.min(...candidates.map((agent) => agent.reviews));
		const reviewer = this.rand.pick(candidates.filter((agent) => agent.reviews <= fewest + 1));
		reviewer.reviews++;
		return { name: reviewer.name, by: reviewer.by };
	}

	/** GitHive's own reviewer for a blocking role it holds. */
	private roleReview(change: Change, role: string) {
		const head = change.head!;
		const reviewer = `githive-${role}`;
		const evidence = this.plan.voices.security(change.goal, this.rand);
		this.cast({ commit: head, reviewer, role, verdict: "approve", evidence, by: `service:githive-reviewer:${role}` });
		this.emit({ kind: "voted", agent: reviewer, commit: head, verdict: "approve", detail: role });
		this.afterVote(change);
	}

	/** What the change's agent does once a vote is in: fix what was rejected, or ask to land once approved. */
	private afterVote(change: Change) {
		if (!change.open) return;
		const approval = this.approvalOf(change);
		if (this.sentBack(change) || approval.vetoedBy.length) {
			if (change.pending.has("fix")) return;
			change.pending.add("fix");
			// Like GitHive's hosted builders, an agent sent back too many times gives the change up.
			if (++change.sentBack >= MOST_SENT_BACK)
				this.later(change, this.rand.between(MINUTE, 3 * MINUTE), () =>
					this.release(change, `Sent back ${MOST_SENT_BACK} times; giving it up for someone to look at afresh.`),
				);
			else this.later(change, this.rand.between(MINUTE, 4 * MINUTE), () => this.push(change));
			return;
		}
		if (change.attention || !approval.approved || change.wantsToLand || change.pending.has("land")) return;
		change.pending.add("land");
		this.later(change, this.rand.between(10 * SECOND, 40 * SECOND), () => this.askToLand(change));
	}

	private ask(change: Change) {
		const asks = change.fate.asks;
		if (!asks || change.asked) return;
		change.asked = true;
		change.attention = { reason: asks.question, agent: change.agent.name, at: this.now };
		this.emit({ kind: "asked", agent: change.agent.name, change: change.id, detail: asks.question });
	}

	/**
	 * A review only people may give has waited unheld: GitHive flags it for them. The flag is a question for a person
	 * like an agent's, from "githive", and records no event.
	 */
	private flagWaitingRole(change: Change, role: string) {
		if (change.attention || this.sentBack(change) || !this.approvalOf(change).awaiting?.includes(role)) return;
		const holders = this.grantsOf(role).join(", ");
		const minutes = Math.round(ROLE_WAIT_MS / MINUTE);
		change.attention = {
			reason:
				`${change.id}'s ${role} review has waited ${minutes} minutes and none of its holders (${holders}) has ` +
				`taken it. You can review it as ${role} from the dashboard.`,
			agent: "githive",
			at: this.now,
		};
	}

	personVotes(change: string, verdict: "approve" | "reject") {
		const waiting = this.open.get(change);
		if (!waiting?.head || !this.waitsOnPerson(waiting)) return;
		const approval = this.approvalOf(waiting);
		const role = approval.awaiting?.find((awaited) => this.peopleHold(awaited)) ?? REVIEW_ROLE;
		const asks = waiting.attention?.agent === waiting.agent.name ? waiting.fate.asks : undefined;
		const evidence =
			asks && role === REVIEW_ROLE
				? verdict === "approve"
					? asks.yes
					: asks.no
				: this.plan.voices.person(role, verdict);
		// A person's vote from the dashboard records no event; it answers any question open on the change.
		this.cast({ commit: waiting.head, reviewer: PERSON, role, verdict, evidence, by: PERSON });
		delete waiting.attention;
		this.afterVote(waiting);
		this.changed();
	}

	needsPerson() {
		return this.claims.filter((change) => this.waitsOnPerson(change)).map((change) => change.id);
	}

	private waitsOnPerson(change: Change) {
		if (change.attention) return true;
		if (!change.head || this.sentBack(change)) return false;
		return !!this.approvalOf(change).awaiting?.some((role) => this.peopleOnly(role));
	}

	private cast(vote: Omit<Cast, "at">) {
		this.casts.push({ ...vote, at: this.now });
	}

	// Landing: approved changes that asked to land are checked together, then land as a set.

	private askToLand(change: Change) {
		if (change.attention || this.sentBack(change) || !this.approvalOf(change).approved) return;
		change.wantsToLand = true;
		this.emit({ kind: "merging", agent: change.agent.name, change: change.id });
		this.requestBatch(this.rand.between(5 * SECOND, 20 * SECOND));
	}

	private requestBatch(delay: number) {
		if (this.checking || this.batchSoon) return;
		this.batchSoon = true;
		this.schedule(delay, () => {
			this.batchSoon = false;
			this.startBatch();
		});
	}

	private startBatch() {
		if (this.checking) return;
		const ready = this.claims
			.filter(
				(change) =>
					change.wantsToLand &&
					!change.inBatch &&
					!change.attention &&
					!this.sentBack(change) &&
					this.approvalOf(change).approved,
			)
			.slice(0, BATCH_MOST);
		if (!ready.length) return;
		for (const change of ready) {
			change.inBatch = true;
			if (!change.failDrawn) {
				change.failDrawn = true;
				if (this.rand.chance(this.plan.failRate)) change.failsLeft = 1;
			}
		}
		const failing = ready.filter((change) => change.failsLeft > 0);
		this.checking = this.batchOf(ready);
		this.schedule(this.rand.between(MINUTE, 2 * MINUTE), () => this.finishBatch(ready, failing));
	}

	private batchOf(changes: Change[]): RepoLanding["checking"] {
		return {
			base: this.main,
			since: iso(this.now),
			changes: changes.map((change) => ({ change: change.id, head: change.head!, agent: change.agent.name })),
		};
	}

	private finishBatch(batch: Change[], failing: Change[]) {
		const passing = batch.filter((change) => !failing.includes(change));
		if (failing.length && passing.length) {
			// The batch failed. It's split: the part that passes lands at once, and the change at fault is checked
			// alone, twice, before it's put out.
			this.land(passing);
			this.checking = this.batchOf(failing);
			this.schedule(this.rand.between(40 * SECOND, 80 * SECOND), () => {
				this.putOut(failing);
				this.checking = null;
				this.nextBatch();
			});
			return;
		}
		if (failing.length) this.putOut(failing);
		else this.land(batch);
		this.checking = null;
		this.nextBatch();
	}

	private nextBatch() {
		if (this.claims.some((change) => change.wantsToLand && !change.inBatch))
			this.requestBatch(this.rand.between(3 * SECOND, 10 * SECOND));
	}

	private land(changes: Change[]) {
		for (const change of changes) {
			const commit = this.rand.sha();
			this.main = commit;
			this.emit({ kind: "landed", agent: change.agent.name, change: change.id, commit });
			this.settle({
				change: change.id,
				head: change.head!,
				agent: change.agent.name,
				how: "landed",
				at: iso(this.now),
				commit,
			});
			this.merged.add(change.id);
			for (const file of change.goal.creates ?? []) if (!this.files.includes(file)) this.files.push(file);
			this.close(change, this.rand.between(20 * SECOND, 90 * SECOND));
		}
		this.files.sort();
		this.backlog = this.backlog.filter((item) => !this.merged.has(item.id));
		this.treeView = undefined;
		this.backlogView = undefined;
	}

	/**
	 * A change whose checks failed goes back to its agent: a `failed` event, an outcome with the reason, and a rejection
	 * of its head by the checks. The rejection records no event, and since "checks" isn't a blocking role, the claim's
	 * approval still says approved until its agent pushes again (as the server's does).
	 */
	private putOut(changes: Change[]) {
		for (const change of changes) {
			const head = change.head!;
			const reason = `checks failed: ${this.plan.verify[0] ?? "npm test"} exited 1`;
			const output = change.fate.failsChecks ?? this.plan.voices.checksOutput(change.goal, this.rand);
			this.emit({ kind: "failed", agent: change.agent.name, change: change.id, commit: head, detail: reason });
			this.settle({
				change: change.id,
				head,
				agent: change.agent.name,
				how: "failed",
				at: iso(this.now),
				reasons: [reason],
			});
			change.failsLeft--;
			change.inBatch = false;
			change.wantsToLand = false;
			this.cast({
				commit: head,
				reviewer: CHECKS_REVIEWER,
				role: "checks",
				verdict: "reject",
				evidence: `${reason} on ${head.slice(0, 8)}, checked alone on the branch, twice:\n${output}`,
			});
			this.afterVote(change);
		}
	}

	private settle(outcome: Outcome) {
		this.recent = [...this.recent, outcome].slice(-RECENT_KEPT);
		const continues = this.stretch && this.now - this.stretch.to <= STRETCH_GAP_MS;
		const base: Stretch = continues
			? this.stretch!
			: { landed: 0, failed: 0, agents: [], from: this.now, to: this.now };
		this.stretch = {
			landed: base.landed + (outcome.how === "landed" ? 1 : 0),
			failed: base.failed + (outcome.how === "failed" ? 1 : 0),
			agents: base.agents.includes(outcome.agent) ? base.agents : [...base.agents, outcome.agent],
			from: base.from,
			to: Math.max(base.to, this.now),
		};
	}

	// The policy, worked out as the server's votes.ts does.

	private policyFor(paths: string[]) {
		let { required, vetoes } = this.plan.policy;
		for (const escalation of this.plan.policy.escalate ?? []) {
			if (!paths.some((path) => escalation.paths.some((entry) => overlap(path, entry)))) continue;
			required = Math.max(required, escalation.required ?? required);
			vetoes = [...new Set([...vetoes, ...(escalation.vetoes ?? [])])];
		}
		return { required, vetoes };
	}

	private grantsOf(role: string) {
		return this.plan.policy.grants?.[role] ?? DEFAULT_GRANT;
	}

	private peopleHold(role: string) {
		return this.grantsOf(role).some((grant) => grant.startsWith("person:"));
	}

	private peopleOnly(role: string) {
		return this.grantsOf(role).every((grant) => grant.startsWith("person:"));
	}

	private holdsRole(role: string, vote: Cast) {
		return this.grantsOf(role).some((grant) => {
			if (grant === "person:*") return !!vote.by && /^person:[^/]+$/.test(vote.by);
			if (grant === "githive")
				return vote.by ? vote.by === `service:githive-reviewer:${role}` : vote.reviewer === `githive-${role}`;
			if (/^(person|service):/.test(grant)) return vote.by === grant;
			return vote.reviewer === grant;
		});
	}

	/** Each identity's latest vote on the change's head. */
	private votesOnHead(change: Change) {
		const latest = new Map<string, Cast>();
		for (const vote of this.casts)
			if (vote.commit === change.head) latest.set(vote.by ?? `name:${vote.reviewer}`, vote);
		return [...latest.values()];
	}

	private isAuthor(change: Change, vote: Cast) {
		return vote.reviewer === change.agent.name || (!!vote.by && vote.by === change.agent.by);
	}

	/** Its head was rejected by someone other than its author: the checks, a reviewer or a person. */
	private sentBack(change: Change) {
		return this.votesOnHead(change).some((vote) => vote.verdict === "reject" && !this.isAuthor(change, vote));
	}

	private approvalOf(change: Change): Claim["approval"] {
		const { required, vetoes } = this.policyFor(change.paths);
		if (!change.head) return { approved: false, approvals: 0, required, vetoedBy: [], awaiting: [...vetoes] };
		const verdicts = this.votesOnHead(change);
		const approving = verdicts.filter((vote) => vote.verdict === "approve" && !this.isAuthor(change, vote));
		const approvals = new Set(approving.map((vote) => vote.by ?? `name:${vote.reviewer}`)).size;
		const asRole = (vote: Cast) => vetoes.includes(vote.role) && this.holdsRole(vote.role, vote);
		const vetoedBy = verdicts.filter((vote) => vote.verdict === "reject" && asRole(vote)).map((vote) => vote.reviewer);
		const awaiting = vetoes.filter((role) => !approving.some((vote) => vote.role === role && asRole(vote)));
		return {
			approved: approvals >= required && !vetoedBy.length && !awaiting.length,
			approvals,
			required,
			vetoedBy,
			awaiting,
		};
	}

	// The API's shapes.

	private snapshotNow(): RepoSnapshot {
		const heads = new Set(this.claims.flatMap((change) => change.heads));
		const policy = this.plan.policy;
		return {
			repo: this.plan.repo,
			policy: {
				required: policy.required,
				vetoes: [...policy.vetoes],
				...(policy.escalate ? { escalate: policy.escalate.map((rule) => ({ ...rule, paths: [...rule.paths] })) } : {}),
				...(policy.grants
					? { grants: Object.fromEntries(Object.entries(policy.grants).map(([k, v]) => [k, [...v]])) }
					: {}),
			},
			verify: [...this.plan.verify],
			branch: "main",
			verified: true,
			claims: this.claims.map((change) => this.claimNow(change)),
			votes: this.casts
				.filter((vote) => heads.has(vote.commit))
				.reverse()
				.map((vote): Vote => ({
					commit: vote.commit,
					reviewer: vote.reviewer,
					role: vote.role,
					verdict: vote.verdict,
					evidence: vote.evidence,
					at: iso(vote.at),
					...(vote.by ? { by: vote.by } : {}),
				})),
		};
	}

	private claimNow(change: Change): Claim {
		const approval = this.approvalOf(change);
		const onHead = change.head ? this.votesOnHead(change).filter((vote) => !this.isAuthor(change, vote)) : [];
		const lease = leaseFor({
			active: iso(change.active),
			head: change.head,
			votes: onHead.map((vote) => ({ verdict: vote.verdict, at: iso(vote.at) })),
			approved: approval.approved,
			vetoed: approval.vetoedBy.length > 0,
			landing: change.inBatch,
			asked: !!change.attention,
		});
		return {
			change: change.id,
			agent: change.agent.name,
			paths: [...change.paths],
			intent: change.goal.intent,
			since: iso(change.since),
			active: iso(change.active),
			by: change.agent.by,
			head: change.head,
			approval,
			...(change.attention ? { attention: { ...change.attention, at: iso(change.attention.at) } } : {}),
			lease,
		};
	}

	private landingNow(): RepoLanding {
		const stretch = this.stretch;
		return {
			branch: "main",
			...(stretch
				? {
						stretch: {
							landed: stretch.landed,
							failed: stretch.failed,
							agents: stretch.agents.length,
							from: iso(stretch.from),
							to: iso(stretch.to),
						},
					}
				: {}),
			checking: this.checking
				? { ...this.checking, changes: this.checking.changes.map((change) => ({ ...change })) }
				: null,
			recent: this.recent.map((outcome) => ({
				...outcome,
				...(outcome.reasons ? { reasons: [...outcome.reasons] } : {}),
			})),
		};
	}
}
