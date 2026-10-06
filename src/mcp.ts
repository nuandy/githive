import { projectBranch } from "./project-branch";
import { annotate, destroys, reads, writes } from "./tool-annotations";
import type { AccessIdentity } from "./access-contract";
import type { Coordinator } from "./coordinator";
import { fail, requiredPaths, requiredString as need, statusOf } from "./errors";
import { FREE_INSTRUCTIONS, FREE_TOOLS, callFreeTool, type FreeContext } from "./free/mcp";
import { identityLabel } from "./free/stamp";
import { awaitedExternalRoles } from "./open-mode";
import type { Task } from "./types";

// The MCP front door: any agent (Claude Code, Codex, a team's own bots) joins
// a repo in open mode, claims a lane, works on its own fork with plain git,
// and goes through the same Merge-ahead, review and gate as Blueprint's own
// agents. A stateless MCP server over HTTP (JSON-RPC 2.0, JSON responses, no
// sessions), behind Cloudflare Access like every other route.

type CoordinatorStub = Pick<
	Coordinator,
	| "claims"
	| "openChange"
	| "extendClaim"
	| "abandonChange"
	| "recordPush"
	| "startReviewers"
	| "state"
	| "readInbox"
	| "requestLaneChange"
	| "answerLaneChange"
	| "externalCredentials"
	| "registerAgent"
	| "submitExternalReview"
>;

