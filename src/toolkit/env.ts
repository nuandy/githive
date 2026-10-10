import { linkTo } from "../github";
import { readBranchHistory } from "./branch-history";
import { DEFAULT_POLICY, hostedRoles } from "./mcp";
import { effectivePolicy } from "./votes";
import { ensureRepo, forkAndWait, headOf, isForkNotReady, remoteFor, reviewerName, withHistory } from "../artifacts";
import { GitCasLog } from "../record-log";
import { rpc, rpcRetried } from "../rpc";
import { fail } from "../errors";
import { defaultBranch, type Remote, Workspace } from "../git";
import { projectBranch } from "../project-branch";
import { claimStore } from "./claim-store";
import { type ReviewHolds, reviewHolds, reviewsRef, reviewsRepoOf } from "./review-holds";
import type { Registry } from "./claims";
import type { ToolContext, HostedStatus } from "./mcp";
import type { BatchSource } from "./merge";
import type { Settled } from "./landing";
import { recordsRepoName } from "./shards";
import { makeStamper } from "./stamp";
import { headsForClaims } from "../push-events";
import { gitLanding, landingRef, landingRepoOf, lazyLog, type LeaseRecord } from "./landing-lease";

// GitHive wired to Cloudflare: Artifacts for Git, the Gate's
// container for checks, the repo index for the dashboard, GitHive's hosted
// agents. Shared by the Worker (acting for an MCP caller) and by the hosted
// agents themselves (acting as themselves).

/**
 * Artifacts tokens, per repo and scope, kept in the project's TokenCache (for
 * every isolate) and briefly in the isolate: minting one is several Artifacts
 * calls, which dominated each tool call. They last an hour and are reused for
 * half of it. An isolate asks the TokenCache again after ISOLATE_MS, so
 * deleting a project (which clears its TokenCache) reaches every isolate soon.
 * Only minted tokens are shared: a mint still in flight is its own request's
 * I/O, which in Workers no other request may wait on, so calls that miss at
 * once each mint their own. If the TokenCache fails, the token is minted.
 */
const remotes = new Map<string, { remote: Remote; until: number }>();
const REUSE_MS = 30 * 60_000;
const ISOLATE_MS = 2 * 60_000;
async function cached(env: Env, project: string, key: string, mint: () => Promise<Remote>) {
	const hit = remotes.get(key);
	if (hit && Date.now() < hit.until) return hit.remote;
	const store = env.TOKENS?.getByName(project);
	const kept = store ? await rpc(store.get(key)).catch(() => null) : null;
	if (kept) {
		remotes.set(key, { remote: kept.remote, until: Math.min(kept.until, Date.now() + ISOLATE_MS) });
		return kept.remote;
	}
	const remote = await mint();
	const until = Date.now() + REUSE_MS;
	remotes.set(key, { remote, until: Date.now() + ISOLATE_MS });
	await store?.put(key, remote, until).catch(() => undefined);
	return remote;
}

/** Each record's log, kept for the isolate: a log remembers the tip it last saw, so reading an unmoved ref needn't fetch it. */
const logs = new Map<string, GitCasLog<unknown>>();

/** How long a kept copy of the claims stays fresh with no write in between. */
const KEPT_CLAIMS_MS = 30_000;
/** How long a branch's head stays fresh for the merges watching it. */
const KEPT_BRANCH_HEAD_MS = 2_000;
/** How long the open changes' heads stay fresh for next (pushes to forks don't ping, so this is all that ages them). */
/** How long a record's tip stays kept with no write clearing it (in case a write couldn't). */
const KEPT_TIP_MS = 10_000;
/** The largest view a RepoCache keeps. */
const MAX_KEPT = 1_000_000;

