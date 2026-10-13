import { fail, requiredString } from "../errors";
import { toolEvent } from "../hive-events";
import { projectBranch } from "../project-branch";
import type { NewsItem } from "../repo-cache";
import type { Registry } from "./claims";
import { concernsOf } from "./ring-concerns";
import { type Args, openCall, presentedKey, type ToolContext, type ToolHandlers, verifiedAgent } from "./tools/context";
import { repoSnapshot } from "./tools/dashboard";
import { advice, claimsRef, recordLog, storeFor } from "./tools/repo";
import { auditTools } from "./tools/audit-tools";
import { claimTools } from "./tools/claim-tools";
import { githubTools } from "./tools/github-tools";
import { mergeTools } from "./tools/merge-tools";
import { withNext } from "./tools/next";
import { reviewTools } from "./tools/review-tools";
import { setupTools } from "./tools/setup";
import { waitTools } from "./tools/wait-tool";
import { workTools } from "./tools/work-tools";

// GitHive's MCP tools (see docs/design.md). Each tool is stateless: it reads or writes the repo's records
// in Git and reports what Git said. Nothing here decides for anyone. An agent could do the same with plain
// git, and the audit reads the same records either way.

export type { HostedStatus, ToolContext } from "./tools/context";
export { DEFAULT_POLICY, hostedRoles, votesFor } from "./tools/repo";
export { INSTRUCTIONS, TOOLS } from "./tools/tool-list";
export {
	changeHistory,
	giveUpAsPerson,
	makeBranch,
	openCount,
	repoAudit,
	repoSnapshot,
	voteAsPerson,
} from "./tools/dashboard";
export { bringGitHubBackAgain } from "./tools/github-tools";

/**
 * Merges a change from the dashboard: the same batched, checked merge an agent asks for,
 * made as the change's agent and stamped with the person who asked.
 */
export async function mergeAsPerson(ctx: ToolContext, repo: string, change: string, person: string) {
	if (!person.startsWith("person:")) fail(403, "only a person merges from the dashboard; agents use merge");
	const registry = (await recordLog<Registry>(ctx, repo, claimsRef(repo)).read())?.commit.state;
	const { claim } = await storeFor(ctx, repo, registry).readChange(change);
	if (!claim) fail(409, `${change} holds no claim: there's nothing to merge`);
	const outcome = await callTool("merge", { repo, change, agent: claim.agent }, ctx);
	await ctx.ping?.(repo).catch(() => undefined);
	return outcome;
}

// Tools that write records, after which the repo's summary notes the activity.
const WRITES = new Set([
	"claim",
	"release",
	"merge",
	"vote",
	"build",
	"revert",
	"ask_human",
	"add_work",
	"settings",
	"leave_review",
]);

const noted = new Map<string, number>();

/** Runs one tool and notes any write in the repo's summary. An object reply says what follows for the caller's change. */
export async function callTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
	const result = withNext(name, args, ctx, await withNews(name, args, ctx, await runTool(name, args, ctx)));
	const wrote = WRITES.has(name) && (result as { ok?: boolean } | null)?.ok !== false;
	const event = wrote ? toolEvent(name, args, ctx.agent) : null;
	if (wrote) {
		const whom = await concernsOf(name, args, ctx).catch(() => undefined);
		await ctx.ping?.(requiredString(args, "repo"), event ?? undefined, name, whom).catch(() => undefined);
	}
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
 * Adds what landed on the project's branch since this agent was last told, and its notices, so it hears of main
 * moving without asking. Only for object replies to the agent the call is verified as, never one an argument names:
 * a person merging from the dashboard, or a caller naming another agent, would use up that agent's news. It never
 * fails the call.
 */
async function withNews(name: string, args: Args, ctx: ToolContext, result: unknown) {
	if (!ctx.news || name === "register" || !result || typeof result !== "object" || Array.isArray(result)) return result;
	if (!ctx.agent && !presentedKey(args, ctx)) return result;
	const repo = requiredString(args, "repo");
	const registry = await recordLog<Registry>(ctx, repo, claimsRef(repo))
		.read()
		.catch(() => null);
	if (!registry?.commit.state.baseline) return result;
	const agent = await verifiedAgent(args, ctx, registry.commit.state).catch(() => undefined);
	if (!agent) return result;
	const branch = projectBranch(registry.commit.state);
	const news = await ctx.news(repo, branch, agent).catch((): NewsItem[] => []);
	if (!news.length) return result;
	const says = (landed: LandedNews) => {
		const more = landed.filesMore ? ` and ${landed.filesMore} more` : "";
		const intent = landed.intent ? `, "${landed.intent}"` : "";
		return `${branch} changed ${landed.files.join(", ")}${more}: ${landed.change} by ${landed.agent}${intent}`;
	};
	// Landings are told in a line made here; notices come with their own `says` and `next`.
	return {
		...(result as Record<string, unknown>),
		news: news.map((item) => (isLanded(item) ? { ...item, says: says(item) } : item)),
	};
}

type LandedNews = Extract<NewsItem, { kind: "landed" }>;
const isLanded = (item: NewsItem): item is LandedNews => item.kind === "landed";

const handlers: ToolHandlers = {
	...setupTools,
	...claimTools,
	...workTools,
	...reviewTools,
	...mergeTools,
	...auditTools,
	...githubTools,
	...waitTools,
};

async function runTool(name: string, args: Args, ctx: ToolContext): Promise<unknown> {
	const repo = requiredString(args, "repo");
	// The claims tool is advice, so it's served from the cached copy without reading the registry:
	// every call reading the project repo is what overloads a busy one.
	if (name === "claims" && ctx.keptClaims) return (await ctx.keptClaims(repo, () => advice(ctx, repo))).claims;
	const call = await openCall(args, ctx, runTool);
	const handler = Object.hasOwn(handlers, name) ? handlers[name] : undefined;
	if (!handler) fail(400, `unknown tool ${name}`);
	return handler(call);
}
