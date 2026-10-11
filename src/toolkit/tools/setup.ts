import { fail, requiredString } from "../../errors";
import { projectBranch } from "../../project-branch";
import { onActions } from "../actions-checks";
import { DEFAULT_SKIP_CHECKS } from "../check-scope";
import { changeSettings, type Registry, registerAgent, registerAgents, startRepo } from "../claims";
import { grantWarnings } from "../votes";
import type { ToolCall, ToolHandlers } from "./context";
import { sha256 } from "./identity";
import {
	containerChecks,
	DEFAULT_POLICY,
	DEFAULT_RECORDS_REPOS,
	DEFAULT_SHARD_DEPTH,
	HOSTED_PREFIX,
	MOST_AT_ONCE,
	shardingOf,
} from "./repo";
import { bringsGitHubBack, githubSync, trustsGitHub } from "../github-settings";
import {
	branchRulesFrom,
	checksFrom,
	GITHUB_FIELDS,
	githubFrom,
	POLICY_FIELDS,
	policyFrom,
	skipPatternsFrom,
} from "./settings-input";
import { INSTRUCTIONS } from "./tool-list";

// Tools that set up a repo and its agents: settings (which also starts GitHive on a repo) and register.

export const setupTools: ToolHandlers = {
	async settings(call) {
		return call.registered?.baseline ? changeRepoSettings(call, call.registered) : startOnRepo(call);
	},
	async register({ args, ctx, repo, claims, acting, stamper }) {
		if (ctx.agent)
			fail(409, `you're signed in as ${ctx.agent}: what you write is already attributed to you, with no key`);
		const nameOk = (agent: string) => {
			if (agent.includes("/"))
				fail(400, 'names with "/" are signed-in agents\' (<handle>/<agent>); register a name without one');
			if (agent.startsWith(HOSTED_PREFIX) && !ctx.hosted) fail(403, "githive- names are GitHive's hosted agents'");
			return agent;
		};
		const keyFor = (agent: string) => {
			const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
			return `${agent}.${secret}`;
		};
		const note =
			"Keep each key secret; it is shown once. Send it as X-GitHive-Agent-Key (or agent_key) with every call.";
		if (args.agents !== undefined) {
			if (!Array.isArray(args.agents) || !args.agents.length || args.agents.length > MOST_AT_ONCE)
				fail(400, `agents is a list of 1 to ${MOST_AT_ONCE} names`);
			const names = args.agents.map((name) =>
				typeof name === "string" && name.trim() ? nameOk(name.trim()) : fail(400, "each of agents is a name"),
			);
			if (new Set(names).size !== names.length) fail(400, "agents names a name more than once");
			const issued = names.map((agent) => ({ agent, key: keyFor(agent) }));
			const hashed = await Promise.all(issued.map(async ({ agent, key }) => ({ agent, keyHash: await sha256(key) })));
			const outcome = await registerAgents(claims, hashed, stamper);
			if (!outcome.ok) fail(409, outcome.refused);
			await ctx.prepareForks?.(repo, names).catch(() => undefined);
			return { agents: issued, note };
		}
		const agent = nameOk(requiredString(args, "agent"));
		const newKey = keyFor(agent);
		const outcome = await registerAgent(
			claims,
			{ agent, keyHash: await sha256(newKey), ...(acting ? { holder: acting } : {}) },
			stamper,
		);
		if (!outcome.ok) fail(409, outcome.refused);
		// Queue its fork now, rather than making it on its first push alongside everyone else's.
		await ctx.prepareForks?.(repo, [agent]).catch(() => undefined);
		return { agent, key: newKey, note: note.replace("each key", "this key") };
	},
};

