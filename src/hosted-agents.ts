import { DurableObject } from "cloudflare:workers";
import { reviewerName } from "./artifacts";
import { statusOf } from "./errors";
import type { Conversation } from "./sandbox";
import { callTool } from "./toolkit/mcp";
import { changeRepoName, startHostedBuilder, startHostedReviewers, toolContextFor } from "./toolkit/env";
import { hiveAgentNames, hiveIdentity } from "./toolkit/hive-agents";
import { type BacklogView, type ReviewOption, holdKey } from "./toolkit/work";

// GitHive's hosted agents as members of a repo's hive. Each is a Durable Object of its own ("agent:<repo>:<name>")
// running the loop any agent follows, on its own alarm: its own change first (merge it once approved), then a review
// of someone else's change under its own name, then the first free piece of the backlog in its own order. It builds
// with GitHive's hosted builder and reviews with a hosted reviewer that votes as itself, so it reviews external
// agents' work and they review its own. Nothing assigns work. The repo's instance ("hive:<repo>") only starts and
// stops its agents, says what they're doing, and passes on rings.
//
// An agent takes a turn when it's rung: the repo's RepoCache rings the hive whenever a tool writes, a batch lands or
// a push arrives, and the agent then reads and chooses as always. A ring says only that something changed, never what
// to do. Rings are hints, so a slow turn of its own notices what rings nothing, such as a review hold running out.

/** The longest an agent goes between turns when nothing rings it. */
export const AGENT_FALLBACK_MS = 2 * 60_000;
/** The soonest an agent takes another turn after its last began, however often it's rung. */
export const AGENT_TURN_GAP_MS = 5_000;

const TURN_BEGAN = "turn-began";
const RUNG_AT = "rung-at";

// What rings as a tool wrote it, a batch landed or a push arrived (see RepoCache.ringHive) that can't end an agent's
// wait on its own change or its review: an agent busy with both skips them.
const NEW_WORK_ONLY = new Set(["claim", "add_work", "build", "pushed", "settings", "ask_human"]);

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
	/** The latest changes its reviewer rejected, so it reviews their revisions first, checking its own findings. */
	rejected?: Rejected[];
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

/** A change an agent's reviewer rejected: the commit, and the findings it gave. */
interface Rejected {
	change: string;
	head: string;
	findings: string;
	/** Its reviewer's conversation with the model, for the recheck to continue. */
	conversation?: Conversation;
}

/** How many rejected changes an agent remembers. */
const REJECTED_KEPT = 10;