/**
 * A view of a repo kept in its RepoCache, for reads that tolerate a moment's
 * staleness: fresh, served as is; stale, served as is while one caller
 * rebuilds it (that caller gets the new one); none yet, one caller builds it
 * and the others wait for it a few seconds, so many callers at once read the
 * repo once, not once each. Writes make it stale (their pings count them).
 * The RepoCache is only a help: unreachable or overloaded, each caller reads
 * the repo itself, slower and never wrong.
 */
export async function keptRead<T>(env: Env, repo: string, name: string, maxAgeMs: number, read: () => Promise<T>): Promise<T> {
	const cache = env.REPO_CACHE.getByName(`repo:${repo}`);
	const rebuild = async (writes: number) => {
		let value: T;
		try {
			value = await read();
		} catch (err) {
			await cache.buildFailed(name).catch(() => undefined);
			throw err;
		}
		// Kept for the next callers if it can be: a cache that can't keep it doesn't fail this read.
		const json = JSON.stringify(value);
		await (json.length <= MAX_KEPT ? cache.keep(name, json, writes) : cache.buildFailed(name)).catch((err) => console.error(`keeping ${name} of ${repo} failed`, String(err)));
		return value;
	};
	// Null: the cache didn't answer.
	const starting = () => cache.startBuild(name).catch(() => null);
	for (const until = Date.now() + 10_000; ; ) {
		const kept = await rpc(cache.view(name, maxAgeMs)).catch(() => null);
		if (!kept) return read();
		if (kept.json !== undefined) {
			if (kept.fresh || kept.building) return JSON.parse(kept.json) as T;
			const build = await starting();
			if (build === null) return read();
			return build ? rebuild(kept.writes) : (JSON.parse(kept.json) as T);
		}
		if (!kept.building) {
			const build = await starting();
			if (build === null) return read();
			if (build) return rebuild(kept.writes);
		}
		// Another caller is building the first one: wait for it, a few seconds at most.
		if (Date.now() > until) return read();
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

/** A repo's record log at `ref`, one per ref in the isolate. */
function recordsLog<S>(env: Env, repo: string, ref: string) {
	let log = logs.get(ref);
	if (!log) {
		// What other Worker instances already read of the project repo's records, by tip, in its RepoCache.
		const cache = () => env.REPO_CACHE.getByName(`repo:${repo}`);
		const states = { get: (r: string, tip: string) => rpc(cache().recordAt(r, tip)), put: (r: string, tip: string, json: string) => cache().keepRecord(r, tip, json) };
		// And where its ref points, so that a read needn't list it on the busy project repo.
		const tips = { get: (r: string, stateKey: string) => rpc(cache().tipOf(r, stateKey, KEPT_TIP_MS)), keep: (r: string, tip: string | null, gen: number) => cache().keepTip(r, tip, gen), landed: (r: string, parent: string | null, tip: string) => cache().landedTip(r, parent, tip), stale: (r: string, parent: string | null) => cache().staleTip(r, parent) };
		logs.set(ref, (log = new GitCasLog<unknown>(() => cached(env, repo, `${repo}|write`, () => remoteFor(env.ARTIFACTS, repo, "write", 3600)), repo, ref, { states, tips })));
	}
	return log as GitCasLog<S>;
}

/**
 * A record kept in records repo `k` of `repo`, not the project repo (review
 * holds, say), kept for the isolate like recordsLog's, its tips in the repo's
 * RepoCache under the records repo's name (the same ref may be in the
 * project repo too, from before).
 */
function recordsLogIn<S>(env: Env, repo: string, k: number, ref: string) {
	const key = `${recordsRepoName(repo, k)}:${ref}`;
	let log = logs.get(key);
	if (!log) {
		const cache = () => env.REPO_CACHE.getByName(`repo:${repo}`);
		const states = { get: (r: string, tip: string) => rpc(cache().recordAt(r, tip)), put: (r: string, tip: string, json: string) => cache().keepRecord(r, tip, json) };
		const tips = {
			get: (r: string, stateKey: string) => rpc(cache().tipOf(key, stateKey, KEPT_TIP_MS)),
			keep: (r: string, tip: string | null, gen: number) => cache().keepTip(key, tip, gen),
			landed: (r: string, parent: string | null, tip: string) => cache().landedTip(key, parent, tip),
			stale: (r: string, parent: string | null) => cache().staleTip(key, parent),
		};
		logs.set(key, (log = new GitCasLog<unknown>(() => cached(env, repo, `${recordsRepoName(repo, k)}|write`, () => remoteFor(env.ARTIFACTS, recordsRepoName(repo, k), "write", 3600)), repo, ref, { states, tips })));
	}
	return log as GitCasLog<S>;
}

/**
 * The context for one actor: `by` is who it is (as Access or GitHive's
 * sign-in verified them, or a hosted agent's own name), and stamps carry it,
 * with the agent name its key or token is for. Hosted agents (`hosted`) act under githive- names.
 */
export function toolContextFor(env: Env, by: string | undefined, caller: { agentKey?: string; agent?: string; hosted?: boolean; teamsOf?: (repo: string) => Promise<string[]>; mayUseHosted?: () => Promise<boolean> } = {}): ToolContext {
	return {
		...caller,
		register: async (repo) => env.REPO_INDEX.getByName("all").addRepo(repo),
		summarize: (repo, patch) => env.REPO_INDEX.getByName("all").summarize(`repo:${repo}`, patch),
		ping: async (repo) => void (await env.REPO_CACHE?.getByName(`repo:${repo}`).ping("records")),
		// The repo's own Gate keeps its snapshot fresh (see Gate.warmUp): a batch's checks run in Gates of the batch's own.
		warmChecks: async (repo, { expect, ...input }) => {
			const remote = await cached(env, repo, `${repo}|read`, () => remoteFor(env.ARTIFACTS, repo, "read", 3600));
			await env.GATE.getByName(`repo:${repo}`).warmUp({ repo, ...input, base: { remote: remote.url, token: remote.token }, why: expect });
		},
		// The claims for advice, kept in the repo's RepoCache so a busy repo isn't read whole on every call.
		keptClaims: (repo, read) => keptRead(env, repo, "claims-advice", KEPT_CLAIMS_MS, read),
		// Heads read from forks, and those push events told of from the claims' agents' own forks (see push-events.ts).
		knownHeads: async (repo, claims) => headsForClaims(await rpc(env.REPO_CACHE.getByName(`repo:${repo}`).knownHeads(claims.map((c) => c.change))), claims, (agent) => forkName(repo, agent)),
		noteHeads: (repo, seen, readAt) => env.REPO_CACHE.getByName(`repo:${repo}`).noteHeads(seen, readAt),
		news: (repo, branch, agent) => rpc(env.REPO_CACHE.getByName(`repo:${repo}`).landingNews(branch, agent)),
		// GitHive's GitHub App, when its ID and key are set: a repo connects to GitHub through it (see github.ts).
		...(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY ? { github: (repo: string) => linkTo({ appId: env.GITHUB_APP_ID!, privateKey: env.GITHUB_APP_PRIVATE_KEY! }, repo) } : {}),
		// A branch's head, kept a moment for every merge watching it (see MergeInput.branchHead).
		branchHead: (repo, branch) => keptRead(env, repo, `head:${branch}`, KEPT_BRANCH_HEAD_MS, () => headOf(env.ARTIFACTS, repo, branch)),
		// Forks made in the background, paced, before agents need them: the seeds when GitHive starts, an agent's when it registers.
		prepareForks: async (repo, items) => void (await env.REPO_CACHE?.getByName(`repo:${repo}`).queueForks(repo, items === "seeds" ? seedItems() : items.map((agent) => `agent:${agent}`))),
		// Review holds are a record in Git: in one of the repo's records repos once it has them (see review-holds.ts), else
		// beside the claims and votes.
		reviews: reviewHolds(async (repo) => {
			const spread = (await recordsLog<Registry>(env, repo, claimsRef(repo)).read())?.commit.state.recordsRepos ?? 0;
			return spread ? recordsLogIn<ReviewHolds>(env, repo, reviewsRepoOf(spread), reviewsRef(repo)) : recordsLog<ReviewHolds>(env, repo, reviewsRef(repo));
		}),
		requestReview: (input) => startHostedReviewers(env, input),
		startBuilder: (input) => startHostedBuilder(env, input),
		stamper: async (agent) => (env.STAMP_KEY && by ? makeStamper(env.STAMP_KEY, agent ? `${by}/${agent}` : by) : undefined),
		remote: (repo, scope) => cached(env, repo, `${repo}|${scope}`, () => remoteFor(env.ARTIFACTS, repo, scope, 3600)),
		changeRemote: (repo, agent, scope) => cached(env, repo, `fork:${repo}:${agent}|${scope}`, () => changeRemote(env, repo, agent, scope, 3600)),
		legacyChangeRemote: (repo, change) => cached(env, repo, `${changeRepoName(repo, change)}|read`, () => remoteFor(env.ARTIFACTS, changeRepoName(repo, change), "read", 3600)),
		recordsRemote: (repo, k, scope) => cached(env, repo, `${recordsRepoName(repo, k)}|${scope}`, () => remoteFor(env.ARTIFACTS, recordsRepoName(repo, k), scope, 3600)),
		createRecordsRepos: async (repo, count) => {
			await Promise.all(Array.from({ length: count }, (_, k) => ensureRepo(env.ARTIFACTS, recordsRepoName(repo, k), `Claim records for ${repo}`)));
		},
		records: <S>(repo: string, ref: string) => recordsLog<S>(env, repo, ref),
		agentStatus: (repo, change, head, roles) => hostedAgentStatus(env, repo, change, head, roles),
		head: async (repo, branch) => (await headOf(env.ARTIFACTS, repo, branch)) ?? fail(409, `${repo} has no ${branch} branch`),
		defaultBranch: async (repo) => (await defaultBranch(await remoteFor(env.ARTIFACTS, repo, "read", 3600))) ?? fail(409, `${repo} has no commits`),
		// A batch's checks, in Gates named for the batch and a place in its search (a half stays in its parent's, the
		// other takes the next), on main with the batch's changes merged in, in order; or the last change's Gate when unnamed.
		runChecks: (repo) => {
			const read = () => cached(env, repo, `${repo}|read`, () => remoteFor(env.ARTIFACTS, repo, "read", 3600));
			const fork = (agent: string) => cached(env, repo, `fork:${repo}:${agent}|read`, () => changeRemote(env, repo, agent, "read", 3600));
			return async ({ base, branch, changes, commands, gate }) => {
				const remote = await read();
				const sourceOf = async (c: (typeof changes)[number]) => {
					const from = c.source ?? (await fork(c.agent));
					return { remote: from.url, token: from.token, ref: c.ref };
				};
				const last = changes.at(-1)!;
				const ahead = await Promise.all(changes.slice(0, -1).map(async (c) => ({ head: c.head, ...(await sourceOf(c)) })));
				const forkOf = await sourceOf(last);
				// The batch's own Gates (see checkBatch's Place), or the last change's.
				const name = gate ? `repo:${repo}:check:${gate}` : `repo:${repo}:change:${last.change}`;
				const result = await rpcRetried(() => env.GATE.getByName(name).checkCommit({ repo, branch, base: { remote: remote.url, token: remote.token }, fork: forkOf, head: last.head, checks: commands, baseHead: base, ahead }));
				const conflict = result.mergeConflict ? [{ command: "(merging the batch onto main)", exitCode: 1, output: `conflicts in ${result.mergeConflict.join(", ")}` }] : [];
				return { passed: result.passed, results: [...conflict, ...result.results.map((r) => ({ command: r.command, exitCode: r.exitCode, output: r.output }))] };
			};
		},
		// A branch's commits for the audit, read through Artifacts' own API, each merge's files worked out once and kept in the
		// repo's RepoCache (see branch-history.ts): no clone, and no container.
		readBranch: (repo, baseline, branch) => {
			const cache = () => env.REPO_CACHE.getByName(`repo:${repo}`);
			// Kept files are a help: without the cache, each merge's files are worked out again.
			return withHistory(env.ARTIFACTS, repo, (source) => readBranchHistory(source, baseline, branch, { get: (commits) => rpc(cache().keptFiles(commits)).catch(() => ({})), put: (files) => cache().keepFiles(files).catch(() => undefined) }));
		},
		// Any repo's history (a project's, an agent's fork) through Artifacts' own API: a batch's changes are read that way.
		history: (name, read) => withHistory(env.ARTIFACTS, name, read),
		// A branch's head in an agent's fork, through Artifacts' API: one log, no token or Git listing.
		forkHead: async (repo, agent, ref) => {
			const name = await forkName(repo, agent);
			try {
				return (await headOf(env.ARTIFACTS, name, ref)) ?? null;
			} catch (err) {
				if (/NOT_FOUND|not found/i.test(`${(err as { code?: string })?.code ?? ""} ${String(err)}`)) throw new Error(`[409] ${agent} has no fork yet: nothing has been pushed`);
				throw err;
			}
		},
		// A batch's first check container, started while the batch is read (see MergeInput.prepareChecks).
		prepareChecks: (repo) => async (gate) => {
			const read = await cached(env, repo, `${repo}|read`, () => remoteFor(env.ARTIFACTS, repo, "read", 3600));
			await rpcRetried(() => env.GATE.getByName(`repo:${repo}:check:${gate}`).boot({ repo, base: { remote: read.url, token: read.token } }));
		},
		// The repo's own Gate started while a batch is read, so its landing finds it running (see MergeInput.prepareLanding).
		prepareLanding: async (repo) => {
			const read = await cached(env, repo, `${repo}|read`, () => remoteFor(env.ARTIFACTS, repo, "read", 3600));
			await rpcRetried(() => env.GATE.getByName(`repo:${repo}`).boot({ repo, base: { remote: read.url, token: read.token } }));
		},
		// A batch's git work (reading its changes, landing them) in the repo's own Gate's container, which never runs a
		// change's code: the Worker only reads the records (see BatchGit).
		batchGit: (repo) => {
			const gate = () => env.GATE.getByName(`repo:${repo}`);
			const project = (scope: "read" | "write") => cached(env, repo, `${repo}|${scope}`, () => remoteFor(env.ARTIFACTS, repo, scope, 3600));
			const fork = (agent: string) => cached(env, repo, `fork:${repo}:${agent}|read`, () => changeRemote(env, repo, agent, "read", 3600));
			const sourceOf = async (c: BatchSource) => {
				const from = c.source ?? (await fork(c.agent));
				return { change: c.change, remote: from.url, token: from.token, ref: c.ref };
			};
			return {
				inspect: async ({ base, branch, changes }) => {
					const read = await project("read");
					const sources = await Promise.all(changes.map(sourceOf));
					return rpcRetried(() => gate().inspectBatch({ repo, branch, base: { remote: read.url, token: read.token }, baseHead: base, changes: sources }));
				},
				land: async ({ base, branch, merges, by }) => {
					const write = await project("write");
					const sources = await Promise.all(merges.map(async (m) => ({ ...(await sourceOf(m)), head: m.head, claimed: m.claimed })));
					// Tried again after a brief outage too: the push names the main it lands on, so a batch that did land finds main moved.
					const landed = await rpcRetried<{ commits: string[] } | { moved: true } | { error: string }>(() =>
						gate().landBatch({ repo, branch, base: { remote: write.url, token: write.token }, baseHead: base, merges: sources, ...(by ? { by } : {}) }),
					);
					if ("moved" in landed) return "moved";
					if ("error" in landed) throw new Error(`[500] landing the batch failed: ${landed.error}`);
					return { commits: landed.commits };
				},
				checksBranch: async ({ base, branch, changes, to, ref }) => {
					const read = await project("read");
					const sources = await Promise.all(changes.map(async (c) => ({ ...(await sourceOf(c)), head: c.head })));
					return rpcRetried<{ tip: string } | { failed: string }>(() => gate().checksBranch({ repo, branch, base: { remote: read.url, token: read.token }, baseHead: base, changes: sources, to: { remote: to.url, token: to.token, ...(to.user ? { user: to.user } : {}) }, ref }));
				},
				pushBranch: async ({ branch, head, to }) => {
					const read = await project("read");
					const pushed = await rpcRetried<{ pushed: true } | { refused: string }>(() => gate().pushBranch({ repo, branch, base: { remote: read.url, token: read.token }, head, to: { remote: to.url, token: to.token, ...(to.user ? { user: to.user } : {}) } }));
					if ("refused" in pushed) throw new Error(`pushing ${branch} to ${to.url} was refused: ${pushed.refused}`);
				},
			};
		},
		// Who's landing a batch into each branch: a record in Git, in one of the repo's records repos once it has them, else
		// beside the claims (see landing-lease.ts). What changes came to and the rest, in the repo's RepoCache, as a help.
		landing: (repo, branch) => {
			const cache = () => env.REPO_CACHE.getByName(`repo:${repo}`);
			return gitLanding(landingLog(env, repo, branch), {
				drop: (holder) => rpcRetried(() => cache().dropLanding(branch, holder)),
				checking: (batch) => rpcRetried(() => cache().landingChecking(branch, batch)),
				settle: (outcomes) => rpcRetried(() => cache().landingSettled(branch, outcomes)),
				view: () => rpcRetried(() => cache().landingView(branch)),
				passed: (base, heads) => rpcRetried(() => cache().landingPassed(branch, base, heads)),
				checked: (base, heads) => rpcRetried(() => cache().landingChecked(branch, base, heads)),
				keepAhead: (ahead) => rpcRetried(() => cache().landingKeepAhead(branch, ahead)),
				ahead: () => rpcRetried(() => cache().landingAhead(branch)),
			});
		},
	};
}

/** A branch's landing lease record (see landing-lease.ts): in one of the repo's records repos once it has them, else beside the claims. */
export function landingLog(env: Env, repo: string, branch: string) {
	return lazyLog(async () => {
		const spread = (await recordsLog<Registry>(env, repo, claimsRef(repo)).read())?.commit.state.recordsRepos ?? 0;
		return spread ? recordsLogIn<LeaseRecord>(env, repo, landingRepoOf(branch, spread), landingRef(repo, branch)) : recordsLog<LeaseRecord>(env, repo, landingRef(repo, branch));
	});
}

const claimsRef = (repo: string) => `refs/notes/githive-claims/${repo}`;
/** A change's hosted agents' Durable Object names: one builder, one reviewer per role and commit. */
export const changeRepoName = (repo: string, change: string) => `fork--${repo}--${change}`;

/**
 * An agent's fork of a project repo: one per agent, holding a branch per
 * change. Its name follows the agent's (lowercase, safe characters), with a
 * short hash of the real name when those differ, so two names never share one.
 */
export async function forkName(repo: string, agent: string) {
	const slug = agent.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
	if (slug === agent) return `fork--${repo}--agent--${slug}`;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(agent)));
	return `fork--${repo}--agent--${slug}-${[...digest.slice(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * How many seed forks a project's agents' forks are made from. A fork copies
 * its source repo, and a crowd of agents arriving at once would otherwise all
 * copy the project's repo at once (200 forks of Express left it answering
 * nothing else). The seeds are made one at a time in the background when
 * GitHive starts on the project (see RepoCache's fork queue): 16 asked for at
 * once left some of Artifacts' fork jobs stalled for good.
 */
export const FORK_SEEDS = 8;
/** A project's seed fork `k`. */
export const seedName = (repo: string, k: number) => `fork--${repo}--seed--${k}`;

/** Which seed an agent's fork is made from, when it's ready: a stable hash of its name. */
function seedOf(agent: string) {
	let h = 0x811c9dc5;
	for (let i = 0; i < agent.length; i++) h = Math.imul(h ^ agent.charCodeAt(i), 0x01000193);
	return (h >>> 0) % FORK_SEEDS;
}

/** The forks a repo's fork queue makes: its seeds, all of them. */
export const seedItems = () => Array.from({ length: FORK_SEEDS }, (_, k) => `seed:${k}`);

/** Make seed `k` of `repo` (or wait for it, if it's being made), from the project's repo. */
export async function makeSeed(env: Env, repo: string, k: number) {
	const name = seedName(repo, k);
	await remoteFor(env.ARTIFACTS, name, "read", 60).catch(() => forkAndWait(env.ARTIFACTS, repo, name, `seed ${k} for forks of ${repo}`, { shared: true }));
}

/**
 * Make an agent's fork of `repo`, or wait for it if it's being made (by the
 * fork queue, say): from its own seed if that's ready, else another that is,
 * else the project itself (seeds not made yet: asked for now). A source whose
 * fork fails is passed over for the next.
 */
export async function makeAgentFork(env: Env, repo: string, agent: string) {
	const name = await forkName(repo, agent);
	if (await remoteFor(env.ARTIFACTS, name, "read", 60).then(() => true, () => false)) return;
	const cache = env.REPO_CACHE?.getByName(`repo:${repo}`);
	const ready = (cache ? await rpc(cache.readySeeds()).catch(() => [] as number[]) : []) ?? [];
	if (!ready.length) await cache?.queueForks(repo, seedItems()).catch(() => undefined);
	const own = seedOf(agent);
	const seeds = [...ready].sort((a, b) => ((a - own + FORK_SEEDS) % FORK_SEEDS) - ((b - own + FORK_SEEDS) % FORK_SEEDS)).map((k) => seedName(repo, k));
	let failure: unknown;
	for (const source of [...seeds, repo]) {
		try {
			await forkAndWait(env.ARTIFACTS, source, name, `${agent}'s fork of ${repo}`, { shared: true });
			return;
		} catch (err) {
			// Asked for, but not ready in time: another source would only wait on the same fork. Said so, to ask again.
			if (isForkNotReady(err)) throw new Error(`[503] ${agent}'s fork of ${repo} is still being made: call again in a minute`);
			failure = err;
		}
	}
	throw failure;
}

