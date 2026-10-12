import { DurableObject } from "cloudflare:workers";
import { reviewerName } from "./artifacts";
import { statusOf } from "./errors";
import { callTool } from "./toolkit/mcp";
import { changeRepoName, startHostedBuilder, startHostedReviewers, toolContextFor } from "./toolkit/env";
import { hiveAgentNames, hiveIdentity } from "./toolkit/hive-agents";
import { type BacklogView, type ReviewOption, holdKey } from "./toolkit/work";

// GitHive's hosted agents as members of a repo's hive. Each is a Durable Object of its own ("agent:<repo>:<name>")
// running the loop any agent follows, on its own alarm: its own change first (merge it once approved), then a review
// of someone else's change under its own name, then the first free piece of the backlog in its own order. It builds
// with GitHive's hosted builder and reviews with a hosted reviewer that votes as itself, so it reviews external
// agents' work and they review its own. Nothing assigns work. The repo's instance ("hive:<repo>") only starts and
// stops its agents and says what they're doing.

/** How often an agent takes a turn of its loop. */
export const AGENT_TICK_MS = 10_000;

/** A review an agent started that hasn't voted by then is given up, so the agent can go on. */
export const REVIEW_LAPSES_MS = 6 * 60_000;

/**
 * A reviewer that has logged nothing for this long has stalled: its agent gives the review up and frees its hold, so
 * another agent can take it. Each step a reviewer takes (a command, a tool call) is logged within this, by far.
 */
export const REVIEW_STALLS_MS = 3 * 60_000;

/** Turns in a row an agent's loop may fail before it stops. */
const FAILING_MOST = 15;

/** One hosted agent: what it's on now, and what it has done. */
export interface HostedAgentState {
	repo: string;
	name: string;
	/** It takes no new work after this. */
	until: number;
	/** Its own change, while it's in the claims. */
	change?: string;
	/** The review it started, until its reviewer votes. */
	reviewing?: { change: string; head: string; role: string; since: number };
	/** Pieces it has claimed, so it doesn't take one again that its builder gave up on. */
	tried: string[];
	/** Its changes that left the claims: landed, or given up. */
	finished: { piece: string; at: number }[];
	reviewed: number;
	/** Turns in a row that failed. */
	failing: number;
	/** It has stopped: nothing left for it, its time is up, or it was stopped. */
	done: boolean;
}

/** A repo's hosted agents: who they are, until when they take work, and who started them. */
export interface Hive {
	repo: string;
	names: string[];
	startedAt: number;
	until: number;
	by: string;
}

type Call = (name: string, args?: Record<string, unknown>) => Promise<unknown>;

type Reviewing = NonNullable<HostedAgentState["reviewing"]>;

/** Whether an agent's reviewer is still at work, and when it last logged a step. */
interface ReviewerProgress {
	working: boolean;
	lastActive: number;
}

export class HostedAgent extends DurableObject<Env> {
	// A repo's hive.

	/** Starts `count` hosted agents on the repo for `minutes`; an agent already working takes the later end. */
	async start(input: { repo: string; count: number; minutes: number; by: string }) {
		const startedAt = Date.now();
		const until = startedAt + input.minutes * 60_000;
		const names = hiveAgentNames(input.count);
		const hive: Hive = { repo: input.repo, names, startedAt, until, by: input.by };
		await this.ctx.storage.put("hive", hive);
		const begin = (name: string) => this.agentNamed(input.repo, name).work({ repo: input.repo, name, until });
		await Promise.all(names.map(begin));
		return this.status();
	}

	/** Stops every agent of the repo's hive; what they started finishes on its own. */
	async stopAll() {
		const hive = await this.ctx.storage.get<Hive>("hive");
		if (!hive) return null;
		await Promise.all(hive.names.map((name) => this.agentNamed(hive.repo, name).stop()));
		return this.status();
	}

	/** The repo's hive and what each agent is doing, or null if it never had one. */
	async status() {
		const hive = await this.ctx.storage.get<Hive>("hive");
		if (!hive) return null;
		const accounts = await Promise.all(hive.names.map((name) => this.agentNamed(hive.repo, name).account()));
		const agents = accounts.filter((account): account is HostedAgentState => !!account);
		return { ...hive, agents, working: agents.some((agent) => !agent.done) };
	}

	// An agent.

