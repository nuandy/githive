import { ensureRepo, forkAndWait, headOf, remoteFor, reviewerName } from "../artifacts";
import { GitCasLog } from "../election-git";
import { fail } from "../errors";
import { type Remote, Workspace } from "../git";
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
 * Artifacts tokens, per repo and scope, kept for the isolate while fresh:
 * minting one is several Artifacts calls, which dominated each tool call. They
 * last an hour and are reused for half of it. Only minted tokens are shared: a
 * mint still in flight is its own request's I/O, which in Workers no other
 * request may wait on, so calls that miss at once each mint their own.
 */
const remotes = new Map<string, { remote: Remote; until: number }>();
async function cached(key: string, mint: () => Promise<Remote>) {
	const hit = remotes.get(key);
	if (hit && Date.now() < hit.until) return hit.remote;
	const remote = await mint();
	remotes.set(key, { remote, until: Date.now() + 30 * 60_000 });
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
		requestReview: (input) => startFreeReviewers(env, input),
		startBuilder: (input) => startFreeBuilder(env, input),
		stamper: async (agent) => (env.FREE_STAMP_KEY && by ? makeStamper(env.FREE_STAMP_KEY, agent ? `${by}/${agent}` : by) : undefined),
		remote: (repo, scope) => cached(`${repo}|${scope}`, () => remoteFor(env.ARTIFACTS, repo, scope, 3600)),
		changeRemote: (repo, change, scope) => cached(`${freeAgentName(repo, change)}|${scope}`, () => changeRemote(env, repo, change, scope, 3600)),
		recordsRemote: (repo, k, scope) => cached(`${recordsRepoName(repo, k)}|${scope}`, () => remoteFor(env.ARTIFACTS, recordsRepoName(repo, k), scope, 3600)),
		createRecordsRepos: async (repo, count) => {
			await Promise.all(Array.from({ length: count }, (_, k) => ensureRepo(env.ARTIFACTS, recordsRepoName(repo, k), `Coordinator-free claim records for ${repo}`)));
		},
		records: <S>(repo: string, ref: string) => {
			let log = logs.get(ref);
			if (!log) logs.set(ref, (log = new GitCasLog<unknown>(() => cached(`${repo}|write`, () => remoteFor(env.ARTIFACTS, repo, "write", 3600)), repo, ref)));
			return log as GitCasLog<S>;
		},
		agentStatus: (repo, change, head, roles) => freeAgentStatus(env, repo, change, head, roles),
		head: async (repo) => (await headOf(env.ARTIFACTS, repo)) ?? fail(409, `${repo} has no commits`),
		// Checks run in the Gate's container, one Gate per repo.
		runChecks: (repo) => async ({ base, head, ref, commands, source }) => {
			const remote = await remoteFor(env.ARTIFACTS, repo, "read", 3600);
			const change = source ?? remote;
			const result = await env.GATE.getByName(`free:${repo}`).checkCommit({ baseHead: base, base: { remote: remote.url, token: remote.token }, fork: { remote: change.url, token: change.token, ref }, head, checks: commands });
			return { passed: result.passed, results: result.results.map((r) => ({ command: r.command, exitCode: r.exitCode, output: r.output })) };
		},
	};
}

const claimsRef = (repo: string) => `refs/notes/blueprint-claims/${repo}`;
/** A change's fork, and its hosted agents' Durable Object names: one builder, one reviewer per role and commit. */
export const freeAgentName = (repo: string, change: string) => `free--${repo}--${change}`;

/** Credentials for a change's own fork of the project repo; writing to it first creates the fork. */
export async function changeRemote(env: Env, repo: string, change: string, scope: "read" | "write", ttlSeconds: number) {
	const name = freeAgentName(repo, change);
	try {
		return await remoteFor(env.ARTIFACTS, name, scope, ttlSeconds);
	} catch (err) {
		if (scope === "read") throw new Error(`[409] ${change} has no fork yet: nothing has been pushed for it`);
		await forkAndWait(env.ARTIFACTS, repo, name, `Coordinator-free change ${change} of ${repo}`);
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
		/** Where the change's branch lives: its own fork. */
		source: (scope: "read" | "write") => changeRemote(env, repo, change, scope, 3 * 3600),
		policy: registry?.policy ?? { required: 2, vetoes: ["security"] },
		job: {
			taskId: `free:${repo}`,
			repo: freeAgentName(repo, change),
			goal: own?.intent ?? change,
			verify: registry?.verify ?? [],
			slice: { id: change, title: change, owns: own?.paths ?? [], instructions: own?.intent ?? "", tests: [] },
			siblings: claims.filter((c) => c.change !== change).map((c) => ({ id: c.change, title: c.change, owns: c.paths })),
			contracts: [],
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
	const { read, own, policy, job, source } = await changeBrief(env, repo, change);
	// By default the tests role and every role that can veto.
	const roles = input.roles?.length ? input.roles : [...new Set(["tests", ...policy.vetoes])];
	const from = await source("read");
	const ws = await Workspace.clone(read);
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
