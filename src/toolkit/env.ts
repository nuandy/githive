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
import { holdsRef, holdsRepoOf, type ReviewHolds, reviewHolds, reviewsRef, reviewsRepoOf } from "./review-holds";
import type { Registry } from "./claims";
import type { ToolContext, HostedStatus } from "./mcp";
import type { BatchGit, BatchSource, CheckRunner } from "./merge";
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
	return cachedLog<S>(env, repo, { key: ref, ref, holder: repo });
}

// A record in records repo `index` rather than the project repo, cached like recordsLog's. Its tips are cached
// under the records repo's name, since the same ref may also exist in the project repo from before.
function recordsLogIn<S>(env: Env, repo: string, index: number, ref: string) {
	const holder = recordsRepoName(repo, index);
	const key = `${holder}:${ref}`;
	return cachedLog<S>(env, repo, { key, ref, holder, tipsKey: key });
}

// The isolate's log for `ref` in the `holder` repo, made on first use. Its tips are cached under `tipsKey`, or
// under the ref each call names.
function cachedLog<S>(env: Env, repo: string, at: { key: string; ref: string; holder: string; tipsKey?: string }) {
	let log = logs.get(at.key);
	if (!log) {
		const cache = () => env.REPO_CACHE.getByName(`repo:${repo}`);
		// Record states other Worker instances already read, by tip, shared through the RepoCache.
		const states = {
			get: (recordRef: string, tip: string) => rpc(cache().recordAt(recordRef, tip)),
			put: (recordRef: string, tip: string, json: string) => cache().keepRecord(recordRef, tip, json),
		};
		// Cached tips too, so a read needn't list refs on the busy project repo.
		const tipsKey = (recordRef: string) => at.tipsKey ?? recordRef;
		const tips = {
			get: (recordRef: string, stateKey: string) => rpc(cache().tipOf(tipsKey(recordRef), stateKey, KEPT_TIP_MS)),
			keep: (recordRef: string, tip: string | null, gen: number) => cache().keepTip(tipsKey(recordRef), tip, gen),
			landed: (recordRef: string, parent: string | null, tip: string) =>
				cache().landedTip(tipsKey(recordRef), parent, tip),
			stale: (recordRef: string, parent: string | null) => cache().staleTip(tipsKey(recordRef), parent),
		};
		const writeRemote = () =>
			cached(env, repo, `${at.holder}|write`, () => remoteFor(env.ARTIFACTS, at.holder, "write", 3600));
		log = new GitCasLog<unknown>(writeRemote, repo, at.ref, { states, tips });
		logs.set(at.key, log);
	}
	return log as GitCasLog<S>;
}

// Credentials for a project repo, and for an agent's fork of it, cached (see cached).
const projectRemote = (env: Env, repo: string, scope: "read" | "write") =>
	cached(env, repo, `${repo}|${scope}`, () => remoteFor(env.ARTIFACTS, repo, scope, 3600));
const forkRemote = (env: Env, repo: string, agent: string, scope: "read" | "write") =>
	cached(env, repo, `fork:${repo}:${agent}|${scope}`, () => changeRemote(env, repo, agent, scope, 3600));

// GitHive's GitHub App, when its ID and key are set. Repos connect to GitHub through it (see github.ts).
function githubApp(env: Env): Pick<ToolContext, "github"> {
	const appId = env.GITHUB_APP_ID;
	const privateKey = env.GITHUB_APP_PRIVATE_KEY;
	if (!appId || !privateKey) return {};
	return { github: (repo: string) => linkTo({ appId, privateKey }, repo) };
}

// Starts the Gate called `name`, on the repo's branch, before it's needed.
async function bootGate(env: Env, repo: string, name: string) {
	const read = await projectRemote(env, repo, "read");
	await rpcRetried(() => env.GATE.getByName(name).boot({ repo, base: { remote: read.url, token: read.token } }));
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
		...repoCacheParts(env),
		...artifactsParts(env),
		...gateParts(env),
		...hostedParts(env),
		...githubApp(env),
		stamper: async (agent) => {
			if (!env.STAMP_KEY || !by) return undefined;
			return makeStamper(env.STAMP_KEY, agent ? `${by}/${agent}` : by);
		},
	};
}

