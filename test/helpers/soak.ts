import { GitCasLog } from "../../src/record-log";
import { RepoCache } from "../../src/repo-cache";
import { type Landing, memoryLanding } from "../../src/toolkit/landing";
import { callTool, type ToolContext } from "../../src/toolkit/mcp";
import { holdsRef, type ReviewHolds, reviewHolds, reviewsRef } from "../../src/toolkit/review-holds";
import { FakeStorage } from "../fakes/env";
import type { GitServer } from "./git-server";
import { memoryBatchGit } from "./memory-batch-git";

// What the soak tests share: GitHive's tools against a test Git server and a real RepoCache (its doorbell, notices,
// news and landings, run in this process), a server that keeps failing under them, and the checks a finished run must
// pass.

/** How often the server is made to fail one more request. */
const FAULT_EVERY_MS = 400;

/** Repo "p"'s RepoCache, with `env` for what it reaches outside itself (the hive it rings). */
export function soakCache(env: Partial<Env> = {}) {
	return new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, env as Env);
}

/** The tools' context for repo "p", with the repo's RepoCache answering the doorbell, notices, news and landings. */
export function soakContext(server: GitServer, cache = soakCache()): ToolContext {
	const remote = async () => ({ url: server.url, token: "unused" });
	const lease = memoryLanding();
	// Outcomes reach the RepoCache as they do in the Worker, so a landing rings for the work it frees.
	const landing: Landing = {
		...lease,
		settle: async (outcomes) => {
			await lease.settle(outcomes);
			await cache.landingSettled("main", outcomes);
		},
	};
	return {
		remote,
		changeRemote: remote,
		batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
		head: async () => server.git("rev-parse", "main").trim(),
		recordsRemote: async (_repo, k) => ({ url: server.repo(`rec-${k}`), token: "unused" }),
		createRecordsRepos: async () => undefined,
		landing: () => landing,
		ping: async (_repo, event, tool, whom) => cache.ping("records", true, event ? [event] : [], tool, whom),
		doorbell: () => ({
			rings: () => cache.rings(),
			ringAfter: (mark, ms, agent) => cache.ringAfter(mark, ms, agent),
			rungFor: (agent, mark) => cache.rungFor(agent, mark),
			newestNotice: (agent) => cache.newestNotice(agent),
		}),
		news: (_repo, branch, agent, delivery) => cache.newsFor(branch, agent, delivery),
		notify: (_repo, branch, notices) => cache.notify(branch, notices),
	};
}

/** Review holds kept in Git as the Worker keeps them: the waits in one record, the holds in buckets. */
export function soakReviews(server: GitServer) {
	const remote = async () => ({ url: server.url, token: "unused" });
	return reviewHolds({
		waits: (repo) => new GitCasLog<ReviewHolds>(remote, repo, reviewsRef(repo)),
		holds: (repo, bucket) => new GitCasLog<ReviewHolds>(remote, repo, holdsRef(repo, bucket)),
	});
}

/** Makes the server fail one more request every so often, a different way each time, until stopped. */
export function keepFailing(server: GitServer) {
	const ways = [
		() => server.failPushes(1, true),
		() => server.failPushes(1, false),
		() => server.failFetches(1),
		() => server.busyPushes(1),
	];
	let next = 0;
	const timer = setInterval(() => {
		ways[next % ways.length]!();
		next++;
	}, FAULT_EVERY_MS);
	return () => clearInterval(timer);
}

export interface SoakPiece {
	id: string;
	after: string[];
	/** Pieces it lands after, though it's handed out at once, as the demo's wiring is. */
	landsAfter?: string[];
}

/**
 * The run's pieces, in layers of `width`: each waits on the piece a layer before it, so most agents start idle and
 * are woken as landings free work.
 */
export function soakPieces(count: number, width = count): SoakPiece[] {
	const id = (index: number) => `piece-${index}`;
	const after = (index: number) => (index < width ? [] : [id(index - width)]);
	return Array.from({ length: count }, (_, index) => ({ id: id(index), after: after(index) }));
}

/** Starts GitHive on repo "p" with one approval needed, and the pieces in its backlog. */
export async function seedRun(ctx: ToolContext, pieces: SoakPiece[]) {
	const setup = (name: string, args: Record<string, unknown>) => callTool(name, { repo: "p", ...args }, ctx);
	await setup("settings", { required: 1, vetoes: [] });
	const items = pieces.map(({ id, after, landsAfter }) => ({
		id,
		title: id,
		intent: `build ${id}`,
		paths: [`src/${id}/`],
		after,
		...(landsAfter ? { lands_after: landsAfter } : {}),
	}));
	await setup("add_work", { agent: "planner", items });
}

/** How the run ended: the claims left, the audit, and the merges on main naming a piece. */
export async function runOutcome(server: GitServer, ctx: ToolContext) {
	const claims = (await callTool("claims", { repo: "p" }, ctx)) as { change: string }[];
	const audit = await callTool("audit", { repo: "p" }, ctx);
	// Merge commits only: each piece's own commit is on main too.
	const landed = server
		.git("log", "--merges", "--format=%s", "main")
		.split("\n")
		.filter((subject) => /piece-\d+/.test(subject));
	return { left: claims.map((claim) => claim.change), audit, landed: landed.length };
}
