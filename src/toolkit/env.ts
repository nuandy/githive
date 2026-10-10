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
import { gitLanding, LANDING_RECORDS_REPO, landingRef, lazyLog, type LeaseRecord } from "./landing-lease";

// GitHive wired to Cloudflare: Artifacts for Git, the Gate's container for checks, the repo index for the
// dashboard and GitHive's hosted agents. Shared by the Worker, acting for an MCP caller, and by the hosted agents.

// Artifacts tokens per repo and scope, cached in the project's TokenCache and briefly in the isolate, because
// minting one takes several Artifacts calls. Workers forbids waiting on another request's I/O, so only finished
// mints are shared. Isolates re-check the TokenCache after ISOLATE_MS so deleting a project reaches them soon.
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

// Each record's log, cached for the isolate. A log remembers its last tip, so reading an unmoved ref needn't fetch.
const logs = new Map<string, GitCasLog<unknown>>();

const KEPT_CLAIMS_MS = 30_000;
const KEPT_BRANCH_HEAD_MS = 2_000;
// Cached tips expire even without a write, in case a write failed to clear them.
const KEPT_TIP_MS = 10_000;
const MAX_KEPT = 1_000_000;

/**
 * A view of a repo cached in its RepoCache, for reads that tolerate brief staleness. One caller rebuilds a stale or
 * missing view while the others use the old one or wait briefly, so a crowd reads the repo once. If the cache
 * fails, each caller reads the repo itself, slower but never wrong.
 */