/** Credentials for an agent's own fork of the project repo; writing to it first creates the fork (once, for all its changes). */
export async function changeRemote(env: Env, repo: string, agent: string, scope: "read" | "write", ttlSeconds: number) {
	const name = await forkName(repo, agent);
	try {
		return await remoteFor(env.ARTIFACTS, name, scope, ttlSeconds);
	} catch (err) {
		if (scope === "read") throw new Error(`[409] ${agent} has no fork yet: nothing has been pushed`);
		await makeAgentFork(env, repo, agent);
		return remoteFor(env.ARTIFACTS, name, scope, ttlSeconds);
	}
}

/** What every hosted agent on a change is told: its claim as the brief, the other claims, the checks. */
async function changeBrief(env: Env, repo: string, change: string) {
	const read = await remoteFor(env.ARTIFACTS, repo, "read", 3 * 3600);
	const root = new GitCasLog<Registry>(async () => read, repo, claimsRef(repo));
	const registry = (await root.read())?.commit.state;
	const { claims } = await claimStore({ repo, registry, root, remote: async () => read, recordsRemote: (k) => remoteFor(env.ARTIFACTS, recordsRepoName(repo, k), "read", 3 * 3600) }).read();
	const own = claims.find((c) => c.change === change);
	return {
		read,
		own,
		branch: projectBranch(registry),
		/** Where the change's branch lives: its own fork. */
		source: (scope: "read" | "write") => changeRemote(env, repo, own?.agent ?? "githive-builder", scope, 3 * 3600),
		policy: registry?.policy ?? DEFAULT_POLICY,
		job: {
			repo: changeRepoName(repo, change),
			project: repo,
			branch: projectBranch(registry),
			verify: registry?.verify ?? [],
			change,
			ref: `changes/${change}`,
			agent: own?.agent ?? change,
			intent: own?.intent ?? change,
			claim: own?.paths ?? [],
			others: claims.filter((c) => c.change !== change).map((c) => ({ change: c.change, claim: c.paths })),
		},
	};
}

