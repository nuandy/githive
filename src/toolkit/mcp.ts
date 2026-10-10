import { requiredString } from "../errors";
import { projectBranch } from "../project-branch";
import type { Registry } from "./claims";
import { type Args, openCall, type ToolContext, type ToolHandlers } from "./tools/context";
import { repoSnapshot } from "./tools/dashboard";
import { advice, claimsRef, recordLog, storeFor } from "./tools/repo";
import { auditTools } from "./tools/audit-tools";
import { claimTools } from "./tools/claim-tools";
import { mergeTools } from "./tools/merge-tools";
import { reviewTools } from "./tools/review-tools";
import { setupTools } from "./tools/setup";
import { workTools } from "./tools/work-tools";

// GitHive's MCP tools (see docs/design.md). Each tool is stateless: it reads or writes the repo's records
// in Git and reports what Git said. Nothing here decides for anyone. An agent could do the same with plain
// git, and the audit reads the same records either way.

export type { HostedStatus, ToolContext } from "./tools/context";
export { DEFAULT_POLICY, hostedRoles, votesFor } from "./tools/repo";
export { INSTRUCTIONS, TOOLS } from "./tools/tool-list";
export { changeHistory, makeBranch, openCount, repoAudit, repoSnapshot, voteAsPerson } from "./tools/dashboard";

/**
 * Merges a change from the dashboard: the same batched, checked merge an agent asks for,
 * made as the change's agent and stamped with the person who asked.
 */
export async function mergeAsPerson(ctx: ToolContext, repo: string, change: string, person: string) {
	if (!person.startsWith("person:")) throw new Error("[403] only a person merges from the dashboard; agents use merge");
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const { claim } = await storeFor(ctx, repo, registry).readChange(change);
	if (!claim) throw new Error(`[409] ${change} holds no claim: there's nothing to merge`);
	const outcome = await callTool("merge", { repo, change, agent: claim.agent }, ctx);
	await ctx.ping?.(repo).catch(() => undefined);
	return outcome;
}

// Tools that write records, after which the repo's summary notes the activity.
const WRITES = new Set(["claim", "release", "merge", "vote", "build", "revert", "ask_human", "add_work", "settings"]);

const noted = new Map<string, number>();

/** Runs one tool and notes any write in the repo's summary. */
export async function callTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
	const result = await withNews(name, args, ctx, await runTool(name, args, ctx));
	const wrote = WRITES.has(name) && (result as { ok?: boolean } | null)?.ok !== false;
	if (wrote) await ctx.ping?.(requiredString(args, "repo")).catch(() => undefined);
	if (ctx.summarize && wrote) {
		const repo = requiredString(args, "repo");
		const merged = name === "merge";
		// Activity alone is noted at most every 10 seconds per repo, so a busy repo doesn't queue on the index.
		if (merged || Date.now() - (noted.get(repo) ?? 0) > 10_000) {
			noted.set(repo, Date.now());
			await ctx
				.summarize(repo, { lastActivity: new Date().toISOString(), ...(merged ? { mergedBy: 1 } : {}) })
				.catch((err) => console.error(`summarizing ${repo} failed`, String(err)));
		}
		// Refresh the summary's waiting list now, so the question reaches people's inboxes at once.
		if (name === "ask_human")
			await repoSnapshot(ctx, repo).catch((err) => console.error(`updating ${repo}'s inbox failed`, String(err)));
	}
	return result;
}

/**
 * Adds what landed on the project's branch since this agent was last told, so it hears of main moving
 * without asking. Only for object replies to a named agent, and it never fails the call.
 */
async function withNews(name: string, args: Args, ctx: ToolContext, result: unknown) {
	const agent = ctx.agent ?? (typeof args.agent === "string" ? args.agent : undefined);
	if (!ctx.news || !agent || name === "register" || !result || typeof result !== "object" || Array.isArray(result))
		return result;
	const repo = requiredString(args, "repo");
	const registry = await recordLog<Registry>(ctx, repo, claimsRef(repo))
		.read()
		.catch(() => null);
	if (!registry?.commit.state.baseline) return result;
	const branch = projectBranch(registry.commit.state);
	const news = await ctx.news(repo, branch, agent).catch(() => []);
	if (!news.length) return result;
	const says = (landed: (typeof news)[number]) => {
		const more = landed.filesMore ? ` and ${landed.filesMore} more` : "";
		const intent = landed.intent ? `, "${landed.intent}"` : "";
		return `${branch} changed ${landed.files.join(", ")}${more}: ${landed.change} by ${landed.agent}${intent}`;
	};
	return {
		...(result as Record<string, unknown>),
		news: news.map((landed) => ({ ...landed, says: says(landed) })),
	};
}

const handlers: ToolHandlers = {
	...setupTools,
	...claimTools,
	...workTools,
	...reviewTools,
	...mergeTools,
	...auditTools,
};

async function runTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
	const repo = requiredString(args, "repo");
	// The claims tool is advice, so it's served from the cached copy without reading the registry:
	// every call reading the project repo is what overloads a busy one.
	if (name === "claims" && ctx.keptClaims) return (await ctx.keptClaims(repo, () => advice(ctx, repo))).claims;
	const call = await openCall(args, ctx, runTool);
	const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
	if (!handler) throw new Error(`[400] unknown tool ${name}`);
	return handler(call);
}