export async function keptRead<T>(
	env: Env,
	repo: string,
	name: string,
	maxAgeMs: number,
	read: () => Promise<T>,
): Promise<T> {
	const cache = env.REPO_CACHE.getByName(`repo:${repo}`);
	const rebuild = async (writes: number) => {
		let value: T;
		try {
			value = await read();
		} catch (err) {
			await cache.buildFailed(name).catch(() => undefined);
			throw err;
		}
		// Cache it for the next callers if possible. Failing to cache doesn't fail this read.
		const json = JSON.stringify(value);
		await (json.length <= MAX_KEPT ? cache.keep(name, json, writes) : cache.buildFailed(name)).catch((err) =>
			console.error(`keeping ${name} of ${repo} failed`, String(err)),
		);
		return value;
	};
	// null means the cache didn't answer.
	const starting = () => cache.startBuild(name).catch(() => null);
	for (const until = Date.now() + 10_000; ;) {
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
		// Another caller is building the first view, so wait for it a few seconds at most.
		if (Date.now() > until) return read();
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

function recordsLog<S>(env: Env, repo: string, ref: string) {
	let log = logs.get(ref);
	if (!log) {
		// Record states other Worker instances already read, by tip, shared through the RepoCache.
		const cache = () => env.REPO_CACHE.getByName(`repo:${repo}`);
		const states = {
			get: (r: string, tip: string) => rpc(cache().recordAt(r, tip)),
			put: (r: string, tip: string, json: string) => cache().keepRecord(r, tip, json),
		};
		// Cached tips too, so a read needn't list refs on the busy project repo.
		const tips = {
			get: (r: string, stateKey: string) => rpc(cache().tipOf(r, stateKey, KEPT_TIP_MS)),
			keep: (r: string, tip: string | null, gen: number) => cache().keepTip(r, tip, gen),
			landed: (r: string, parent: string | null, tip: string) => cache().landedTip(r, parent, tip),
			stale: (r: string, parent: string | null) => cache().staleTip(r, parent),
		};
		logs.set(
			ref,
			(log = new GitCasLog<unknown>(
				() => cached(env, repo, `${repo}|write`, () => remoteFor(env.ARTIFACTS, repo, "write", 3600)),
				repo,
				ref,
				{ states, tips },
			)),
		);
	}
	return log as GitCasLog<S>;
}

// A record in records repo `k` rather than the project repo, cached like recordsLog's. Its tips are cached under
// the records repo's name, since the same ref may also exist in the project repo from before.
function recordsLogIn<S>(env: Env, repo: string, k: number, ref: string) {
	const key = `${recordsRepoName(repo, k)}:${ref}`;
	let log = logs.get(key);
	if (!log) {
		const cache = () => env.REPO_CACHE.getByName(`repo:${repo}`);
		const states = {
			get: (r: string, tip: string) => rpc(cache().recordAt(r, tip)),
			put: (r: string, tip: string, json: string) => cache().keepRecord(r, tip, json),
		};
		const tips = {
			get: (r: string, stateKey: string) => rpc(cache().tipOf(key, stateKey, KEPT_TIP_MS)),
			keep: (r: string, tip: string | null, gen: number) => cache().keepTip(key, tip, gen),
			landed: (r: string, parent: string | null, tip: string) => cache().landedTip(key, parent, tip),
			stale: (r: string, parent: string | null) => cache().staleTip(key, parent),
		};
		logs.set(
			key,
			(log = new GitCasLog<unknown>(
				() =>
					cached(env, repo, `${recordsRepoName(repo, k)}|write`, () =>
						remoteFor(env.ARTIFACTS, recordsRepoName(repo, k), "write", 3600),
					),
				repo,
				ref,
				{ states, tips },
			)),
		);
	}
	return log as GitCasLog<S>;
}

/** The tool context for one actor. `by` is its verified identity or a hosted agent's name, and stamps carry it. */
export function toolContextFor(
	env: Env,
	by: string | undefined,
	caller: {
		agentKey?: string;
		agent?: string;
		hosted?: boolean;
		teamsOf?: (repo: string) => Promise<string[]>;
		mayUseHosted?: () => Promise<boolean>;
	} = {},
): ToolContext {
	return {
		...caller,
		register: async (repo) => env.REPO_INDEX.getByName("all").addRepo(repo),
		summarize: (repo, patch) => env.REPO_INDEX.getByName("all").summarize(`repo:${repo}`, patch),
		ping: async (repo) => void (await env.REPO_CACHE?.getByName(`repo:${repo}`).ping("records")),
		// The repo's own Gate keeps its snapshot fresh (see Gate.warmUp); a batch's checks run in the batch's own Gates.
		warmChecks: async (repo, { expect, ...input }) => {
			const remote = await cached(env, repo, `${repo}|read`, () => remoteFor(env.ARTIFACTS, repo, "read", 3600));
			await env.GATE.getByName(`repo:${repo}`).warmUp({
				repo,
				...input,
				base: { remote: remote.url, token: remote.token },
				why: expect,
			});
		},
		// Claims for advice, cached so a busy repo isn't read whole on every call.
		keptClaims: (repo, read) => keptRead(env, repo, "claims-advice", KEPT_CLAIMS_MS, read),
		// Heads read from forks, plus those push events reported from the claim holders' forks (see push-events.ts).
		knownHeads: async (repo, claims) =>
			headsForClaims(
				await rpc(env.REPO_CACHE.getByName(`repo:${repo}`).knownHeads(claims.map((c) => c.change))),
				claims,
				(agent) => forkName(repo, agent),
			),
		noteHeads: (repo, seen, readAt) => env.REPO_CACHE.getByName(`repo:${repo}`).noteHeads(seen, readAt),
		news: (repo, branch, agent) => rpc(env.REPO_CACHE.getByName(`repo:${repo}`).landingNews(branch, agent)),
		// GitHive's GitHub App, when its ID and key are set. Repos connect to GitHub through it (see github.ts).
		...(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
			? {
					github: (repo: string) =>
						linkTo({ appId: env.GITHUB_APP_ID!, privateKey: env.GITHUB_APP_PRIVATE_KEY! }, repo),
				}
			: {}),
		// A branch's head, briefly cached for every merge watching it (see MergeInput.branchHead).
		branchHead: (repo, branch) =>
			keptRead(env, repo, `head:${branch}`, KEPT_BRANCH_HEAD_MS, () => headOf(env.ARTIFACTS, repo, branch)),
		// Make forks in the background before agents need them: the seeds when GitHive starts, an agent's when it
		// registers.
		prepareForks: async (repo, items) =>
			void (await env.REPO_CACHE?.getByName(`repo:${repo}`).queueForks(
				repo,
				items === "seeds" ? seedItems() : items.map((agent) => `agent:${agent}`),
			)),
		// Review holds live in one of the repo's records repos once it has them (see review-holds.ts), otherwise
		// beside the claims and votes.
		reviews: reviewHolds(async (repo) => {
			const spread = (await recordsLog<Registry>(env, repo, claimsRef(repo)).read())?.commit.state.recordsRepos ?? 0;
			return spread
				? recordsLogIn<ReviewHolds>(env, repo, reviewsRepoOf(spread), reviewsRef(repo))
				: recordsLog<ReviewHolds>(env, repo, reviewsRef(repo));
		}),
		requestReview: (input) => startHostedReviewers(env, input),
		startBuilder: (input) => startHostedBuilder(env, input),
		stamper: async (agent) =>
			env.STAMP_KEY && by ? makeStamper(env.STAMP_KEY, agent ? `${by}/${agent}` : by) : undefined,
		remote: (repo, scope) => cached(env, repo, `${repo}|${scope}`, () => remoteFor(env.ARTIFACTS, repo, scope, 3600)),
		changeRemote: (repo, agent, scope) =>
			cached(env, repo, `fork:${repo}:${agent}|${scope}`, () => changeRemote(env, repo, agent, scope, 3600)),
		legacyChangeRemote: (repo, change) =>
			cached(env, repo, `${changeRepoName(repo, change)}|read`, () =>
				remoteFor(env.ARTIFACTS, changeRepoName(repo, change), "read", 3600),
			),
		recordsRemote: (repo, k, scope) =>
			cached(env, repo, `${recordsRepoName(repo, k)}|${scope}`, () =>
				remoteFor(env.ARTIFACTS, recordsRepoName(repo, k), scope, 3600),
			),
		createRecordsRepos: async (repo, count) => {
			await Promise.all(
				Array.from({ length: count }, (_, k) =>
					ensureRepo(env.ARTIFACTS, recordsRepoName(repo, k), `Claim records for ${repo}`),
				),
			);
		},
		records: <S>(repo: string, ref: string) => recordsLog<S>(env, repo, ref),
		agentStatus: (repo, change, head, roles) => hostedAgentStatus(env, repo, change, head, roles),
		head: async (repo, branch) =>
			(await headOf(env.ARTIFACTS, repo, branch)) ?? fail(409, `${repo} has no ${branch} branch`),
		defaultBranch: async (repo) =>
			(await defaultBranch(await remoteFor(env.ARTIFACTS, repo, "read", 3600))) ?? fail(409, `${repo} has no commits`),
		// A batch's checks run on main with its changes merged in order, in Gates named for the batch and its place
		// in the bisection. Without a name they run in the last change's Gate.
		runChecks: (repo) => {
			const read = () => cached(env, repo, `${repo}|read`, () => remoteFor(env.ARTIFACTS, repo, "read", 3600));
			const fork = (agent: string) =>
				cached(env, repo, `fork:${repo}:${agent}|read`, () => changeRemote(env, repo, agent, "read", 3600));
			return async ({ base, branch, changes, commands, gate }) => {
				const remote = await read();
				const sourceOf = async (c: (typeof changes)[number]) => {
					const from = c.source ?? (await fork(c.agent));
					return { remote: from.url, token: from.token, ref: c.ref };
				};
				const last = changes.at(-1)!;
				const ahead = await Promise.all(
					changes.slice(0, -1).map(async (c) => ({ head: c.head, ...(await sourceOf(c)) })),
				);
				const forkOf = await sourceOf(last);
				const name = gate ? `repo:${repo}:check:${gate}` : `repo:${repo}:change:${last.change}`;
				const result = await rpcRetried(() =>
					env.GATE.getByName(name).checkCommit({
						repo,
						branch,
						base: { remote: remote.url, token: remote.token },
						fork: forkOf,
						head: last.head,
						checks: commands,
						baseHead: base,
						ahead,
					}),
				);
				const conflict = result.mergeConflict
					? [
							{
								command: "(merging the batch onto main)",
								exitCode: 1,
								output: `conflicts in ${result.mergeConflict.join(", ")}`,
							},
						]
					: [];
				return {
					passed: result.passed,
					results: [
						...conflict,
						...result.results.map((r) => ({ command: r.command, exitCode: r.exitCode, output: r.output })),
					],
				};
			};
		},
		// A branch's commits for the audit, read through the Artifacts API with each merge's files cached in the
		// RepoCache (see branch-history.ts).
		readBranch: (repo, baseline, branch) => {
			const cache = () => env.REPO_CACHE.getByName(`repo:${repo}`);
			// The cache is optional. Without it, each merge's files are worked out again.
			return withHistory(env.ARTIFACTS, repo, (source) =>
				readBranchHistory(source, baseline, branch, {
					get: (commits) => rpc(cache().keptFiles(commits)).catch(() => ({})),
					put: (files) =>
						cache()
							.keepFiles(files)
							.catch(() => undefined),
				}),
			);
		},
		// Any repo's history through the Artifacts API, used to read a batch's changes.
		history: (name, read) => withHistory(env.ARTIFACTS, name, read),
		// A branch's head in an agent's fork, from one Artifacts log call with no token or Git listing.
		forkHead: async (repo, agent, ref) => {
			const name = await forkName(repo, agent);
			try {
				return (await headOf(env.ARTIFACTS, name, ref)) ?? null;
			} catch (err) {
				if (/NOT_FOUND|not found/i.test(`${(err as { code?: string })?.code ?? ""} ${String(err)}`))
					throw new Error(`[409] ${agent} has no fork yet: nothing has been pushed`);
				throw err;
			}
		},
		// Start a batch's first check container while the batch is read (see MergeInput.prepareChecks).
		prepareChecks: (repo) => async (gate) => {
			const read = await cached(env, repo, `${repo}|read`, () => remoteFor(env.ARTIFACTS, repo, "read", 3600));
			await rpcRetried(() =>
				env.GATE.getByName(`repo:${repo}:check:${gate}`).boot({ repo, base: { remote: read.url, token: read.token } }),
			);
		},
		// Start the repo's own Gate while a batch is read, so landing finds it running (see MergeInput.prepareLanding).
		prepareLanding: async (repo) => {
			const read = await cached(env, repo, `${repo}|read`, () => remoteFor(env.ARTIFACTS, repo, "read", 3600));
			await rpcRetried(() =>
				env.GATE.getByName(`repo:${repo}`).boot({ repo, base: { remote: read.url, token: read.token } }),
			);
		},
		// A batch's Git work runs in the repo's own Gate container, which never runs a change's code (see BatchGit).
		batchGit: (repo) => {
			const gate = () => env.GATE.getByName(`repo:${repo}`);
			const project = (scope: "read" | "write") =>
				cached(env, repo, `${repo}|${scope}`, () => remoteFor(env.ARTIFACTS, repo, scope, 3600));
			const fork = (agent: string) =>
				cached(env, repo, `fork:${repo}:${agent}|read`, () => changeRemote(env, repo, agent, "read", 3600));
			const sourceOf = async (c: BatchSource) => {
				const from = c.source ?? (await fork(c.agent));
				return { change: c.change, remote: from.url, token: from.token, ref: c.ref };
			};
			return {
				inspect: async ({ base, branch, changes }) => {
					const read = await project("read");
					const sources = await Promise.all(changes.map(sourceOf));
					return rpcRetried(() =>
						gate().inspectBatch({
							repo,
							branch,
							base: { remote: read.url, token: read.token },
							baseHead: base,
							changes: sources,
						}),
					);
				},
				land: async ({ base, branch, merges, by }) => {
					const write = await project("write");
					const sources = await Promise.all(
						merges.map(async (m) => ({ ...(await sourceOf(m)), head: m.head, claimed: m.claimed })),
					);
					// Retry after a brief outage too. The push names the main it lands on, so a batch that already landed
					// finds main moved.
					const landed = await rpcRetried<{ commits: string[] } | { moved: true } | { error: string }>(() =>
						gate().landBatch({
							repo,
							branch,
							base: { remote: write.url, token: write.token },
							baseHead: base,
							merges: sources,
							...(by ? { by } : {}),
						}),
					);
					if ("moved" in landed) return "moved";
					if ("error" in landed) throw new Error(`[500] landing the batch failed: ${landed.error}`);
					return { commits: landed.commits };
				},
				checksBranch: async ({ base, branch, changes, to, ref }) => {
					const read = await project("read");
					const sources = await Promise.all(changes.map(async (c) => ({ ...(await sourceOf(c)), head: c.head })));
					return rpcRetried<{ tip: string } | { failed: string }>(() =>
						gate().checksBranch({
							repo,
							branch,
							base: { remote: read.url, token: read.token },
							baseHead: base,
							changes: sources,
							to: { remote: to.url, token: to.token, ...(to.user ? { user: to.user } : {}) },
							ref,
						}),
					);
				},
				pushBranch: async ({ branch, head, to }) => {
					const read = await project("read");
					const pushed = await rpcRetried<{ pushed: true } | { refused: string }>(() =>
						gate().pushBranch({
							repo,
							branch,
							base: { remote: read.url, token: read.token },
							head,
							to: { remote: to.url, token: to.token, ...(to.user ? { user: to.user } : {}) },
						}),
					);
					if ("refused" in pushed) throw new Error(`pushing ${branch} to ${to.url} was refused: ${pushed.refused}`);
				},
			};
		},
		// The landing lease is a record in the repo's first records repo (see landingLog). Outcomes are cached in the
		// RepoCache.
		landing: (repo, branch) => {
			const cache = () => env.REPO_CACHE.getByName(`repo:${repo}`);
			return gitLanding(landingLog(env, repo, branch), {
				drop: (holder) => rpcRetried(() => cache().dropLanding(branch, holder)),
				checking: (batch) => rpcRetried(() => cache().landingChecking(branch, batch)),
				settle: (outcomes) => rpcRetried(() => cache().landingSettled(branch, outcomes)),
				view: () => rpcRetried(() => cache().landingView(branch)),
			});
		},
	};
}

// Records repos made for landing leases, once per isolate.
const landingRepos = new Map<string, Promise<void>>();

/**
 * A branch's landing lease record, always in the repo's first records repo. It stays out of the busy project repo,
 * whose pushes it would queue behind, and never moves when claims shard, so no two merges read different leases.
 */
export function landingLog(env: Env, repo: string, branch: string) {
	return lazyLog(async () => {
		const name = recordsRepoName(repo, LANDING_RECORDS_REPO);
		let made = landingRepos.get(name);
		if (!made)
			landingRepos.set(
				name,
				(made = ensureRepo(env.ARTIFACTS, name, `Claim records for ${repo}`).catch(
					(err) => (landingRepos.delete(name), Promise.reject(err)),
				)),
			);
		await made;
		return recordsLogIn<LeaseRecord>(env, repo, LANDING_RECORDS_REPO, landingRef(repo, branch));
	});
}

const claimsRef = (repo: string) => `refs/notes/githive-claims/${repo}`;
/** The base name for a change's hosted agents: one builder, and one reviewer per role and commit. */
export const changeRepoName = (repo: string, change: string) => `fork--${repo}--${change}`;

/**
 * An agent's fork of a project repo, holding a branch per change. A short hash is added when the agent's name had to
 * be sanitized, so two names never share a fork.
 */
export async function forkName(repo: string, agent: string) {
	const slug =
		agent
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "agent";
	if (slug === agent) return `fork--${repo}--agent--${slug}`;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(agent)));
	return `fork--${repo}--agent--${slug}-${[...digest.slice(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * How many seed forks agents' forks are copied from. A crowd forking the project repo at once overloads it, so the
 * seeds are made one at a time in the background when GitHive starts on the project (see RepoCache's fork queue).
 */
export const FORK_SEEDS = 8;
export const seedName = (repo: string, k: number) => `fork--${repo}--seed--${k}`;

// The seed an agent's fork prefers, by a stable hash of its name.
function seedOf(agent: string) {
	let h = 0x811c9dc5;
	for (let i = 0; i < agent.length; i++) h = Math.imul(h ^ agent.charCodeAt(i), 0x01000193);
	return (h >>> 0) % FORK_SEEDS;
}

/** Fork-queue items for all of a repo's seeds. */
export const seedItems = () => Array.from({ length: FORK_SEEDS }, (_, k) => `seed:${k}`);

/** Makes seed `k` of `repo` from the project repo, or waits for it if it's being made. */
export async function makeSeed(env: Env, repo: string, k: number) {
	const name = seedName(repo, k);
	await remoteFor(env.ARTIFACTS, name, "read", 60).catch(() =>
		forkAndWait(env.ARTIFACTS, repo, name, `seed ${k} for forks of ${repo}`, { shared: true }),
	);
}

/**
 * Makes an agent's fork of `repo`, or waits if it's already being made. Tries the agent's own seed, then any ready
 * seed, then the project itself, moving on when a source's fork fails.
 */
export async function makeAgentFork(env: Env, repo: string, agent: string) {
	const name = await forkName(repo, agent);
	if (
		await remoteFor(env.ARTIFACTS, name, "read", 60).then(
			() => true,
			() => false,
		)
	)
		return;
	const cache = env.REPO_CACHE?.getByName(`repo:${repo}`);
	const ready = (cache ? await rpc(cache.readySeeds()).catch(() => [] as number[]) : []) ?? [];
	if (!ready.length) await cache?.queueForks(repo, seedItems()).catch(() => undefined);
	const own = seedOf(agent);
	const seeds = [...ready]
		.sort((a, b) => ((a - own + FORK_SEEDS) % FORK_SEEDS) - ((b - own + FORK_SEEDS) % FORK_SEEDS))
		.map((k) => seedName(repo, k));
	let failure: unknown;
	for (const source of [...seeds, repo]) {
		try {
			await forkAndWait(env.ARTIFACTS, source, name, `${agent}'s fork of ${repo}`, { shared: true });
			return;
		} catch (err) {
			// Requested but not ready in time. Another source would only wait on the same fork, so ask the caller to retry.
			if (isForkNotReady(err))
				throw new Error(`[503] ${agent}'s fork of ${repo} is still being made: call again in a minute`);
			failure = err;
		}
	}
	throw failure;
}