/** The repo's index entry and its RepoCache: summaries, cached reads, known heads and the fork queue. */
function repoCacheParts(env: Env) {
	return {
		register: async (repo) => env.REPO_INDEX.getByName("all").addRepo(repo),
		summarize: (repo, patch) => env.REPO_INDEX.getByName("all").summarize(`repo:${repo}`, patch),
		ping: async (repo) => void (await env.REPO_CACHE?.getByName(`repo:${repo}`).ping("records")),
		// Claims for advice, cached so a busy repo isn't read whole on every call.
		keptClaims: (repo, read) => keptRead(env, repo, "claims-advice", KEPT_CLAIMS_MS, read),
		// Heads read from forks, plus those push events reported from the claim holders' forks (see push-events.ts).
		knownHeads: async (repo, claims) =>
			headsForClaims(
				await rpc(env.REPO_CACHE.getByName(`repo:${repo}`).knownHeads(claims.map((claim) => claim.change))),
				claims,
				(agent) => forkName(repo, agent),
			),
		noteHeads: (repo, headsRead, readAt) => env.REPO_CACHE.getByName(`repo:${repo}`).noteHeads(headsRead, readAt),
		mergeChecks: {
			kept: (repo, change) => rpc(env.REPO_CACHE.getByName(`repo:${repo}`).keptMergeCheck(change)),
			keep: (repo, change, kept) => env.REPO_CACHE.getByName(`repo:${repo}`).keepMergeCheck(change, kept),
		},
		news: (repo, branch, agent) => rpc(env.REPO_CACHE.getByName(`repo:${repo}`).landingNews(branch, agent)),
		// A branch's head, briefly cached for every merge watching it (see MergeInput.branchHead).
		branchHead: (repo, branch) =>
			keptRead(
				env,
				repo,
				`head:${branch}`,
				KEPT_BRANCH_HEAD_MS,
				async () => (await headOf(env.ARTIFACTS, repo, branch)) ?? null,
			),
		// Make forks in the background before agents need them: the seeds when GitHive starts, an agent's when it
		// registers.
		prepareForks: async (repo, items) =>
			void (await env.REPO_CACHE?.getByName(`repo:${repo}`).queueForks(
				repo,
				items === "seeds" ? seedItems() : items.map((agent) => `agent:${agent}`),
			)),
	} satisfies Partial<ToolContext>;
}

/** Credentials for the project, its forks and records repos, and reads through Artifacts' API. */
function artifactsParts(env: Env) {
	return {
		remote: (repo, scope) => projectRemote(env, repo, scope),
		changeRemote: (repo, agent, scope) => forkRemote(env, repo, agent, scope),
		legacyChangeRemote: (repo, change) =>
			cached(env, repo, `${changeRepoName(repo, change)}|read`, () =>
				remoteFor(env.ARTIFACTS, changeRepoName(repo, change), "read", 3600),
			),
		recordsRemote: (repo, index, scope) =>
			cached(env, repo, `${recordsRepoName(repo, index)}|${scope}`, () =>
				remoteFor(env.ARTIFACTS, recordsRepoName(repo, index), scope, 3600),
			),
		createRecordsRepos: async (repo, count) => {
			await Promise.all(
				Array.from({ length: count }, (_, index) =>
					ensureRepo(env.ARTIFACTS, recordsRepoName(repo, index), `Claim records for ${repo}`),
				),
			);
		},
		records: <S>(repo: string, ref: string) => recordsLog<S>(env, repo, ref),
		head: async (repo, branch) =>
			(await headOf(env.ARTIFACTS, repo, branch)) ?? fail(409, `${repo} has no ${branch} branch`),
		defaultBranch: async (repo) =>
			(await defaultBranch(await remoteFor(env.ARTIFACTS, repo, "read", 3600))) ?? fail(409, `${repo} has no commits`),
		// A branch's commits for the audit, read through the Artifacts API with each merge's files cached in the
		// RepoCache (see branch-history.ts).
		readBranch: (repo, baseline, branch) => readBranchCommits(env, repo, baseline, branch),
		// Any repo's history through the Artifacts API, used to read a batch's changes.
		history: (name, read) => withHistory(env.ARTIFACTS, name, read),
		// A branch's head in an agent's fork, from one Artifacts log call with no token or Git listing.
		forkHead: (repo, agent, ref) => forkHead(env, repo, agent, ref),
	} satisfies Partial<ToolContext>;
}

/** The Gate containers that check and land batches, and the landing lease that orders them. */
function gateParts(env: Env) {
	return {
		// The repo's own Gate keeps its snapshot fresh (see Gate.warmUp); a batch's checks run in the batch's own Gates.
		warmChecks: async (repo, { expect, ...input }) => {
			const remote = await projectRemote(env, repo, "read");
			await env.GATE.getByName(`repo:${repo}`).warmUp({
				repo,
				...input,
				base: { remote: remote.url, token: remote.token },
				why: expect,
			});
		},
		// A batch's checks run on main with its changes merged in order, in Gates named for the batch and its place
		// in the bisection. Without a name they run in the last change's Gate.
		runChecks: (repo) => checksRunner(env, repo),
		// Start a batch's first check container while the batch is read (see MergeInput.prepareChecks).
		prepareChecks: (repo) => (gate) => bootGate(env, repo, `repo:${repo}:check:${gate}`),
		// Start the repo's own Gate while a batch is read, so landing finds it running (see MergeInput.prepareLanding).
		prepareLanding: (repo) => bootGate(env, repo, `repo:${repo}`),
		// A batch's Git work runs in the repo's own Gate container, which never runs a change's code (see BatchGit).
		batchGit: (repo) => batchGitFor(env, repo),
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
	} satisfies Partial<ToolContext>;
}

