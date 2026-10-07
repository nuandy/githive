import { DEFAULT_POLICY, hostedFreeRoles } from "./mcp";
import { effectiveFreePolicy } from "./votes";
import { ensureRepo, forkAndWait, headOf, remoteFor, reviewerName } from "../artifacts";
import { GitCasLog } from "../election-git";
import { fail } from "../errors";
import { defaultBranch, type Remote, Workspace } from "../git";
import { projectBranch } from "../project-branch";
import { claimStore } from "./claim-store";
import type { Registry } from "./claims";
import type { FreeContext, HostedStatus } from "./mcp";
import { recordsRepoName } from "./shards";
import { makeStamper } from "./stamp";

// Coordinator-free mode wired to Cloudflare: Artifacts for Git, the Gate's
// container for checks, the task index for the dashboard, Blueprint's hosted
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
	const kept = await store?.get(key).catch(() => null);
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

/**
 * The coordinator-free context for one actor: `by` is who it is (as Access
 * verified them, or a hosted agent's own name), and stamps carry it, with the
 * agent name its key is for. Hosted agents (`hosted`) act under blueprint- names.
 */
export function freeContextFor(env: Env, by: string | undefined, caller: { agentKey?: string; hosted?: boolean } = {}): FreeContext {
	return {
		...caller,
		register: async (repo) => env.TASK_INDEX.getByName("all").addFree(repo),
		summarize: (repo, patch) => env.TASK_INDEX.getByName("all").summarize(`free:${repo}`, patch),
		ping: async (repo) => void (await env.LIVE?.getByName(`free:${repo}`).ping("records")),
		reviews: {
			held: (repo) => env.LIVE.getByName(`free:${repo}`).reviewsHeld(),
			hold: (repo, head, agent, needed) => env.LIVE.getByName(`free:${repo}`).holdReview(head, agent, needed),
			release: (repo, head, agent) => env.LIVE.getByName(`free:${repo}`).releaseReview(head, agent),
		},
		requestReview: (input) => startFreeReviewers(env, input),
		startBuilder: (input) => startFreeBuilder(env, input),
		stamper: async (agent) => (env.FREE_STAMP_KEY && by ? makeStamper(env.FREE_STAMP_KEY, agent ? `${by}/${agent}` : by) : undefined),
		remote: (repo, scope) => cached(env, repo, `${repo}|${scope}`, () => remoteFor(env.ARTIFACTS, repo, scope, 3600)),
		changeRemote: (repo, agent, scope) => cached(env, repo, `fork:${repo}:${agent}|${scope}`, () => changeRemote(env, repo, agent, scope, 3600)),
		legacyChangeRemote: (repo, change) => cached(env, repo, `${freeAgentName(repo, change)}|read`, () => remoteFor(env.ARTIFACTS, freeAgentName(repo, change), "read", 3600)),
		recordsRemote: (repo, k, scope) => cached(env, repo, `${recordsRepoName(repo, k)}|${scope}`, () => remoteFor(env.ARTIFACTS, recordsRepoName(repo, k), scope, 3600)),
		createRecordsRepos: async (repo, count) => {
			await Promise.all(Array.from({ length: count }, (_, k) => ensureRepo(env.ARTIFACTS, recordsRepoName(repo, k), `Coordinator-free claim records for ${repo}`)));
		},
		records: <S>(repo: string, ref: string) => {
			let log = logs.get(ref);
			if (!log) logs.set(ref, (log = new GitCasLog<unknown>(() => cached(env, repo, `${repo}|write`, () => remoteFor(env.ARTIFACTS, repo, "write", 3600)), repo, ref)));
			return log as GitCasLog<S>;
		},
		agentStatus: (repo, change, head, roles) => freeAgentStatus(env, repo, change, head, roles),
		head: async (repo, branch) => (await headOf(env.ARTIFACTS, repo, branch)) ?? fail(409, `${repo} has no ${branch} branch`),
		defaultBranch: async (repo) => (await defaultBranch(await remoteFor(env.ARTIFACTS, repo, "read", 3600))) ?? fail(409, `${repo} has no commits`),
		// Checks run in the repo's line of merges (see check-line.ts): its Gate and the Gates beside it, each with a container.
		runChecks: (repo) => async ({ change, branch, head, ref, commands, source }) => {
			const remote = await remoteFor(env.ARTIFACTS, repo, "read", 3600);
			const fork = source ?? remote;
			const { result, base, after } = await env.GATE.getByName(`free:${repo}`).checkInLine({ repo, change, branch, base: { remote: remote.url, token: remote.token }, fork: { remote: fork.url, token: fork.token, ref }, head, checks: commands });
			const conflict = result.mergeConflict ? [{ command: "(merging onto main and the merges ahead in line)", exitCode: 1, output: `conflicts in ${result.mergeConflict.join(", ")}` }] : [];
			return {
				passed: result.passed,
				results: [...conflict, ...result.results.map((r) => ({ command: r.command, exitCode: r.exitCode, output: r.output }))],
				base,
				after,
				done: () => env.GATE.getByName(`free:${repo}`).lineDone(change),
			};
		},
	};
}

const claimsRef = (repo: string) => `refs/notes/blueprint-claims/${repo}`;
/** A change's hosted agents' Durable Object names: one builder, one reviewer per role and commit. */
export const freeAgentName = (repo: string, change: string) => `free--${repo}--${change}`;