export interface McpContext {
	/** Coordinator-free mode's context: when set, the free_* tools are served too. */
	free?: FreeContext;
	coordinator: (taskId: string) => CoordinatorStub;
	/** Open a repo for open changes (or find it open) and list it on the dashboard; the same as POST /repos/:repo/open. */
	openRepo: (repo: string) => Promise<Pick<Task, "id" | "repo" | "review" | "verify" | "leaseMinutes" | "branch">>;
	identity?: AccessIdentity;
	/** The caller's agent key (register_agent), from the X-Blueprint-Agent-Key header. */
	agentKey?: string;
	/** Read access to a change's fork, for a reviewer. */
	forkRead?: (repo: string) => Promise<{ url: string; token: string }>;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Blueprint coordinates many agents working on one repo at once. Each change you make has a lane: the paths you claim. No other agent can claim them until your change merges or is abandoned, and you must not change files outside your lane.
How to work:
1. join_repo to get the repo's task id; list_claims to see what others hold and why.
2. open_change with your intent and the paths you will touch. If someone holds a path, the refusal says who and why: narrow your claim, wait, or open on free paths and use request_lane_change to ask the holder.
3. open_change gives you your fork (one per agent, shared by your changes) and the branch to push this change to (changes/<id>). Start from the project (open_change's project, read-only), commit, and push your branch to your fork. After every push, call report_push: it checks your work against everyone else's and reports conflicts and files outside your lane.
4. Need more files? extend_claim. Credentials expired? refresh_credentials.
5. When done, finish_change with a summary. Reviewers vote and a gate runs the tests on your change merged with the project's branch. Poll change_status and read_inbox: if your change is sent back, the findings are in your inbox; fix, push, report_push and finish_change again.
6. Your claim expires after a while without activity unless you are waiting on review, the gate or a request.
Agents sharing one access token: register_agent once each, and send your key (X-Blueprint-Agent-Key, or agent_key) so your changes and reviews are yours.
Reviewing: a repo's policy may leave roles to outside agents. review_queue lists the changes waiting on a role, with read access to each fork; check out the exact head, review it against its intent, run the checks, and submit_review with your verdict and evidence. You can't review a change you opened, and you count for one role per commit.`;

const str = (description: string) => ({ type: "string", description });
const paths = { type: "array", items: { type: "string" }, description: "Repo-relative paths. A trailing slash claims a directory, e.g. src/billing/" };
const ids = { task_id: str("The open task id from join_repo"), change_id: str("Your change id from open_change") };
const agentKey = { agent_key: str("Your agent key from register_agent, if you can't send the X-Blueprint-Agent-Key header") };

const TOOL_DEFS = [
	{
		name: "join_repo",
		description: "Join a repo in open mode. Returns the task id every other tool needs, the review policy and the gate's verify commands. Safe to call again.",
		inputSchema: { type: "object", properties: { repo: str("Artifacts repo name, e.g. blueprint") }, required: ["repo"] },
	},
	{
		name: "list_claims",
		description: "Every active change on the repo: its id, title, intent and the paths it holds.",
		inputSchema: { type: "object", properties: { task_id: ids.task_id }, required: ["task_id"] },
	},
	{
		name: "open_change",
		description: "Open a change: claim paths as your lane and get your own fork to push to. Refused, naming the holder and its intent, if another change holds any of the paths.",
		inputSchema: {
			type: "object",
			properties: {
				task_id: ids.task_id,
				title: str("A short title"),
				intent: str("What this change sets out to do, for reviewers and other agents"),
				paths,
				agent: str("Your agent's name, shown to people on the dashboard (optional; letters, digits, . _ -). With an agent key, the registered name is used."),
				...agentKey,
			},
			required: ["task_id", "title", "intent", "paths"],
		},
	},
	{
		name: "extend_claim",
		description: "Add paths to your change's lane, if no other change holds them.",
		inputSchema: { type: "object", properties: { ...ids, paths }, required: ["task_id", "change_id", "paths"] },
	},
	{
		name: "abandon_change",
		description: "Give up your change and free its lane.",
		inputSchema: { type: "object", properties: { ...ids, reason: str("Why") }, required: ["task_id", "change_id", "reason"] },
	},
	{
		name: "refresh_credentials",
		description: "A fresh write token for your change's fork, when the previous one expired.",
		inputSchema: { type: "object", properties: ids, required: ["task_id", "change_id"] },
	},
	{
		name: "report_push",
		description: "Call after every push. Checks your fork against the project's branch and every other active change, and reports conflicts and files outside your lane.",
		inputSchema: { type: "object", properties: ids, required: ["task_id", "change_id"] },
	},
	{
		name: "finish_change",
		description: "Submit your pushed head for review. Reviewers vote; on approval a gate runs the tests on your change merged with the project's branch, then it merges.",
		inputSchema: { type: "object", properties: { ...ids, summary: str("What you changed and how you verified it, for the reviewers") }, required: ["task_id", "change_id", "summary"] },
	},
	{
		name: "change_status",
		description: "Your change's status: building, under review, votes, the gate, merged, or needing a human, plus the last review findings.",
		inputSchema: { type: "object", properties: ids, required: ["task_id", "change_id"] },
	},
	{
		name: "read_inbox",
		description: "Messages for your change: review findings when it is sent back, cross-lane requests from other changes, and their answers.",
		inputSchema: { type: "object", properties: { ...ids, since: str("Only messages after this ISO time (optional)") }, required: ["task_id", "change_id"] },
	},
	{
		name: "request_lane_change",
		description: "Ask the change that holds a path for a change there. It is delivered to that change's agent and recorded.",
		inputSchema: {
			type: "object",
			properties: { ...ids, path: str("The path you need changed"), need: str("What change you need"), reason: str("Why your change needs it") },
			required: ["task_id", "change_id", "path", "need", "reason"],
		},
	},
	{
		name: "answer_lane_change",
		description: "Answer a request another change sent you: done (after you pushed the change in your own lane) or declined, with an explanation.",
		inputSchema: {
			type: "object",
			properties: { ...ids, request_id: str("The request id from your inbox"), outcome: { type: "string", enum: ["done", "declined"] }, answer: str("What you did, or why not") },
			required: ["task_id", "change_id", "request_id", "outcome", "answer"],
		},
	},
	{
		name: "register_agent",
		description: "Register your agent on the task under a name, and get its secret key (shown once). Send the key with your calls (X-Blueprint-Agent-Key header, or agent_key) so changes and reviews are told apart even when agents share one access token. Registering again rotates the key, with the current one.",
		inputSchema: { type: "object", properties: { task_id: ids.task_id, agent: str("Your agent's name: letters, digits, . _ -"), ...agentKey }, required: ["task_id", "agent"] },
	},
	{
		name: "review_queue",
		description: "Changes waiting for an outside reviewer: the commit to review, its intent and summary, the roles still needed, and read access to its fork. Changes you opened aren't listed.",
		inputSchema: { type: "object", properties: { task_id: ids.task_id, role: str("Only changes waiting on this role (optional)"), ...agentKey }, required: ["task_id"] },
	},
	{
		name: "submit_review",
		description: "Submit your review of the exact commit under review, for one of the roles outside agents review. A rejection goes back to the change's author with your evidence.",
		inputSchema: {
			type: "object",
			properties: {
				task_id: ids.task_id,
				change_id: str("The change you reviewed"),
				head: str("The commit you reviewed (review_queue's head)"),
				role: str("The role you reviewed for"),
				verdict: { type: "string", enum: ["approve", "reject"] },
				summary: str("One or two sentences: what you checked and your conclusion"),
				evidence: str("Commands you ran with their key output, or file:line references; for a rejection, what must change"),
				...agentKey,
			},
			required: ["task_id", "change_id", "head", "role", "verdict", "summary", "evidence"],
		},
	},
] as const;

export const TOOLS = annotate(TOOL_DEFS, {
	join_repo: writes("Join a repo", { idempotent: true }),
	list_claims: reads("List claims"),
	open_change: writes("Open a change"),
	extend_claim: writes("Extend a claim", { idempotent: true }),
	abandon_change: destroys("Abandon a change", { idempotent: true }),
	refresh_credentials: writes("Refresh fork credentials", { idempotent: true }),
	report_push: writes("Report a push", { idempotent: true }),
	finish_change: writes("Submit for review"),
	change_status: reads("Change status"),
	read_inbox: reads("Read inbox"),
	request_lane_change: writes("Request a change in another claim"),
	answer_lane_change: writes("Answer a request"),
	register_agent: destroys("Register an agent key"),
	review_queue: reads("Review queue"),
	submit_review: writes("Submit a review"),
});

const sha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");

/** The caller's key, from the header or the arguments. */
const keyOf = (args: Args, ctx: McpContext) => ctx.agentKey ?? (typeof args.agent_key === "string" && args.agent_key ? args.agent_key : undefined);

/** The registered agent whose key this is, or a 403. */
async function agentOfKey(task: Task, key: string) {
	const hash = await sha256(key);
	const name = Object.entries(task.agents ?? {}).find(([, a]) => a.keyHash === hash)?.[0];
	return name ?? fail(403, "unknown agent key for this task: register_agent first");
}

/** Who is calling, for telling authors and reviewers apart: a registered agent, or the Access identity. */
async function callerBy(task: Task, args: Args, ctx: McpContext) {
	const key = keyOf(args, ctx);
	if (key) return `agent:${await agentOfKey(task, key)}`;
	return ctx.identity ? identityLabel(ctx.identity) : fail(401, "no identity: call through Cloudflare Access, or with an agent key");
}

type Args = Record<string, unknown>;

async function callTool(name: string, args: Args, ctx: McpContext): Promise<unknown> {
	const co = () => ctx.coordinator(need(args, "task_id"));
	switch (name) {
		case "join_repo": {
			const task = await ctx.openRepo(need(args, "repo"));
			return { task_id: task.id, repo: task.repo, branch: projectBranch(task), review: task.review, verify: task.verify, lease_minutes: task.leaseMinutes, instructions: INSTRUCTIONS };
		}
		case "list_claims":
			return co().claims();
		case "open_change": {
			const key = keyOf(args, ctx);
			const authorAgent = key ? await agentOfKey(await co().state(), key) : undefined;
			if (authorAgent && typeof args.agent === "string" && args.agent && args.agent !== authorAgent) fail(403, `your key is ${authorAgent}'s, not ${args.agent}'s`);
			const { change, credentials } = await co().openChange(
				{ title: need(args, "title"), intent: need(args, "intent"), owns: requiredPaths(args, "paths"), agent: typeof args.agent === "string" ? args.agent : undefined, ...(authorAgent ? { authorAgent } : {}) },
				ctx.identity,
			);
			const branch = projectBranch(await co().state());
			return {
				change_id: change.id,
				lane: change.owns,
				lease_until: change.leaseUntil,
				fork: credentials.remote,
				token: credentials.token,
				branch: credentials.ref ?? branch,
				...(credentials.project ? { project: credentials.project } : {}),
				how_to: `Clone the project (project.remote, its branch ${branch}, with project.token); create the branch ${credentials.ref ?? branch}; commit; push it to your fork (fork, with token: http.extraHeader "Authorization: Bearer <token without ?expires=...>"); then call report_push.`,
			};
		}
		case "extend_claim": {
			const slice = await co().extendClaim(need(args, "change_id"), requiredPaths(args, "paths"));
			return { lane: slice.owns, lease_until: slice.leaseUntil };
		}
		case "abandon_change": {
			const slice = await co().abandonChange(need(args, "change_id"), need(args, "reason"), ctx.identity);
			return { status: slice.status };
		}
		case "refresh_credentials":
			return co().externalCredentials(need(args, "change_id"));
		case "report_push": {
			const changeId = need(args, "change_id");
			const { task, checks, changed } = await co().recordPush(changeId);
			const slice = task.slices.find((s) => s.id === changeId)!;
			return {
				changed,
				head: slice.head,
				outside_lane: slice.outOfLane,
				conflicts: checks.filter((c) => c.status === "conflict").map((c) => ({ with: c.pair.find((p) => p !== changeId), files: c.files })),
				advice: slice.outOfLane.length
					? "Revert the files outside your lane, or extend_claim to them if they are free, then push and report again."
					: "No problem with your lane.",
			};
		}
		case "finish_change": {
			const result = await co().startReviewers(need(args, "change_id"), need(args, "summary"));
			return result.escalated
				? { status: "needs a human", detail: "You were sent back but finished without a new commit; a human decides next." }
				: { status: "in review", head: result.head, reviewers: result.reviewers };
		}
		case "register_agent": {
			const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
			const current = keyOf(args, ctx);
			const { agent, rotated } = await co().registerAgent(need(args, "agent"), await sha256(key), current ? await sha256(current) : undefined, ctx.identity);
			return { agent, key, note: `${rotated ? "Key rotated: the old one no longer works. " : ""}Keep this key secret; it is shown once. Send it as the X-Blueprint-Agent-Key header (or agent_key) with your calls.` };
		}
		case "review_queue": {
			const task = await co().state();
			const by = await callerBy(task, args, ctx);
			const role = typeof args.role === "string" && args.role ? args.role : undefined;
			const waiting = task.slices.filter((s) => s.status === "building" && s.reviewHead && s.sentBackFor !== s.reviewHead && !s.attention && s.authorBy !== by);
			const reviews = [];
			for (const s of waiting) {
				const roles = awaitedExternalRoles(s).filter((r) => !role || r === role);
				if (!roles.length) continue;
				const fork = ctx.forkRead ? await ctx.forkRead(s.repo!) : undefined;
				reviews.push({
					change_id: s.id,
					title: s.title,
					intent: s.intent ?? s.instructions,
					summary: s.buildSummary,
					head: s.reviewHead,
					base: s.mergeBase ?? s.startCommit ?? task.baseCommit,
					branch: projectBranch(task),
					roles,
					paths: s.touched.length ? s.touched : s.owns,
					...(fork ? { fork: fork.url, token: fork.token } : {}),
				});
			}
			return { reviews, how_to: "Fetch the head from the fork (the token is read-only), git diff <base> <head> for the change, run the checks, then submit_review." };
		}
		case "submit_review": {
			const task = await co().state();
			const by = await callerBy(task, args, ctx);
			const verdict = need(args, "verdict");
			if (verdict !== "approve" && verdict !== "reject") fail(400, "verdict is approve or reject");
			const { quorum, next } = await co().submitExternalReview(
				need(args, "change_id"),
				{ reviewer: need(args, "role"), head: need(args, "head"), verdict, summary: need(args, "summary"), evidence: need(args, "evidence") },
				by,
			);
			return { recorded: true, review: quorum.status, next };
		}
		case "change_status": {
			const changeId = need(args, "change_id");
			const task = await co().state();
			const s = task.slices.find((x) => x.id === changeId);
			if (!s) fail(404, `no change ${changeId}`);
			return {
				status: s.status === "integrated" ? "merged" : s.attention ? "needs a human" : s.gate ? `gate ${s.gate.status}` : s.reviewHead && s.reviewHead !== s.sentBackFor ? "in review" : s.status,
				lane: s.owns,
				head: s.head,
				review_head: s.reviewHead,
				votes: s.reviews.filter((r) => r.head === s.reviewHead).map((r) => ({ role: r.reviewer, verdict: r.verdict, summary: r.summary })),
				gate: s.gate && { status: s.gate.status, results: s.gate.result?.results.map((r) => ({ command: r.command, exit: r.exitCode })) },
				attention: s.attention,
				last_feedback: s.lastFeedback,
				revisions: s.revisions ?? 0,
				lease_until: s.leaseUntil,
			};
		}
		case "read_inbox":
			return co().readInbox(need(args, "change_id"), typeof args.since === "string" ? args.since : undefined);
		case "request_lane_change":
			return co().requestLaneChange(need(args, "change_id"), { path: need(args, "path"), need: need(args, "need"), reason: need(args, "reason") });
		case "answer_lane_change": {
			const outcome = need(args, "outcome");
			if (outcome !== "done" && outcome !== "declined") fail(400, "outcome must be done or declined");
			return co().answerLaneChange(need(args, "change_id"), need(args, "request_id"), { outcome, answer: need(args, "answer") });
		}
		default:
			fail(404, `unknown tool ${name}`);
	}
}

interface RpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method?: string;
	params?: Record<string, unknown>;
}

const reply = (id: RpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** Handle one JSON-RPC message. Returns null for notifications, which get no response. */
export async function handleRpc(msg: RpcRequest, ctx: McpContext): Promise<object | null> {
	if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "invalid request");
	const isNotification = msg.id === undefined;
	if (isNotification) return null;
	switch (msg.method) {
		case "initialize": {
			const requested = msg.params?.protocolVersion;
			const protocolVersion = typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
			return reply(msg.id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "blueprint", version: "1.0.0" }, instructions: ctx.free ? `${INSTRUCTIONS}\n\n${FREE_INSTRUCTIONS}` : INSTRUCTIONS });
		}
		case "ping":
			return reply(msg.id, {});
		case "tools/list":
			return reply(msg.id, { tools: ctx.free ? [...TOOLS, ...FREE_TOOLS] : TOOLS });
		case "tools/call": {
			const name = msg.params?.name;
			const free = ctx.free && FREE_TOOLS.some((t) => t.name === name) ? ctx.free : null;
			if (typeof name !== "string" || (!free && !TOOLS.some((t) => t.name === name))) return rpcError(msg.id, -32602, `unknown tool ${String(name)}`);
			try {
				const args = (msg.params?.arguments as Args) ?? {};
				const result = free ? await callFreeTool(name, args, free) : await callTool(name, args, ctx);
				return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
			} catch (err) {
				// Tool failures go back to the agent as results it can act on, not protocol errors.
				return reply(msg.id, { content: [{ type: "text", text: statusOf(err).message }], isError: true });
			}
		}
		default:
			return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
	}
}

/** Handle a POST body: one message or a batch. Null means respond 202 with no body. */
export async function handleMcpBody(body: unknown, ctx: McpContext): Promise<object | object[] | null> {
	if (Array.isArray(body)) {
		const out = (await Promise.all(body.map((m) => handleRpc(m as RpcRequest, ctx)))).filter((r): r is object => r !== null);
		return out.length ? out : null;
	}
	return handleRpc(body as RpcRequest, ctx);
}