/** What the agent's reviewer came to: whether it's over, and its findings if it rejected. */
interface ReviewerResult {
	over: boolean;
	rejected?: string;
	conversation?: Conversation;
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
		await this.listenToRepo(input.repo);
		return this.status();
	}

	/** Rings each of the repo's agents (see ring). Returns whether any of them is still running. */
	async ringAgents(reason: string) {
		const hive = await this.ctx.storage.get<Hive>("hive");
		if (!hive) return false;
		const ring = (name: string) =>
			this.agentNamed(hive.repo, name)
				.ring(reason)
				.catch(() => true);
		const running = await Promise.all(hive.names.map(ring));
		return running.some(Boolean);
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

	/**
	 * Something changed in the repo (`reason`: the tool that wrote, "landed" or "pushed"): the agent takes a turn soon,
	 * at most one per AGENT_TURN_GAP_MS. A stopped agent stays stopped. Returns whether the agent is still running.
	 */
	async ring(reason: string) {
		const state = await this.ctx.storage.get<HostedAgentState>("agent");
		if (!state || state.done) return false;
		if (state.change && state.reviewing && NEW_WORK_ONLY.has(reason)) return true;
		const now = Date.now();
		await this.ctx.storage.put(RUNG_AT, now);
		const began = (await this.ctx.storage.get<number>(TURN_BEGAN)) ?? 0;
		const turnAt = Math.max(now, began + AGENT_TURN_GAP_MS);
		const set = await this.ctx.storage.getAlarm();
		if (set === null || set > turnAt) await this.ctx.storage.setAlarm(turnAt);
		return true;
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
	protected startReviewer(repo: string, offer: ReviewOption, agent: string, earlier?: Rejected): Promise<unknown> {
		// It merges as soon as it approves, so an approved change doesn't wait for its author's next turn.
		const review = { repo, change: offer.change, roles: [offer.role], reviewer: agent, mergeWhenApproved: true };
		const recheck = earlier ? { earlier } : {};
		return startHostedReviewers(this.env, { ...review, ...recheck });
	}

	/** Whether the agent's reviewer has voted or failed, and its findings if it rejected (tests answer it instead). */
	protected async reviewerResult(repo: string, reviewing: Reviewing, agent: string): Promise<ReviewerResult> {
		const name = reviewerName(changeRepoName(repo, reviewing.change), `${reviewing.role}:${agent}`, reviewing.head);
		const stub = this.env.REVIEWER.getByName(name);
		const reviewer = await stub.state();
		const over = reviewer?.status === "done" || reviewer?.status === "failed";
		const rejected = reviewer?.verdict === "reject" ? reviewer.evidence : undefined;
		if (!rejected) return { over };
		const conversation = (await stub.conversation().catch(() => null)) ?? undefined;
		return conversation ? { over, rejected, conversation } : { over, rejected };
	}

	/** Whether the agent still holds its review, which it gave back or which ran out (tests answer it instead). */
	protected async stillHolds(repo: string, reviewing: Reviewing, agent: string) {
		const ctx = toolContextFor(this.env, hiveIdentity(agent), { hosted: true });
		const held = await ctx.reviews?.held(repo, [reviewing.head]);
		return held?.[holdKey(reviewing.head, reviewing.role)]?.includes(agent) ?? false;
	}

	/** The instance for one of a repo's agents (tests stand in for it). */
	protected agentNamed(repo: string, name: string): Pick<HostedAgent, "work" | "account" | "stop" | "ring"> {
		return this.env.HOSTED_AGENT.getByName(`agent:${repo}:${name}`);
	}

	/** Asks the repo's RepoCache to ring this hive when something changes (tests note it instead). */
	protected async listenToRepo(repo: string) {
		await this.env.REPO_CACHE?.getByName(`repo:${repo}`).hiveListens(repo);
	}

	async alarm() {
		const state = await this.ctx.storage.get<HostedAgentState>("agent");
		if (!state || state.done) return;
		const began = Date.now();
		await this.ctx.storage.put(TURN_BEGAN, began);
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
		if (!state.done) await this.ctx.storage.setAlarm(await this.nextTurnAt(began));
	}

	// A ring during the turn may be about something its reads came too early to see, so it brings the next turn
	// forward; otherwise the agent waits to be rung.
	private async nextTurnAt(began: number) {
		const rung = (await this.ctx.storage.get<number>(RUNG_AT)) ?? 0;
		if (rung >= began) return Math.max(Date.now(), began + AGENT_TURN_GAP_MS);
		return Date.now() + AGENT_FALLBACK_MS;
	}

	/** Its own change first, then a review of another's, then the backlog; it stops when nothing's left for it. */
	private async step(state: HostedAgentState) {
		const call: Call = (name, args = {}) =>
			this.callTool(name, { repo: state.repo, agent: state.name, ...args }, state.name);
		const now = Date.now();
		if (state.change) await this.ownChange(state, call, now);
		if (state.reviewing && (await this.reviewOver(state))) delete state.reviewing;
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
	 * A review is over once its reviewer has voted or failed, or once the agent no longer holds it: a reviewer that
	 * fails gives it back, and a hold its agent never votes on runs out, as anyone's does.
	 */
	private async reviewOver(state: HostedAgentState) {
		const reviewing = state.reviewing!;
		const result = await this.reviewerResult(state.repo, reviewing, state.name);
		if (result.rejected) {
			const conversation = result.conversation ? { conversation: result.conversation } : {};
			remember(state, { change: reviewing.change, head: reviewing.head, findings: result.rejected, ...conversation });
		}
		if (result.over) return true;
		return !(await this.stillHolds(state.repo, reviewing, state.name));
	}

	/** Takes the first review offered it that no other agent has taken meanwhile, under its own name. */
	private async review(state: HostedAgentState, call: Call, now: number) {
		const { reviews } = (await call("reviews")) as { reviews: ReviewOption[] };
		// A change it rejected comes first: it knows what it found, so checking the fix is quick.
		const earlierOf = (offer: ReviewOption) => state.rejected?.find((rejected) => rejected.change === offer.change);
		const ordered = [...reviews.filter(earlierOf), ...reviews.filter((offer) => !earlierOf(offer))];
		for (const offer of ordered) {
			// Taking the change's credentials marks the review as this agent's, so others go elsewhere.
			const taken = await call("credentials", { change: offer.change, role: offer.role }).then(
				() => true,
				(err) => {
					if (statusOf(err).status === 409) return false;
					throw err;
				},
			);
			if (!taken) continue;
			const earlier = earlierOf(offer);
			const started = (await this.startReviewer(state.repo, offer, state.name, earlier)) as
				{ head?: string } | undefined;
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
		const claimed = (await call("claim", claim).catch(async (err) => {
			if (statusOf(err).status === 409) return { ok: false };
			await giveBack(call, piece.id, "its claim failed partway");
			throw err;
		})) as { ok?: boolean; stillHeld?: string[] };
		if (claimed.stillHeld?.length) await giveBack(call, piece.id, "its refused claim left records behind");
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

/**
 * Releases a claim this agent may hold without knowing it: one refused partway, whose records in some shards weren't
 * undone, or one written although the call failed, as a busy repo's storage can answer an error after a write. Either
 * way nobody would build it, and the piece would sit claimed until it counted as abandoned. Releasing a claim the
 * agent doesn't hold changes nothing.
 */
async function giveBack(call: Call, change: string, reason: string) {
	await call("release", { change, reason }).catch((err) =>
		console.error(`giving ${change} back failed`, statusOf(err).message),
	);
}

/** Remembers a change the agent's reviewer rejected, the latest few and once each. */
function remember(state: HostedAgentState, rejected: Rejected) {
	const others = (state.rejected ?? []).filter((kept) => kept.change !== rejected.change);
	state.rejected = [...others, rejected].slice(-REJECTED_KEPT);
}