/** GitHive's hosted reviewers and builder, and the review holds they share with agents. */
function hostedParts(env: Env) {
	return {
		// Review holds live in one of the repo's records repos once it has them (see review-holds.ts), otherwise
		// beside the claims and votes.
		reviews: reviewHolds({
			waits: (repo) => reviewsLog(env, repo),
			holds: (repo, bucket) => holdsLog(env, repo, bucket),
		}),
		requestReview: (input) => startHostedReviewers(env, input),
		startBuilder: (input) => startHostedBuilder(env, input),
		agentStatus: (repo, change, head, roles) => hostedAgentStatus(env, repo, change, head, roles),
	} satisfies Partial<ToolContext>;
}

async function reviewsLog(env: Env, repo: string) {
	const registry = (await recordsLog<Registry>(env, repo, claimsRef(repo)).read())?.commit.state;
	const spread = registry?.recordsRepos ?? 0;
	return spread
		? recordsLogIn<ReviewHolds>(env, repo, reviewsRepoOf(spread), reviewsRef(repo))
		: recordsLog<ReviewHolds>(env, repo, reviewsRef(repo));
}

/** One bucket of a repo's review holds: in one of its records repos once it has them, else beside the claims. */
async function holdsLog(env: Env, repo: string, bucket: string) {
	const registry = (await recordsLog<Registry>(env, repo, claimsRef(repo)).read())?.commit.state;
	const spread = registry?.recordsRepos ?? 0;
	return spread
		? recordsLogIn<ReviewHolds>(env, repo, holdsRepoOf(bucket, spread), holdsRef(repo, bucket))
		: recordsLog<ReviewHolds>(env, repo, holdsRef(repo, bucket));
}

function checksRunner(env: Env, repo: string): CheckRunner {
	return async ({ base, branch, changes, commands, gate }) => {
		const remote = await projectRemote(env, repo, "read");
		const sourceOf = async (entry: (typeof changes)[number]) => {
			const from = entry.source ?? (await forkRemote(env, repo, entry.agent, "read"));
			return { remote: from.url, token: from.token, ref: entry.ref };
		};
		const last = changes.at(-1)!;
		const ahead = await Promise.all(
			changes.slice(0, -1).map(async (entry) => ({ head: entry.head, ...(await sourceOf(entry)) })),
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
		const checks = result.results.map((check) => ({
			command: check.command,
			exitCode: check.exitCode,
			output: check.output,
		}));
		return { passed: result.passed, results: [...conflict, ...checks] };
	};
}

function readBranchCommits(env: Env, repo: string, baseline: string, branch: string) {
	const cache = () => env.REPO_CACHE.getByName(`repo:${repo}`);
	// The cache is optional. Without it, each merge's files are worked out again.
	const kept = {
		get: (commits: string[]) => rpc(cache().keptFiles(commits)).catch(() => ({})),
		put: (files: Record<string, string[]>) =>
			cache()
				.keepFiles(files)
				.catch(() => undefined),
	};
	return withHistory(env.ARTIFACTS, repo, (source) => readBranchHistory(source, baseline, branch, kept));
}

async function forkHead(env: Env, repo: string, agent: string, ref: string) {
	const name = await forkName(repo, agent);
	try {
		return (await headOf(env.ARTIFACTS, name, ref)) ?? null;
	} catch (err) {
		if (/NOT_FOUND|not found/i.test(`${(err as { code?: string })?.code ?? ""} ${String(err)}`))
			fail(409, `${agent} has no fork yet: nothing has been pushed`);
		throw err;
	}
}

function batchGitFor(env: Env, repo: string): BatchGit {
	const gate = () => env.GATE.getByName(`repo:${repo}`);
	const project = (scope: "read" | "write") => projectRemote(env, repo, scope);
	const sourceOf = async (entry: BatchSource) => {
		const from = entry.source ?? (await forkRemote(env, repo, entry.agent, "read"));
		return { change: entry.change, remote: from.url, token: from.token, ref: entry.ref };
	};
	const pushTarget = (to: Remote) => ({ remote: to.url, token: to.token, ...(to.user ? { user: to.user } : {}) });
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
				merges.map(async (merge) => ({ ...(await sourceOf(merge)), head: merge.head, claimed: merge.claimed })),
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
			if ("error" in landed) fail(500, `landing the batch failed: ${landed.error}`);
			return { commits: landed.commits };
		},
		checksBranch: async ({ base, branch, changes, to, ref }) => {
			const read = await project("read");
			const sources = await Promise.all(
				changes.map(async (entry) => ({ ...(await sourceOf(entry)), head: entry.head })),
			);
			return rpcRetried<{ tip: string } | { failed: string }>(() =>
				gate().checksBranch({
					repo,
					branch,
					base: { remote: read.url, token: read.token },
					baseHead: base,
					changes: sources,
					to: pushTarget(to),
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
					to: pushTarget(to),
				}),
			);
			if ("refused" in pushed) throw new Error(`pushing ${branch} to ${to.url} was refused: ${pushed.refused}`);
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
		if (!made) {
			made = ensureRepo(env.ARTIFACTS, name, `Claim records for ${repo}`).catch((err) => {
				landingRepos.delete(name);
				return Promise.reject(err);
			});
			landingRepos.set(name, made);
		}
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
	const hash = [...digest.slice(0, 3)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `fork--${repo}--agent--${slug}-${hash}`;
}

/**
 * How many seed forks agents' forks are copied from. A crowd forking the project repo at once overloads it, so the
 * seeds are made one at a time in the background when GitHive starts on the project (see RepoCache's fork queue).
 */
export const FORK_SEEDS = 8;
export const seedName = (repo: string, index: number) => `fork--${repo}--seed--${index}`;

// The seed an agent's fork prefers, by a stable hash of its name.
function seedOf(agent: string) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < agent.length; i++) hash = Math.imul(hash ^ agent.charCodeAt(i), 0x01000193);
	return (hash >>> 0) % FORK_SEEDS;
}