	/** Starts this agent's loop afresh, or gives one already working the new end. */
	async work(input: { repo: string; name: string; until: number }) {
		const kept = await this.ctx.storage.get<HostedAgentState>("agent");
		if (kept && !kept.done) {
			await this.ctx.storage.put("agent", { ...kept, until: Math.max(kept.until, input.until) });
			return;
		}
		// A stopped agent's account was for its last start: what it tried then may be free to try again.
		const fresh: HostedAgentState = {
			repo: input.repo,
			name: input.name,
			until: input.until,
			tried: [],
			finished: [],
			reviewed: 0,
			failing: 0,
			done: false,
		};
		await this.ctx.storage.put("agent", fresh);
		// Agents start together: each reads the backlog in an order of its own, and a claim another took first costs
		// only a turn.
		await this.ctx.storage.setAlarm(Date.now());
	}

	/** What this agent is doing and has done. */
	async account() {
		return (await this.ctx.storage.get<HostedAgentState>("agent")) ?? null;
	}

	/** Stops this agent's loop. */
	async stop() {
		const state = await this.ctx.storage.get<HostedAgentState>("agent");
		if (!state) return;
		await this.ctx.storage.put("agent", { ...state, done: true });
		await this.ctx.storage.deleteAlarm();
	}

	/** A toolkit call as the agent (tests answer them instead). */
	protected callTool(name: string, args: Record<string, unknown>, agent: string): Promise<unknown> {
		return callTool(name, args, toolContextFor(this.env, hiveIdentity(agent), { hosted: true }));
	}

	/** Starts GitHive's hosted builder on the agent's claimed change, which the hive reviews (tests note it instead). */
	protected startBuilder(repo: string, change: string): Promise<unknown> {
		return startHostedBuilder(this.env, { repo, change, hiveReviews: true });
	}

	/** Starts a hosted reviewer that votes as the agent, under its own name (tests note it instead). */
	protected startReviewer(repo: string, offer: ReviewOption, agent: string): Promise<unknown> {
		// It merges as soon as it approves, so an approved change doesn't wait for its author's next turn.
		const review = { repo, change: offer.change, roles: [offer.role], reviewer: agent, mergeWhenApproved: true };
		return startHostedReviewers(this.env, review);
	}

	/** The agent's reviewer: whether it's still at work, and when it last logged a step (tests answer it instead). */
	protected async reviewerProgress(repo: string, reviewing: Reviewing, agent: string): Promise<ReviewerProgress> {
		const reviewer = await this.reviewerOf(repo, reviewing, agent).state();
		if (!reviewer) return { working: false, lastActive: reviewing.since };
		const working = reviewer.status === "queued" || reviewer.status === "working";
		const lastLogged = reviewer.log.at(-1)?.at;
		return { working, lastActive: lastLogged ? Date.parse(lastLogged) : reviewing.since };
	}

	/** Gives up the agent's review: stops its reviewer, if it still can, and frees its hold for another agent. */
	protected async giveUpReview(repo: string, reviewing: Reviewing, agent: string) {
		await this.reviewerOf(repo, reviewing, agent)
			.cancel("its agent gave the review up")
			.catch(() => undefined);
		const ctx = toolContextFor(this.env, hiveIdentity(agent), { hosted: true });
		await ctx.reviews?.release(repo, holdKey(reviewing.head, reviewing.role), agent, true);
	}

	private reviewerOf(repo: string, reviewing: Reviewing, agent: string) {
		const name = reviewerName(changeRepoName(repo, reviewing.change), `${reviewing.role}:${agent}`, reviewing.head);
		return this.env.REVIEWER.getByName(name);
	}

	/** The instance for one of a repo's agents (tests stand in for it). */
	protected agentNamed(repo: string, name: string): Pick<HostedAgent, "work" | "account" | "stop"> {
		return this.env.HOSTED_AGENT.getByName(`agent:${repo}:${name}`);
	}

	async alarm() {
		const state = await this.ctx.storage.get<HostedAgentState>("agent");
		if (!state || state.done) return;
		try {
			await this.step(state);
			state.failing = 0;
		} catch (err) {
			state.failing++;
			console.error(`${state.name} on ${state.repo}: a turn failed (${state.failing} in a row)`, statusOf(err).message);
			if (state.failing >= FAILING_MOST) state.done = true;
		}
		// A stop can arrive while the turn waits on the toolkit; the turn mustn't write over it.
		const stopped = (await this.ctx.storage.get<HostedAgentState>("agent"))?.done;
		if (stopped) state.done = true;
		await this.ctx.storage.put("agent", state);
		if (!state.done) await this.ctx.storage.setAlarm(Date.now() + AGENT_TICK_MS);
	}

