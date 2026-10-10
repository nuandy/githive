import { fail, requiredString } from "../../errors";
import { projectBranch } from "../../project-branch";
import { onActions } from "../actions-checks";
import { DEFAULT_SKIP_CHECKS } from "../check-scope";
import { changeSettings, registerAgent, registerAgents, startRepo } from "../claims";
import { grantWarnings } from "../votes";
import type { ToolHandlers } from "./context";
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
import { branchRulesFrom, checksFrom, githubFrom, POLICY_FIELDS, policyFrom, skipPatternsFrom } from "./settings-input";
import { INSTRUCTIONS } from "./tool-list";

// Tools that set up a repo and its agents: settings (which also starts GitHive on a repo) and register.

export const setupTools: ToolHandlers = {
	async settings({ args, ctx, run, repo, claims, registered, stamper }) {
		if (!registered?.baseline) {
			// The first settings start GitHive on the repo: policy, checks, and how claims are kept.
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
			const sharding = asked
				? { shardDepth: asked, recordsRepos }
				: asked === 0
					? {}
					: { autoShard: { depth: DEFAULT_SHARD_DEPTH, recordsRepos: spread } };
			await startRepo(claims, {
				baseline: await ctx.head(repo, into),
				branch: into,
				policy,
				verify,
				stampKey: stamper?.publicKey,
				...sharding,
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
			const rest = (["branch_rules", "skip_checks", "github"] as const).filter((f) => args[f] !== undefined);
			if (!rest.length) return started;
			const more = (await run(
				"settings",
				{
					repo,
					...(args.agent_key !== undefined ? { agent_key: args.agent_key } : {}),
					...Object.fromEntries(rest.map((f) => [f, args[f]])),
				},
				ctx,
			)) as Record<string, unknown>;
			return { ...started, ...more, instructions: INSTRUCTIONS };
		}
		if (args.shard_depth !== undefined || args.records_repos !== undefined)
			throw new Error(
				"[409] how claims are kept is set when GitHive starts on a repo: since, they shard as the load calls for it",
			);
		const policy = POLICY_FIELDS.some((f) => args[f] !== undefined)
			? policyFrom(args, registered.policy ?? DEFAULT_POLICY)
			: undefined;
		const verify = args.verify === undefined ? undefined : checksFrom(args.verify);
		const branchRules =
			args.branch_rules === undefined
				? undefined
				: branchRulesFrom(args.branch_rules, registered.policy ?? DEFAULT_POLICY);
		const skipChecks = args.skip_checks === undefined ? undefined : skipPatternsFrom(args.skip_checks);
		const github = args.github === undefined ? undefined : await githubFrom(ctx, args.github);
		if (!policy && !verify && !branchRules && !skipChecks && github === undefined)
			throw new Error(
				`[400] GitHive has started on ${repo}: name what to change: ${[...POLICY_FIELDS, "verify", "branch_rules", "skip_checks", "github"].join(", ")}`,
			);
		// Checks on Actions need the GitHub repo they run in.
		if (onActions(verify ?? registered.verify) && !(github ?? (github === null ? null : registered.github)))
			throw new Error(`[409] checks on GitHub Actions need a connected GitHub repo: set github ("owner/name") too`);
		await changeSettings(claims, {
			...(policy ? { policy } : {}),
			...(verify ? { verify } : {}),
			...(branchRules ? { branchRules } : {}),
			...(skipChecks ? { skipChecks } : {}),
			...(github !== undefined ? { github } : {}),
			...(stamper?.by ? { by: stamper.by } : {}),
		});
		const registry = (await claims.read())?.commit.state;
		// New checks may need new installs, so warm the Gate for them.
		if (verify)
			await ctx
				.warmChecks?.(repo, { branch: projectBranch(registry), checks: containerChecks(verify), expect: "set up" })
				.catch(() => undefined);
		const warnings = grantWarnings(registry?.policy ?? DEFAULT_POLICY);
		return {
			repo,
			branch: projectBranch(registry),
			policy: registry?.policy ?? DEFAULT_POLICY,
			verify: registry?.verify ?? [],
			skipChecks: registry?.skipChecks ?? DEFAULT_SKIP_CHECKS,
			...(registry?.branchRules?.length ? { branchRules: registry.branchRules } : {}),
			...(registry?.github ? { github: registry.github.repo } : {}),
			...(warnings.length ? { warnings } : {}),
		};
	},
	async register({ args, ctx, repo, claims, acting, stamper }) {
		if (ctx.agent)
			throw new Error(
				`[409] you're signed in as ${ctx.agent}: what you write is already attributed to you, with no key`,
			);
		const nameOk = (agent: string) => {
			if (agent.includes("/"))
				throw new Error('[400] names with "/" are signed-in agents\' (<handle>/<agent>); register a name without one');
			if (agent.startsWith(HOSTED_PREFIX) && !ctx.hosted)
				throw new Error("[403] githive- names are GitHive's hosted agents'");
			return agent;
		};
		const keyFor = (agent: string) =>
			`${agent}.${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "")}`;
		const note =
			"Keep each key secret; it is shown once. Send it as X-GitHive-Agent-Key (or agent_key) with every call.";
		if (args.agents !== undefined) {
			if (!Array.isArray(args.agents) || !args.agents.length || args.agents.length > MOST_AT_ONCE)
				throw new Error(`[400] agents is a list of 1 to ${MOST_AT_ONCE} names`);
			const names = args.agents.map((a) =>
				typeof a === "string" && a.trim() ? nameOk(a.trim()) : fail(400, "each of agents is a name"),
			);
			if (new Set(names).size !== names.length) throw new Error("[400] agents names a name more than once");
			const keys = names.map(keyFor);
			const outcome = await registerAgents(
				claims,
				await Promise.all(names.map(async (agent, i) => ({ agent, keyHash: await sha256(keys[i]) }))),
				stamper,
			);
			if (!outcome.ok) throw new Error(`[409] ${outcome.refused}`);
			await ctx.prepareForks?.(repo, names).catch(() => undefined);
			return { agents: names.map((agent, i) => ({ agent, key: keys[i] })), note };
		}
		const agent = nameOk(requiredString(args, "agent"));
		const newKey = keyFor(agent);
		const outcome = await registerAgent(
			claims,
			{ agent, keyHash: await sha256(newKey), ...(acting ? { holder: acting } : {}) },
			stamper,
		);
		if (!outcome.ok) throw new Error(`[409] ${outcome.refused}`);
		// Queue its fork now, rather than making it on its first push alongside everyone else's.
		await ctx.prepareForks?.(repo, [agent]).catch(() => undefined);
		return { agent, key: newKey, note: note.replace("each key", "this key") };
	},
};
