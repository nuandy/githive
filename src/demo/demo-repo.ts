import { ensureRepo, remoteFor } from "../artifacts";
import { OrgStore, repoIdFor } from "../auth/orgs";
import { fail } from "../errors";
import { type Remote, Workspace } from "../git";
import { writeFirstCommit } from "../repo-init";
import { GITHUB_AGENT } from "../toolkit/github-settings";
import { toolContextFor } from "../toolkit/env";
import { callTool } from "../toolkit/mcp";
import type { Registry } from "../toolkit/claims";
import { HOSTED_PREFIX, claimsRef, recordLog, workRef } from "../toolkit/tools/repo";
import { withdrawWork } from "../toolkit/backlog-records";
import type { Work } from "../toolkit/work";
import { BACKLOG } from "./backlog";
import { type Gates, resetChange, runBacklog } from "./run";
import { TEMPLATE_FILES } from "./template-files";

// The one public repo every demo run builds Honeycomb in, named by DEMO_REPO (owner/name). The first run makes it
// with the game's starting files. Every later run starts over on top of the last: it stops the last run's agents,
// releases the claims they left, takes the last run's pieces out of the backlog, and puts the starting files back as
// a change of the demo's own, so nothing is force-pushed and the history keeps every run. Those are the files the repo
// began with, all reviewed and checked once already, so the reset lands without a review or the checks: the run
// sets the repo's approvals and checks to none while it lands, and puts them back before its agents start.

/** The demo's own agent: it sets the repo up, adds the backlog and lands each run's reset. */
export const DEMO_AGENT = "githive-demo";

/** The settings the demo repo starts with: one approval, and the game's tests before landing. */
const DEMO_SETTINGS = { required: 1, verify: ["npm test"] };

const AUTHOR = { name: DEMO_AGENT, email: `${DEMO_AGENT}@agents.githive.app` };

/** The context the demo's own calls run in. */
export const demoContext = (env: Env) => toolContextFor(env, `service:${DEMO_AGENT}`, { hosted: true });

/** The demo repo's full name (owner/name), or undefined when this GitHive has none. */
export function demoRepoOf(env: Env) {
	const [owner, name, ...rest] = (env.DEMO_REPO ?? "").split("/");
	if (!owner || !name || rest.length) return undefined;
	return `${owner}/${name}`;
}

/** The demo repo's owner and name, from DEMO_REPO. */
export function demoRepoName(env: Env) {
	const [owner, name, ...rest] = (env.DEMO_REPO ?? "").split("/");
	if (!owner || !name || rest.length) fail(501, "this GitHive has no demo repo (DEMO_REPO)");
	return { owner, name, fullName: `${owner}/${name}` };
}

/** The demo repo, made with the game's starting files if it isn't there yet; `made` says it was made just now. */
export async function demoRepo(env: Env) {
	const { owner, name, fullName } = demoRepoName(env);
	const orgs = new OrgStore(env.DB);
	const existing = await orgs.repo(owner, name);
	if (existing) return { id: existing.id, fullName, made: false };
	const org = (await orgs.org(owner)) ?? fail(501, `the demo repo's owner, ${owner}, isn't on this GitHive`);
	const id = repoIdFor(owner, name);
	await ensureRepo(env.ARTIFACTS, id, fullName);
	await writeFirstCommit(await remoteFor(env.ARTIFACTS, id, "write"), TEMPLATE_FILES, {
		...AUTHOR,
		message: "Lay out Honeycomb: the rules, each module's contract, the page shell and the word list",
	});
	await orgs.addRepo(org, name, null, { visibility: "public", id });
	await callTool("settings", { repo: id, agent: DEMO_AGENT, ...DEMO_SETTINGS }, demoContext(env));
	return { id, fullName, made: true };
}

/** GitHive's own agents, whose claims the demo may release; never GitHub's, which a person gives up. */
const releasable = (agent: string) => agent.startsWith(HOSTED_PREFIX) && agent !== GITHUB_AGENT;

/** Ends what the last run left: its agents, the claims GitHive's agents still hold, and the demo's backlog. */
export async function clearLastRun(env: Env, repo: string, number: number) {
	const ctx = demoContext(env);
	const reason = `demo run ${number} starts over`;
	await env.HOSTED_AGENT.getByName(`hive:${repo}`).stopAll();
	const claims = (await callTool("claims", { repo, agent: DEMO_AGENT }, ctx)) as { change: string; agent: string }[];
	for (const claim of claims.filter((held) => releasable(held.agent)))
		await callTool("release", { repo, agent: claim.agent, change: claim.change, reason }, ctx);
	await withdrawWork(recordLog<Work>(ctx, repo, workRef(repo)), DEMO_AGENT, reason);
}