/**
 * Start GitHive's hosted reviewers on a change: its branch
 * head, reviewed against where it left main, with its claim as the brief. Each
 * reviewer votes with vote when it's done; with `mergeWhenApproved`, it
 * then tries to merge the change, which the toolkit refuses until the approvals
 * are in, so the last vote's attempt is the one that lands.
 */
export async function startHostedReviewers(env: Env, input: { repo: string; change: string; roles?: string[]; summary?: string; mergeWhenApproved?: boolean }) {
	const { repo, change } = input;
	const ref = `changes/${change}`;
	const { read, own, policy, job, source, branch } = await changeBrief(env, repo, change);
	// By default a general review, and every role that can veto a change to its claim's paths.
	const roles = input.roles?.length ? input.roles : hostedRoles(effectivePolicy(policy, own?.paths ?? []).vetoes);
	const from = await source("read");
	const ws = await Workspace.clone(read, branch);
	const head = await ws.fetch("change", from, ref);
	const baseCommit = await ws.mergeBase(await ws.head(), head);
	const review = { ...job, remote: from.url, token: from.token, head, baseCommit, buildSummary: input.summary, mergeWhenApproved: !!input.mergeWhenApproved };
	await Promise.all(roles.map((role) => env.REVIEWER.getByName(reviewerName(changeRepoName(repo, change), role, head)).start({ ...review, role })));
	return { head, reviewers: roles };
}