/** Fork-queue items for all of a repo's seeds. */
export const seedItems = () => Array.from({ length: FORK_SEEDS }, (_, index) => `seed:${index}`);

/** Makes seed `index` of `repo` from the project repo, or waits for it if it's being made. */
export async function makeSeed(env: Env, repo: string, index: number) {
	const name = seedName(repo, index);
	await remoteFor(env.ARTIFACTS, name, "read", 60).catch(() =>
		forkAndWait(env.ARTIFACTS, repo, name, `seed ${index} for forks of ${repo}`, { shared: true }),
	);
}

/**
 * Makes an agent's fork of `repo`, or waits if it's already being made. Tries the agent's own seed, then any ready
 * seed, then the project itself, moving on when a source's fork fails.
 */
export async function makeAgentFork(env: Env, repo: string, agent: string) {
	const name = await forkName(repo, agent);
	const exists = await remoteFor(env.ARTIFACTS, name, "read", 60).then(
		() => true,
		() => false,
	);
	if (exists) return;
	const cache = env.REPO_CACHE?.getByName(`repo:${repo}`);
	const ready = (cache ? await rpc(cache.readySeeds()).catch(() => [] as number[]) : []) ?? [];
	if (!ready.length) await cache?.queueForks(repo, seedItems()).catch(() => undefined);
	const own = seedOf(agent);
	// Ready seeds in order from the agent's own, wrapping around.
	const distance = (seed: number) => (seed - own + FORK_SEEDS) % FORK_SEEDS;
	const seeds = [...ready].sort((a, b) => distance(a) - distance(b)).map((seed) => seedName(repo, seed));
	let failure: unknown;
	for (const source of [...seeds, repo]) {
		try {
			await forkAndWait(env.ARTIFACTS, source, name, `${agent}'s fork of ${repo}`, { shared: true });
			return;
		} catch (err) {
			// Requested but not ready in time. Another source would only wait on the same fork, so ask the caller to retry.
			if (isForkNotReady(err)) fail(503, `${agent}'s fork of ${repo} is still being made: call again in a minute`);
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
		if (scope === "read") fail(409, `${agent} has no fork yet: nothing has been pushed`);
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
		recordsRemote: (index) => remoteFor(env.ARTIFACTS, recordsRepoName(repo, index), "read", 3 * 3600),
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
	const workspace = await Workspace.clone(read, branch);
	const head = await workspace.fetch("change", from, ref);
	const baseCommit = await workspace.mergeBase(await workspace.head(), head);
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
	const reviewerStatus = reviewers.flatMap(({ role, state }) => {
		if (!state) return [];
		return [{ role, status: state.status, ...(state.verdict ? { verdict: state.verdict } : {}) }];
	});
	if (!builder) return { reviewers: reviewerStatus };
	const builderStatus: HostedStatus["builder"] = { status: builder.status, revisions: builder.revisions };
	if (builder.error) builderStatus.error = builder.error;
	return { builder: builderStatus, reviewers: reviewerStatus };
}