/**
 * Puts the starting files back for run `number`, as a change claiming the whole repo, with no approvals or checks while
 * it lands. `restore` is what to put back once it has, kept by the run before anything changed. Returns its id and
 * `restore`, or nothing when main holds just those files.
 */
export async function startReset(env: Env, repo: string, number: number, restore: Gates) {
	const ctx = demoContext(env);
	const project = await remoteFor(env.ARTIFACTS, repo, "read");
	const reset = await resetCommit(project, number);
	if (!reset) return undefined;
	const change = resetChange(number);
	const intent =
		`Start demo run ${number} over: remove every file the last run built and put Honeycomb's starting files back, ` +
		"as the repo began.";
	await setGates(env, repo, { required: 0, verify: [] });
	try {
		const claim = { repo, agent: DEMO_AGENT, change, paths: reset.paths, intent };
		const claimed = (await callTool("claim", claim, ctx)) as { ok?: boolean; reason?: string };
		if (claimed.ok === false) fail(409, `the reset couldn't claim the repo: ${claimed.reason ?? "refused"}`);
		const fork = (await callTool("credentials", { repo, agent: DEMO_AGENT, change }, ctx)) as Remote;
		const to = `refs/heads/changes/${change}`;
		// The fork may lack history the shallow clone leaves out; then push with all of it.
		await reset.workspace.pushAs("refs/heads/main", to, fork).catch(async () => {
			const full = await resetCommit(project, number, { depth: 1 << 20 });
			await full!.workspace.pushAs("refs/heads/main", to, fork);
		});
	} catch (err) {
		await setGates(env, repo, restore).catch(() => undefined);
		throw err;
	}
	return { change, restore };
}

/** What the repo's changes need now to land: approvals, and the checks they pass. */
export async function gatesOf(env: Env, repo: string): Promise<Gates> {
	const state = (await recordLog<Registry>(demoContext(env), repo, claimsRef(repo)).read())?.commit.state;
	return { required: state?.policy?.required ?? 0, verify: state?.verify ?? [] };
}

/** Sets the approvals and checks the repo's changes need, leaving the rest of its settings as they are. */
export async function setGates(env: Env, repo: string, gates: Gates) {
	await callTool("settings", { repo, agent: DEMO_AGENT, ...gates }, demoContext(env));
}

/** Main with the starting files in place of whatever is there, committed; nothing when that changes no file. */
export async function resetCommit(project: Remote, number: number, options: { depth?: number } = {}) {
	const workspace = await Workspace.clone(project, "main", options);
	const before = await workspace.files();
	await workspace.remove(before.filter((path) => !(path in TEMPLATE_FILES)));
	await workspace.write(TEMPLATE_FILES);
	const parent = await workspace.head();
	const commit = await workspace.commit(`Start demo run ${number} over from Honeycomb's starting files`, AUTHOR);
	const [made, previous] = await Promise.all([workspace.ensureCommit(commit), workspace.ensureCommit(parent)]);
	if (made.commit.tree === previous.commit.tree) return undefined;
	return { workspace, paths: topLevel([...before, ...Object.keys(TEMPLATE_FILES)]) };
}

/** The top-level files and folders of `paths`, as a claim covering all of them. */
export function topLevel(paths: string[]) {
	const tops = paths.map((path) => (path.includes("/") ? `${path.slice(0, path.indexOf("/"))}/` : path));
	return [...new Set(tops)].sort();
}

/**
 * The demo repo ready for run `number`: the last run cleared and its reset pushed, then this run's backlog. Returns
 * the repo, and the reset to land before the agents start with the approvals and checks to put back after it, which
 * `restore` gives once it's needed.
 */
export async function setUpRun(env: Env, number: number, restore: () => Promise<Gates>) {
	const repo = await demoRepo(env);
	let reset: Awaited<ReturnType<typeof startReset>>;
	if (!repo.made) {
		await clearLastRun(env, repo.id, number);
		reset = await startReset(env, repo.id, number, await restore());
	}
	const items = runBacklog(BACKLOG, number);
	await callTool("add_work", { repo: repo.id, agent: DEMO_AGENT, items }, demoContext(env)).catch(async (err) => {
		// The run won't start, so give the repo its approvals back; the next run releases the reset's claim.
		if (reset) await setGates(env, repo.id, reset.restore).catch(() => undefined);
		throw err;
	});
	return { repo: repo.id, ...(reset ? { reset: reset.change, restore: reset.restore } : {}) };
}