/**
 * An agent's fork of a project repo: one per agent, holding a branch per
 * change. Its name follows the agent's (lowercase, safe characters), with a
 * short hash of the real name when those differ, so two names never share one.
 */
export async function freeForkName(repo: string, agent: string) {
	const slug = agent.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";
	if (slug === agent) return `free--${repo}--agent--${slug}`;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(agent)));
	return `free--${repo}--agent--${slug}-${[...digest.slice(0, 3)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Credentials for an agent's own fork of the project repo; writing to it first creates the fork (once, for all its changes). */
export async function changeRemote(env: Env, repo: string, agent: string, scope: "read" | "write", ttlSeconds: number) {
	const name = await freeForkName(repo, agent);
	try {
		return await remoteFor(env.ARTIFACTS, name, scope, ttlSeconds);
	} catch (err) {
		if (scope === "read") throw new Error(`[409] ${agent} has no fork yet: nothing has been pushed`);
		await forkAndWait(env.ARTIFACTS, repo, name, `${agent}'s fork of ${repo} (coordinator-free)`);
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
		source: (scope: "read" | "write") => changeRemote(env, repo, own?.agent ?? "blueprint-builder", scope, 3 * 3600),
		policy: registry?.policy ?? DEFAULT_POLICY,
		job: {
			taskId: `free:${repo}`,
			branch: projectBranch(registry),
			repo: freeAgentName(repo, change),
			goal: own?.intent ?? change,
			verify: registry?.verify ?? [],
			slice: { id: change, title: change, owns: own?.paths ?? [], instructions: own?.intent ?? "", tests: [] },
			siblings: claims.filter((c) => c.change !== change).map((c) => ({ id: c.change, title: c.change, owns: c.paths })),
		},
	};
}

/**
 * Start Blueprint's hosted reviewers on a coordinator-free change: its branch
 * head, reviewed against where it left main, with its claim as the brief. Each
 * reviewer votes with free_vote when it's done; with `mergeWhenApproved`, it
 * then tries to merge the change, which the toolkit refuses until the approvals
 * are in, so the last vote's attempt is the one that lands.
 */
export async function startFreeReviewers(env: Env, input: { repo: string; change: string; roles?: string[]; summary?: string; mergeWhenApproved?: boolean }) {
	const { repo, change } = input;
	const ref = `changes/${change}`;
	const { read, own, policy, job, source, branch } = await changeBrief(env, repo, change);
	// By default a general review, and every role that can veto a change to its claim's paths.
	const roles = input.roles?.length ? input.roles : hostedFreeRoles(effectiveFreePolicy(policy, own?.paths ?? []).vetoes);
	const from = await source("read");
	const ws = await Workspace.clone(read, branch);
	const head = await ws.fetch("change", from, ref);
	const baseCommit = await ws.mergeBase(await ws.head(), head);
	const review = { ...job, remote: from.url, token: from.token, head, baseCommit, buildSummary: input.summary, free: { repo, change, ref, agent: own?.agent ?? change, mergeWhenApproved: !!input.mergeWhenApproved } };
	await Promise.all(roles.map((role) => env.REVIEWER.getByName(reviewerName(freeAgentName(repo, change), role, head)).start({ ...review, role })));
	return { head, reviewers: roles };
}

/** Start Blueprint's hosted builder on a claimed coordinator-free change: it works on the branch changes/<change> in the change's own fork. */
export async function startFreeBuilder(env: Env, input: { repo: string; change: string }) {
	const { repo, change } = input;
	const { read, own, job, source } = await changeBrief(env, repo, change);
	const write = await source("write");
	const build = { ...job, remote: write.url, token: write.token, base: { remote: read.url, token: read.token }, free: { repo, change, ref: `changes/${change}`, agent: own?.agent ?? change } };
	await env.BUILDER.getByName(freeAgentName(repo, change)).start(build);
	return { change, builder: freeAgentName(repo, change) };
}

/** Fresh credentials to resume Blueprint's hosted builder on a change: its branch's home to push to, the project's main to merge from. */
export async function freeBuilderCredentials(env: Env, repo: string, change: string) {
	const { read, source } = await changeBrief(env, repo, change);
	const write = await source("write");
	return { token: write.token, base: { remote: read.url, token: read.token } };
}

/** What Blueprint's hosted agents on a change are doing: its builder, if it has one, and each role's reviewer of `head`. */
export async function freeAgentStatus(env: Env, repo: string, change: string, head: string | null, roles: string[]): Promise<HostedStatus> {
	const name = freeAgentName(repo, change);
	const [builder, reviewers] = await Promise.all([
		env.BUILDER.getByName(name).state(),
		head ? Promise.all(roles.map(async (role) => ({ role, state: await env.REVIEWER.getByName(reviewerName(name, role, head)).state() }))) : [],
	]);
	return {
		...(builder ? { builder: { status: builder.status, revisions: builder.revisions, ...(builder.error ? { error: builder.error } : {}) } } : {}),
		reviewers: reviewers.flatMap(({ role, state }) => (state ? [{ role, status: state.status, ...(state.verdict ? { verdict: state.verdict } : {}) }] : [])),
	};
}