	/** Its own change first, then a review of another's, then the backlog; it stops when nothing's left for it. */
	private async step(state: HostedAgentState) {
		const call: Call = (name, args = {}) =>
			this.callTool(name, { repo: state.repo, agent: state.name, ...args }, state.name);
		const now = Date.now();
		if (state.change) await this.ownChange(state, call, now);
		if (state.reviewing && (await this.reviewOver(state, now))) delete state.reviewing;
		const takesWork = now < state.until;
		if (!state.reviewing && takesWork) await this.review(state, call, now);
		const backlog = (await call("backlog")) as BacklogView;
		if (!state.change && !state.reviewing && takesWork) await this.takePiece(state, backlog, call);
		const idle = !state.change && !state.reviewing;
		const nothingLeft = backlog.open.length + backlog.waiting.length === 0;
		if (idle && (nothingLeft || !takesWork)) state.done = true;
	}

	/** Its own change: done once it's out of the claims; merged once approved (merge waits for its batch). */
	private async ownChange(state: HostedAgentState, call: Call, now: number) {
		const change = state.change!;
		const status = (await call("status", { change })) as { claim?: unknown; approval?: { approved?: boolean } };
		if (!status.claim) {
			state.finished.push({ piece: change, at: now });
			delete state.change;
			return;
		}
		if (status.approval?.approved) await call("merge", { change });
	}

	/** A review is over once its reviewer has voted or failed, or once it has taken too long. */
	/**
	 * A review is over once its reviewer has voted or failed. One that lapsed, or whose reviewer stalled, is given up,
	 * so another agent can take it instead of waiting out the hold.
	 */
	private async reviewOver(state: HostedAgentState, now: number) {
		const reviewing = state.reviewing!;
		const progress = await this.reviewerProgress(state.repo, reviewing, state.name);
		if (!progress.working) return true;
		const lapsed = now - reviewing.since > REVIEW_LAPSES_MS;
		const stalled = now - progress.lastActive > REVIEW_STALLS_MS;
		const givesUp = lapsed || stalled;
		if (!givesUp) return false;
		console.error(
			`${state.name}: gave up reviewing ${reviewing.change}, its reviewer ${lapsed ? "lapsed" : "stalled"}`,
		);
		await this.giveUpReview(state.repo, reviewing, state.name);
		return true;
	}

	/** Takes the first review offered it that no other agent has taken meanwhile, under its own name. */
	private async review(state: HostedAgentState, call: Call, now: number) {
		const { reviews } = (await call("reviews")) as { reviews: ReviewOption[] };
		for (const offer of reviews) {
			// Taking the change's credentials marks the review as this agent's, so others go elsewhere.
			const taken = await call("credentials", { change: offer.change, role: offer.role }).then(
				() => true,
				(err) => {
					if (statusOf(err).status === 409) return false;
					throw err;
				},
			);
			if (!taken) continue;
			const started = (await this.startReviewer(state.repo, offer, state.name)) as { head?: string } | undefined;
			// The reviewer is kept under the commit it fetched, which is newer than the offer's after another push.
			const head = started?.head ?? offer.head;
			state.reviewing = { change: offer.change, head, role: offer.role, since: now };
			state.reviewed++;
			return;
		}
	}

	/** Claims the first free piece it hasn't tried and starts a builder on it; a refused claim waits a turn. */
	private async takePiece(state: HostedAgentState, backlog: BacklogView, call: Call) {
		const piece = backlog.open.find((open) => !state.tried.includes(open.id));
		if (!piece) return;
		const intent = piece.intent ? `${piece.title}\n\n${piece.intent}` : piece.title;
		const after = piece.landsAfter ?? [];
		const claim = { change: piece.id, paths: piece.paths ?? [], intent, ...(after.length ? { after } : {}) };
		// Another agent may have claimed it since the backlog was read: then it tries again next turn.
		const claimed = (await call("claim", claim).catch((err) => {
			if (statusOf(err).status === 409) return { ok: false };
			throw err;
		})) as { ok?: boolean };
		if (claimed.ok === false) return;
		state.tried.push(piece.id);
		try {
			await this.startBuilder(state.repo, piece.id);
			state.change = piece.id;
		} catch (err) {
			// No builder means nobody would push to the claim: give it up, so the piece is free again.
			console.error(`${state.name}: starting a builder on ${piece.id} failed`, statusOf(err).message);
			await call("release", { change: piece.id, reason: "its builder didn't start" }).catch(() => undefined);
		}
	}
}
