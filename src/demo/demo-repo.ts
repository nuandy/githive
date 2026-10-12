import { ensureRepo, remoteFor } from "../artifacts";
import { OrgStore, repoIdFor } from "../auth/orgs";
import { fail } from "../errors";
import { type Remote, Workspace } from "../git";
import { writeFirstCommit } from "../repo-init";
import { GITHUB_AGENT } from "../toolkit/github-settings";
import { toolContextFor } from "../toolkit/env";
import { callTool } from "../toolkit/mcp";
import { HOSTED_PREFIX, recordLog, workRef } from "../toolkit/tools/repo";
import { type Work, withdrawWork } from "../toolkit/work";
import { resetChange } from "./run";
import { TEMPLATE_FILES } from "./template-files";

// The one public repo every demo run builds Honeycomb in, named by DEMO_REPO (owner/name). The first run makes it
// with the game's starting files. Every later run starts over on top of the last: it stops the last run's agents,
// releases the claims they left, takes the last run's pieces out of the backlog, and puts the starting files back as
// a change the hive reviews, so nothing goes around the rules and the history keeps every run.

/** The demo's own agent: it sets the repo up, adds the backlog and lands each run's reset. */
export const DEMO_AGENT = "githive-demo";

/** The settings the demo repo starts with: one approval, and the game's tests before landing. */
const DEMO_SETTINGS = { required: 1, verify: ["npm test"] };

const AUTHOR = { name: DEMO_AGENT, email: `${DEMO_AGENT}@agents.githive.app` };

/** The context the demo's own calls run in. */
export const demoContext = (env: Env) => toolContextFor(env, `service:${DEMO_AGENT}`, { hosted: true });

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
 * Puts the starting files back for run `number`, as a change claiming the whole repo, for the hive to review before
 * anything else. Returns its id, or nothing when the repo holds just the starting files already.
 */
export async function startReset(env: Env, repo: string, number: number) {
	const ctx = demoContext(env);
	const project = await remoteFor(env.ARTIFACTS, repo, "read");
	const reset = await resetCommit(project, number);
	if (!reset) return undefined;
	const change = resetChange(number);
	const intent =
		`Start demo run ${number} over: remove every file the last run built and put Honeycomb's starting files back ` +
		"(the README's rules and contract, the page shell, the styles' stubs, the word list and its test), as the " +
		"repo began. Nothing else changes, and npm test passes on them.";
	const claimed = (await callTool("claim", { repo, agent: DEMO_AGENT, change, paths: reset.paths, intent }, ctx)) as {
		ok?: boolean;
		reason?: string;
	};
	if (claimed.ok === false) fail(409, `the reset couldn't claim the repo: ${claimed.reason ?? "refused"}`);
	const fork = (await callTool("credentials", { repo, agent: DEMO_AGENT, change }, ctx)) as Remote;
	const to = `refs/heads/changes/${change}`;
	// The fork may lack history the shallow clone leaves out; then push with all of it.
	await reset.workspace.pushAs("refs/heads/main", to, fork).catch(async () => {
		const full = await resetCommit(project, number, { depth: 1 << 20 });
		await full!.workspace.pushAs("refs/heads/main", to, fork);
	});
	return change;
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
