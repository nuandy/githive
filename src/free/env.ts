import { forkAndWait, headOf, remoteFor, reviewerName } from "../artifacts";
import { GitCasLog } from "../election-git";
import { fail } from "../errors";
import { Workspace } from "../git";
import type { Registry } from "./claims";
import type { FreeContext, HostedStatus } from "./mcp";
import { makeStamper } from "./stamp";

// Coordinator-free mode wired to Cloudflare: Artifacts for Git, the Gate's
// container for checks, the task index for the dashboard, Blueprint's hosted
// agents. Shared by the Worker (acting for an MCP caller) and by the hosted
// agents themselves (acting as themselves).

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
		remote: (repo, scope) => remoteFor(env.ARTIFACTS, repo, scope, 3600),
		changeRemote: (repo, change, scope) => changeRemote(env, repo, change, scope, 3600),
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
	const registry = (await new GitCasLog<Registry>(async () => read, repo, claimsRef(repo)).read())?.commit.state;
	const own = registry?.claims.find((c) => c.change === change);
	return {
		read,
		own,
		/** Where the change's branch lives: its fork, or the project repo when it's shared. */
		source: (scope: "read" | "write") => (registry?.access === "forks" ? changeRemote(env, repo, change, scope, 3 * 3600) : remoteFor(env.ARTIFACTS, repo, scope, 3 * 3600)),
		policy: registry?.policy ?? { required: 2, vetoes: ["security"] },
		job: {
			taskId: `free:${repo}`,
			repo: freeAgentName(repo, change),
			goal: own?.intent ?? change,
			verify: registry?.verify ?? [],
			slice: { id: change, title: change, owns: own?.paths ?? [], instructions: own?.intent ?? "", tests: [] },
			siblings: (registry?.claims ?? []).filter((c) => c.change !== change).map((c) => ({ id: c.change, title: c.change, owns: c.paths })),
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

/** Start Blueprint's hosted builder on a claimed coordinator-free change: it works on the branch changes/<change> in the change's fork (or the shared project repo). */
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