/** Start GitHive's hosted builder on a claimed change: it works on the branch changes/<change> in the change's own fork. */
export async function startHostedBuilder(env: Env, input: { repo: string; change: string }) {
	const { repo, change } = input;
	const { read, own, job, source } = await changeBrief(env, repo, change);
	const write = await source("write");
	const build = { ...job, remote: write.url, token: write.token, base: { remote: read.url, token: read.token } };
	await env.BUILDER.getByName(changeRepoName(repo, change)).start(build);
	return { change, builder: changeRepoName(repo, change) };
}

/** Fresh credentials to resume GitHive's hosted builder on a change: its branch's home to push to, the project's main to merge from. */
export async function builderCredentials(env: Env, repo: string, change: string) {
	const { read, source } = await changeBrief(env, repo, change);
	const write = await source("write");
	return { token: write.token, base: { remote: read.url, token: read.token } };
}

/** What GitHive's hosted agents on a change are doing: its builder, if it has one, and each role's reviewer of `head`. */
export async function hostedAgentStatus(env: Env, repo: string, change: string, head: string | null, roles: string[]): Promise<HostedStatus> {
	const name = changeRepoName(repo, change);
	const [builder, reviewers] = await Promise.all([
		rpc(env.BUILDER.getByName(name).state()),
		head ? Promise.all(roles.map(async (role) => ({ role, state: await rpc(env.REVIEWER.getByName(reviewerName(name, role, head)).state()) }))) : [],
	]);
	return {
		...(builder ? { builder: { status: builder.status, revisions: builder.revisions, ...(builder.error ? { error: builder.error } : {}) } } : {}),
		reviewers: reviewers.flatMap(({ role, state }) => (state ? [{ role, status: state.status, ...(state.verdict ? { verdict: state.verdict } : {}) }] : [])),
	};
}
