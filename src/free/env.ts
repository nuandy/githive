import { headOf, remoteFor, reviewerName } from "../artifacts";
import { GitCasLog } from "../election-git";
import { fail } from "../errors";
import { Workspace } from "../git";
import type { Registry } from "./claims";
import type { FreeContext } from "./mcp";
import { makeStamper } from "./stamp";

// Coordinator-free mode wired to Cloudflare: Artifacts for Git, the Gate's
// container for checks, the task index for the dashboard, Blueprint's hosted
// agents. Shared by the Worker (acting for an MCP caller) and by the hosted
// agents themselves (acting as themselves).

/** The coordinator-free context for one actor: `by` is who it is (as Access verified them, or a hosted agent's own name); stamps carry it. */
export function freeContextFor(env: Env, by: string | undefined): FreeContext {
	return {
		register: async (repo) => env.TASK_INDEX.getByName("all").addFree(repo),
		requestReview: (input) => startFreeReviewers(env, input),
		startBuilder: (input) => startFreeBuilder(env, input),
		stamper: async () => (env.FREE_STAMP_KEY && by ? makeStamper(env.FREE_STAMP_KEY, by) : undefined),
		remote: (repo, scope) => remoteFor(env.ARTIFACTS, repo, scope, 3600),
		head: async (repo) => (await headOf(env.ARTIFACTS, repo)) ?? fail(409, `${repo} has no commits`),
		// Checks run in the Gate's container, one Gate per repo.
		runChecks: (repo) => async ({ base, head, ref, commands }) => {
			const remote = await remoteFor(env.ARTIFACTS, repo, "read", 3600);
			const result = await env.GATE.getByName(`free:${repo}`).checkCommit({ baseHead: base, base: { remote: remote.url, token: remote.token }, fork: { remote: remote.url, token: remote.token, ref }, head, checks: commands });
			return { passed: result.passed, results: result.results.map((r) => ({ command: r.command, exitCode: r.exitCode, output: r.output })) };
		},
	};
}

const claimsRef = (repo: string) => `refs/notes/blueprint-claims/${repo}`;
/** Hosted agents' Durable Object names for a change: one builder, one reviewer per role and commit. */
export const freeAgentName = (repo: string, change: string) => `free--${repo}--${change}`;

/** What every hosted agent on a change is told: its claim as the brief, the other claims, the checks. */
async function changeBrief(env: Env, repo: string, change: string) {
	const read = await remoteFor(env.ARTIFACTS, repo, "read", 3 * 3600);
	const registry = (await new GitCasLog<Registry>(async () => read, repo, claimsRef(repo)).read())?.commit.state;
	const own = registry?.claims.find((c) => c.change === change);
	return {
		read,
		own,
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
	const { read, own, policy, job } = await changeBrief(env, repo, change);
	// By default the tests role and every role that can veto.
	const roles = input.roles?.length ? input.roles : [...new Set(["tests", ...policy.vetoes])];
	const ws = await Workspace.clone(read);
	const head = await ws.fetch("change", read, ref);
	const baseCommit = await ws.mergeBase(await ws.head(), head);
	const review = { ...job, remote: read.url, token: read.token, head, baseCommit, buildSummary: input.summary, free: { repo, change, ref, agent: own?.agent ?? change, mergeWhenApproved: !!input.mergeWhenApproved } };
	await Promise.all(roles.map((role) => env.REVIEWER.getByName(reviewerName(freeAgentName(repo, change), role, head)).start({ ...review, role })));
	return { head, reviewers: roles };
}

/** Start Blueprint's hosted builder on a claimed coordinator-free change: it works on the branch changes/<change> in the project repo. */
export async function startFreeBuilder(env: Env, input: { repo: string; change: string }) {
	const { repo, change } = input;
	const { read, own, job } = await changeBrief(env, repo, change);
	const write = await remoteFor(env.ARTIFACTS, repo, "write", 3 * 3600);
	const build = { ...job, remote: write.url, token: write.token, base: { remote: read.url, token: read.token }, free: { repo, change, ref: `changes/${change}`, agent: own?.agent ?? change } };
	await env.BUILDER.getByName(freeAgentName(repo, change)).start(build);
	return { change, builder: freeAgentName(repo, change) };
}
