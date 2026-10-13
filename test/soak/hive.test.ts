import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AGENT_FALLBACK_MS, type HostedAgentState } from "../../src/hosted-agents";
import { callTool, type ToolContext } from "../../src/toolkit/mcp";
import { hiveIdentity, MOST_HIVE_AGENTS } from "../../src/toolkit/hive-agents";
import { castHostedVote } from "../../src/toolkit/hosted-vote";
import { holdKey, type ReviewOption } from "../../src/toolkit/work";
import { FakeStorage } from "../fakes/env";
import { pushChange } from "../helpers/agents";
import { startGitServer, type GitServer } from "../helpers/git-server";
import { keepFailing, runOutcome, seedRun, soakCache, soakContext, soakPieces, soakReviews } from "../helpers/soak";

const { HostedAgent } = await import("../../src/hosted-agents");

// The soak run again, with GitHive's own hosted agents: thirteen of the HostedAgent class demos run, each on its own
// alarm, rung by a real RepoCache as tools write, pushes arrive and batches land. Only their builders and reviewers
// stand in. A builder pushes its piece, though now and then one gives up and releases it; a reviewer votes as
// GitHive's does (castHostedVote) and merges, though now and then one gives its review back without voting. The
// server keeps failing under them as in agents.test.ts. Every piece must land once, with no claim left and every
// agent stopped, and no agent may have waited for its two-minute fallback: every turn came from a ring.

const RUN_WITHIN_MS = 240_000;
/** Pieces free at the start; the rest wait on one a layer before them. */
const FIRST_LAYER = 5;
/** Every so many pieces, the first builder on it gives up. */
const GIVE_UP_EVERY = 4;
/** Every so many reviews, the reviewer gives the review back without voting. */
const GIVE_BACK_EVERY = 5;
/** How many times a stand-in tries a failed call before it gives up on it. */
const TRIES = 5;

let server: GitServer;
let work: string;
beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-soak-hive-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

type Agent = InstanceType<typeof HostedAgent>;
type Tool = (name: string, args: Record<string, unknown>, agent: string) => Promise<Record<string, unknown>>;
type NotePush = (change: string, head: string) => Promise<void>;
type Reviewing = NonNullable<HostedAgentState["reviewing"]>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The call's result, trying again as a builder or reviewer does; undefined when every try failed. */
async function retried<T>(call: () => Promise<T>): Promise<T | undefined> {
	for (let attempt = 0; attempt < TRIES; attempt++) {
		try {
			return await call();
		} catch {
			await pause(200);
		}
	}
	return undefined;
}

const reviewKey = (change: string, head: string, agent: string) => `${change}@${head}:${agent}`;

type Vote = Parameters<typeof castHostedVote>[2];

/** GitHive's builder and reviewers, standing in: what they're at, and what they've done. */
function standIns(tool: Tool, hooks: { notePush: NotePush; vote: (vote: Vote, author: string) => Promise<void> }) {
	const building = new Set<string>();
	const reviewed = new Set<string>();
	const tally = { gaveUp: 0, givenBack: 0 };
	const started = new Set<Promise<unknown>>();
	const triedOnce = new Set<string>();
	let reviews = 0;

	const inBackground = (task: Promise<unknown>) => {
		started.add(task);
		void task.finally(() => started.delete(task));
	};

	async function build(change: string, agent: string) {
		const first = !triedOnce.has(change);
		triedOnce.add(change);
		const pieceNumber = Number(change.replace("piece-", ""));
		if (first && pieceNumber % GIVE_UP_EVERY === 1) {
			tally.gaveUp++;
			await retried(() => tool("release", { change, agent, reason: "its builder gave up" }, agent));
			return;
		}
		const head = await pushed(change, agent);
		if (head) await hooks.notePush(change, head);
		else await retried(() => tool("release", { change, agent, reason: "its builder couldn't push" }, agent));
	}

	// A push the server applied but answered with an error shows in the change's status, so it isn't pushed again.
	async function pushed(change: string, agent: string) {
		const files = { [`src/${change}/index.js`]: `export const ${change.replace("-", "")} = 1;\n` };
		for (let attempt = 0; attempt < TRIES; attempt++) {
			try {
				return await pushChange(server.url, work, agent, change, files);
			} catch {
				const status = await tool("status", { change, agent }, agent).catch(() => null);
				if (typeof status?.head === "string") return status.head;
				await pause(200);
			}
		}
		return undefined;
	}

	// As GitHive's reviewer does: it votes, is done, then merges as the change's agent; one that fails gives the
	// review back.
	async function review(offer: ReviewOption, agent: string, done: () => void) {
		reviews++;
		const { change, head, role } = offer;
		const giveBack = () => retried(() => tool("leave_review", { agent, change, head, role }, agent));
		const status = await retried(() => tool("status", { change }, agent));
		const author = (status?.claim as { agent?: string } | undefined)?.agent;
		if (!author) return void (await giveBack());
		if (reviews % GIVE_BACK_EVERY === 0) {
			tally.givenBack++;
			return void (await giveBack());
		}
		const vote: Vote = { commit: head, change, reviewer: agent, role, verdict: "approve", evidence: "reads right" };
		const voted = await retried(async () => (await hooks.vote(vote, author), true));
		if (!voted) return void (await giveBack());
		done();
		await retried(() => tool("merge", { change, agent: author }, agent));
	}

	return {
		building,
		reviewed,
		tally,
		started,
		startBuilder(change: string, agent: string) {
			building.add(change);
			inBackground(build(change, agent).finally(() => building.delete(change)));
		},
		startReviewer(offer: ReviewOption, agent: string) {
			const done = () => reviewed.add(reviewKey(offer.change, offer.head, agent));
			inBackground(review(offer, agent, done).finally(done));
		},
	};
}