/** Credentials for an agent's own fork. The first write creates the fork, which all its changes share. */
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
	const { claims } = await claimStore({
		repo,
		registry,
		root,
		remote: async () => read,
		recordsRemote: (k) => remoteFor(env.ARTIFACTS, recordsRepoName(repo, k), "read", 3 * 3600),
	}).read();
	const own = claims.find((c) => c.change === change);
	return {
		read,
		own,
		branch: projectBranch(registry),
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
 * Starts GitHive's hosted reviewers on a change's head, reviewed against where it left main. With
 * `mergeWhenApproved` each reviewer tries to merge after voting, and the toolkit refuses until the approvals are in.
 */
export async function startHostedReviewers(
	env: Env,
	input: { repo: string; change: string; roles?: string[]; summary?: string; mergeWhenApproved?: boolean },
) {
	const { repo, change } = input;
	const ref = `changes/${change}`;
	const { read, own, policy, job, source, branch } = await changeBrief(env, repo, change);
	// By default a general review, and every role that can veto a change to its claim's paths.
	const roles = input.roles?.length ? input.roles : hostedRoles(effectivePolicy(policy, own?.paths ?? []).vetoes);
	const from = await source("read");
	const ws = await Workspace.clone(read, branch);
	const head = await ws.fetch("change", from, ref);
	const baseCommit = await ws.mergeBase(await ws.head(), head);
	const review = {
		...job,
		remote: from.url,
		token: from.token,
		head,
		baseCommit,
		buildSummary: input.summary,
		mergeWhenApproved: !!input.mergeWhenApproved,
	};
	await Promise.all(
		roles.map((role) =>
			env.REVIEWER.getByName(reviewerName(changeRepoName(repo, change), role, head)).start({ ...review, role }),
		),
	);
	return { head, reviewers: roles };
}

/** Starts GitHive's hosted builder on a claimed change, working on changes/<change> in the change's fork. */
export async function startHostedBuilder(env: Env, input: { repo: string; change: string }) {
	const { repo, change } = input;
	const { read, own, job, source } = await changeBrief(env, repo, change);
	const write = await source("write");
	const build = { ...job, remote: write.url, token: write.token, base: { remote: read.url, token: read.token } };
	await env.BUILDER.getByName(changeRepoName(repo, change)).start(build);
	return { change, builder: changeRepoName(repo, change) };
}

/** Fresh credentials to resume the hosted builder: its fork to push to, and the project's main to merge from. */
export async function builderCredentials(env: Env, repo: string, change: string) {
	const { read, source } = await changeBrief(env, repo, change);
	const write = await source("write");
	return { token: write.token, base: { remote: read.url, token: read.token } };
}

/** What GitHive's hosted agents on a change are doing: its builder, if any, and each role's reviewer of `head`. */
export async function hostedAgentStatus(
	env: Env,
	repo: string,
	change: string,
	head: string | null,
	roles: string[],
): Promise<HostedStatus> {
	const name = changeRepoName(repo, change);
	const [builder, reviewers] = await Promise.all([
		rpc(env.BUILDER.getByName(name).state()),
		head
			? Promise.all(
					roles.map(async (role) => ({
						role,
						state: await rpc(env.REVIEWER.getByName(reviewerName(name, role, head)).state()),
					})),
				)
			: [],
	]);
	return {
		...(builder
			? {
					builder: {
						status: builder.status,
						revisions: builder.revisions,
						...(builder.error ? { error: builder.error } : {}),
					},
				}
			: {}),
		reviewers: reviewers.flatMap(({ role, state }) =>
			state ? [{ role, status: state.status, ...(state.verdict ? { verdict: state.verdict } : {}) }] : [],
		),
	};
}