// The first settings start GitHive on the repo: policy, checks, and how claims are kept.
async function startOnRepo({ args, ctx, run, repo, claims, registered, stamper }: ToolCall) {
	const policy = policyFrom(args, DEFAULT_POLICY);
	const verify = args.verify === undefined ? [] : checksFrom(args.verify);
	// Claims stay in one record until the load calls for shards, unless shard_depth says otherwise.
	const asked = typeof args.shard_depth === "number" ? Math.max(0, Math.floor(args.shard_depth)) : undefined;
	// Sharded claims are spread over records repos when this deployment can make them.
	const wanted =
		typeof args.records_repos === "number" ? Math.max(0, Math.floor(args.records_repos)) : DEFAULT_RECORDS_REPOS;
	const spread = ctx.recordsRemote && ctx.createRecordsRepos ? wanted : 0;
	const recordsRepos = asked ? spread : 0;
	if (recordsRepos) await ctx.createRecordsRepos!(repo, recordsRepos);
	// Changes merge into the repo's default branch, whatever it's called.
	const into = registered?.branch ?? (!ctx.defaultBranch ? "main" : await ctx.defaultBranch(repo));
	await startRepo(claims, {
		baseline: await ctx.head(repo, into),
		branch: into,
		policy,
		verify,
		stampKey: stamper?.publicKey,
		...shardingAtStart(asked, recordsRepos, spread),
	});
	await ctx.register?.(repo);
	// Start making seed forks now, one at a time, so agents' forks can be copied from them later.
	await ctx.prepareForks?.(repo, "seeds").catch(() => undefined);
	const registry = (await claims.read())?.commit.state;
	// With checks, warm the Gate now so its install is done and snapshotted before the first merge.
	// Without checks, the first claim warms it instead, so a repo nobody works in costs nothing.
	if (containerChecks(registry?.verify).length)
		await ctx
			.warmChecks?.(repo, {
				branch: projectBranch(registry),
				checks: containerChecks(registry?.verify),
				expect: "set up",
			})
			.catch(() => undefined);
	const warnings = grantWarnings(registry?.policy ?? policy);
	const started = {
		repo,
		branch: projectBranch(registry),
		policy: registry?.policy ?? policy,
		verify: registry?.verify ?? [],
		...shardingOf(registry),
		...(warnings.length ? { warnings } : {}),
		instructions: INSTRUCTIONS,
	};
	// Starting doesn't set branch rules, skipped files or GitHub: apply those with a second settings call.
	const rest = (["branch_rules", "skip_checks", ...GITHUB_FIELDS] as const).filter(
		(field) => args[field] !== undefined,
	);
	if (!rest.length) return started;
	const more = (await run(
		"settings",
		{
			repo,
			...(args.agent_key !== undefined ? { agent_key: args.agent_key } : {}),
			...Object.fromEntries(rest.map((field) => [field, args[field]])),
		},
		ctx,
	)) as Record<string, unknown>;
	return { ...started, ...more, instructions: INSTRUCTIONS };
}

// How claims are kept from the start: sharded `asked` deep, never sharded (0), or sharded once the load calls for it.
function shardingAtStart(asked: number | undefined, recordsRepos: number, spread: number) {
	if (asked) return { shardDepth: asked, recordsRepos };
	if (asked === 0) return {};
	return { autoShard: { depth: DEFAULT_SHARD_DEPTH, recordsRepos: spread } };
}

// Later settings change what they name. How claims are kept was settled at the start.
async function changeRepoSettings({ args, ctx, repo, claims, stamper }: ToolCall, registered: Registry) {
	if (args.shard_depth !== undefined || args.records_repos !== undefined)
		fail(409, "how claims are kept is set when GitHive starts on a repo: since, they shard as the load calls for it");
	const policy = POLICY_FIELDS.some((field) => args[field] !== undefined)
		? policyFrom(args, registered.policy ?? DEFAULT_POLICY)
		: undefined;
	const verify = args.verify === undefined ? undefined : checksFrom(args.verify);
	const branchRules =
		args.branch_rules === undefined
			? undefined
			: branchRulesFrom(args.branch_rules, registered.policy ?? DEFAULT_POLICY);
	const skipChecks = args.skip_checks === undefined ? undefined : skipPatternsFrom(args.skip_checks);
	const github = await githubFrom(ctx, args, registered.github);
	if (!policy && !verify && !branchRules && !skipChecks && github === undefined) {
		const fields = [...POLICY_FIELDS, "verify", "branch_rules", "skip_checks", ...GITHUB_FIELDS].join(", ");
		fail(400, `GitHive has started on ${repo}: name what to change: ${fields}`);
	}
	// Checks on Actions need the GitHub repo they run in. A github of null disconnects it.
	const connected = github === undefined ? registered.github : github;
	if (onActions(verify ?? registered.verify) && !connected)
		fail(409, `checks on GitHub Actions need a connected GitHub repo: set github ("owner/name") too`);
	const changes: Parameters<typeof changeSettings>[1] = {};
	if (policy) changes.policy = policy;
	if (verify) changes.verify = verify;
	if (branchRules) changes.branchRules = branchRules;
	if (skipChecks) changes.skipChecks = skipChecks;
	if (github !== undefined) changes.github = github;
	if (stamper?.by) changes.by = stamper.by;
	await changeSettings(claims, changes);
	const registry = (await claims.read())?.commit.state;
	// New checks may need new installs, so warm the Gate for them.
	if (verify)
		await ctx
			.warmChecks?.(repo, { branch: projectBranch(registry), checks: containerChecks(verify), expect: "set up" })
			.catch(() => undefined);
	const warnings = grantWarnings(registry?.policy ?? DEFAULT_POLICY);
	const reply: Record<string, unknown> = {
		repo,
		branch: projectBranch(registry),
		policy: registry?.policy ?? DEFAULT_POLICY,
		verify: registry?.verify ?? [],
		skipChecks: registry?.skipChecks ?? DEFAULT_SKIP_CHECKS,
	};
	if (registry?.branchRules?.length) reply.branchRules = registry.branchRules;
	if (registry?.github) Object.assign(reply, githubReply(registry));
	if (warnings.length) reply.warnings = warnings;
	return reply;
}

// The GitHub link as settings reply with it: the repo, how main goes there, and whether its changes need review.
function githubReply(registry: Registry) {
	return {
		github: registry.github!.repo,
		githubSync: githubSync(registry),
		githubTrust: trustsGitHub(registry),
		// A link made before modes mirrors only, until a mode is set for it.
		githubInbound: bringsGitHubBack(registry),
	};
}