/** Repo "p"'s hive of hosted agents, their RepoCache, and the stand-ins they start. */
function soakHive() {
	const instances = new Map<string, Agent>();
	const storages = new Map<string, FakeStorage>();
	const hostedAgents = { getByName: (name: string) => instanceFor(name) };
	const cache = soakCache({ HOSTED_AGENT: hostedAgents } as never);
	const ctx: ToolContext = { ...soakContext(server, cache), reviews: soakReviews(server) };
	const asAgent = (agent: string): ToolContext => ({ ...ctx, hosted: true, identity: hiveIdentity(agent) });
	const tool: Tool = (name, args, agent) =>
		callTool(name, { repo: "p", ...args }, asAgent(agent)) as Promise<Record<string, unknown>>;
	// A push reaches the RepoCache as Artifacts' push event does, offering the change for review.
	const notePush = (change: string, head: string) =>
		cache.notePushes([{ change, fork: `p--${change}`, head, at: Date.now() }]);
	const vote = (cast: Vote, author: string) => castHostedVote(ctx, "p", cast, author);
	const crew = standIns(tool, { notePush, vote });

	class SoakAgent extends HostedAgent {
		protected override callTool(name: string, args: Record<string, unknown>, agent: string) {
			return callTool(name, args, asAgent(agent));
		}
		protected override async buildersAtWork(_repo: string, changes: string[]) {
			return new Set(changes.filter((change) => crew.building.has(change)));
		}
		protected override async startBuilder(_repo: string, change: string) {
			const name = (await this.account())!.name;
			crew.startBuilder(change, name);
		}
		protected override async startReviewer(_repo: string, offer: ReviewOption, agent: string) {
			crew.startReviewer(offer, agent);
			return { head: offer.head };
		}
		protected override async reviewerResult(_repo: string, reviewing: Reviewing, agent: string) {
			return { over: crew.reviewed.has(reviewKey(reviewing.change, reviewing.head, agent)) };
		}
		protected override async stillHolds(repo: string, reviewing: Reviewing, agent: string) {
			const held = await ctx.reviews!.held(repo, [reviewing.head]);
			return held[holdKey(reviewing.head, reviewing.role)]?.includes(agent) ?? false;
		}
		protected override agentNamed(repo: string, name: string) {
			return instanceFor(`agent:${repo}:${name}`);
		}
		protected override async listenToRepo(repo: string) {
			await cache.hiveListens(repo);
		}
	}

	function instanceFor(name: string): Agent {
		let instance = instances.get(name);
		if (!instance) {
			const storage = new FakeStorage();
			instance = new SoakAgent({ storage } as never, {} as never);
			instances.set(name, instance);
			storages.set(name, storage);
		}
		return instance;
	}
	return { ctx, crew, repoHive: instanceFor("hive:p"), instanceFor, storages };
}

/**
 * Fires an agent's alarm whenever it's due, one turn at a time, as the Durable Object runtime does, until the agent
 * stops setting one. Returns the longest it went between turns.
 */
async function runAlarms(agent: Agent, storage: FakeStorage, deadline: number) {
	let longest = 0;
	let last = Date.now();
	while (Date.now() < deadline) {
		const at = await storage.getAlarm();
		if (at === null) break;
		if (at > Date.now()) {
			await pause(Math.min(at - Date.now(), 50));
			continue;
		}
		await storage.deleteAlarm();
		longest = Math.max(longest, Date.now() - last);
		last = Date.now();
		await agent.alarm();
	}
	return longest;
}

const timeout = RUN_WITHIN_MS + 60_000;
it("GitHive's own agents land every piece once and stop, however the store fails", { timeout }, async () => {
	const hive = soakHive();
	await seedRun(hive.ctx, soakPieces(MOST_HIVE_AGENTS, FIRST_LAYER));
	const stop = keepFailing(server);
	const deadline = Date.now() + RUN_WITHIN_MS;
	let longestGaps: number[] = [];
	try {
		const status = await hive.repoHive.start({ repo: "p", count: MOST_HIVE_AGENTS, minutes: 45, by: "ada" });
		const names = status!.names.map((name) => `agent:p:${name}`);
		const run = (name: string) => runAlarms(hive.instanceFor(name), hive.storages.get(name)!, deadline);
		longestGaps = await Promise.all(names.map(run));
		await Promise.all([...hive.crew.started]);
	} finally {
		stop();
	}
	const after = (await hive.repoHive.status())!;
	const accounts = after.agents.map((agent) => ({ done: agent.done, failing: agent.failing }));
	console.log(`soak, hosted agents: ${JSON.stringify({ ...hive.crew.tally, working: after.working })}`);
	expect(hive.crew.tally.gaveUp).toBeGreaterThan(0);
	// Every turn came from a ring: none waited for its fallback.
	expect(Math.max(...longestGaps)).toBeLessThan(AGENT_FALLBACK_MS);
	expect(after.working).toBe(false);
	expect(accounts.filter((account) => account.failing > 0)).toEqual([]);
	expect(await runOutcome(server, hive.ctx)).toEqual({
		left: [],
		audit: { merges: MOST_HIVE_AGENTS, open: 0, violations: [] },
		landed: MOST_HIVE_AGENTS,
	});
});
