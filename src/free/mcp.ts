import type { CasLog } from "../election";
import { GitCasLog } from "../election-git";
import { requiredPaths, requiredString } from "../errors";
import { branchHead, type Remote } from "../git";
import { changeId, normalizeClaim } from "../open-mode";
import { audit } from "./audit";
import { checkChange } from "./check";
import { activeClaims, claim, registerAgent, release, releaseStale, startFree, type Registry } from "./claims";
import { readMainMerges, readRecordHistory } from "./git-records";
import { type CheckRunner, mergeChange } from "./merge";
import { revertViolation } from "./revert";
import type { Stamper } from "./stamp";
import { approval, countedVotes, vote, type ReviewPolicy, type VoteRecord, type Votes } from "./votes";

// The coordinator-free MCP tools (see docs/coordinator-free.md). Stateless: each
// tool reads or writes the repo's records in Git and reports what Git said.
// Nothing here decides for anyone; an agent can do the same with plain git,
// and the audit reads the same records either way.

export interface FreeContext {
	/** Credentials for a project repo. */
	remote: (repo: string, scope: "read" | "write") => Promise<Remote>;
	/** A record's log (claims, votes), kept across calls so an unmoved ref isn't fetched again; without it, each call makes its own. */
	records?: <S>(repo: string, ref: string) => CasLog<S>;
	/** Credentials for a change's own fork of a project repo (forks access); asking to write creates the fork. */
	changeRemote?: (repo: string, change: string, scope: "read" | "write") => Promise<Remote>;
	/** Main's head in a project repo. */
	head: (repo: string) => Promise<string>;
	/** Runs a repo's checks on main plus a change (live, the Gate's container). */
	runChecks?: (repo: string) => CheckRunner;
	/** Stamps what this caller writes with their verified identity (Blueprint's key), and the agent name their key is for; without it, nothing is stamped. */
	stamper?: (agent?: string) => Promise<Stamper | undefined>;
	/** The caller's agent key (free_register), from the X-Blueprint-Agent-Key header. */
	agentKey?: string;
	/** Blueprint's own hosted agents, who act under the reserved blueprint- names. */
	hosted?: boolean;
	/** Notes a repo in coordinator-free mode, so the dashboard can list it. */
	register?: (repo: string) => Promise<void>;
	/** Starts Blueprint's hosted reviewers on a change's current commit; each votes with free_vote (and, asked to, then tries to merge it). */
	requestReview?: (input: { repo: string; change: string; roles: string[]; summary?: string; mergeWhenApproved?: boolean }) => Promise<{ head: string; reviewers: string[] }>;
	/** What Blueprint's hosted agents on a change are doing: its builder, and the reviewers of its head. */
	agentStatus?: (repo: string, change: string, head: string | null, roles: string[]) => Promise<HostedStatus>;
	/** Starts Blueprint's hosted builder on a claimed change. */
	startBuilder?: (input: { repo: string; change: string }) => Promise<{ change: string; builder: string }>;
}

export interface HostedStatus {
	builder?: { status: string; revisions: number; error?: string };
	reviewers: { role: string; status: string; verdict?: string }[];
}

const DEFAULT_POLICY: ReviewPolicy = { required: 2, vetoes: ["security"] };
const HOSTED_PREFIX = "blueprint-";
const STALE_AFTER_MS = 30 * 60_000;
const claimsRef = (repo: string) => `refs/notes/blueprint-claims/${repo}`;
const votesRef = (repo: string) => `refs/notes/blueprint-votes/${repo}`;

export const FREE_INSTRUCTIONS = `Coordinator-free mode (the free_* tools): nobody enforces the rules; every agent follows them, and an audit anyone can run shows who didn't.
Conventions:
1. free_claim the paths you will change before editing; edit only inside your claim. A refusal names who holds what: narrow your claim, or ask them.
2. Work on a branch changes/<change> and push it where free_credentials with your change says: its own fork (only you can write it), or the project repo if it's shared. The project's main is written only through the toolkit.
3. Reviewers free_vote on the exact commit they reviewed. A change merges with the policy's approvals and no veto. free_status shows your change's votes, with the evidence for any rejection to fix, and what's still needed.
4. Run free_check after you push: it test-merges your change with main and lists files outside your claim, so you hear about problems before merging.
5. free_merge merges your branch with trailers recording the claims and votes it checked, then releases your claim. Merge by hand only with the same trailers.
6. Claiming again (same paths) keeps your claim active. A claim idle for 30 minutes is released by whoever claims its paths, or by anyone (free_release with stale: true).
7. Anyone may free_revert a commit free_audit reports; the audit then counts it resolved.
8. free_request_review asks Blueprint's hosted reviewers for votes on your change; free_build has Blueprint's hosted builder make a change from start to merge.
9. Agents that share an Access identity tell themselves apart with free_register: it returns your agent key once; send it (header X-Blueprint-Agent-Key, or agent_key) with every call, and what you write is attributed to you. A registered name is never used without its key.
free_audit replays the records and lists every broken convention, with the commit and the agent.`;

const str = { type: "string" } as const;
const TOOL_LIST = [
	{ name: "free_start", description: "Start coordinator-free mode on a project repo (harmless if started): the review policy, the checks run before each merge, and access: forks (default: each change in its own fork, only the toolkit writes the project) or shared (every agent writes the project repo). Returns them.", inputSchema: { type: "object", properties: { repo: str, required: { type: "number" }, vetoes: { type: "array", items: str }, verify: { type: "array", items: str }, access: { type: "string", enum: ["forks", "shared"] } }, required: ["repo"] } },
	{ name: "free_credentials", description: "Git access. With your change: a write token for where its branch changes/<change> lives (its own fork, unless the repo is shared). Without: read access to the project repo.", inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo"] } },
	{ name: "free_claims", description: "The claims in force: who holds which paths, and why.", inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] } },
	{ name: "free_claim", description: "Claim paths for your change (again to extend it, or to keep it active). Refused, naming the holder, if another claim overlaps; a claim in the way idle for 30 minutes is released as stale instead.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str, paths: { type: "array", items: str }, intent: str }, required: ["repo", "change", "agent", "paths", "intent"] } },
	{ name: "free_release", description: "Release a claim: yours, or another's idle for 30 minutes with stale: true.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str, reason: str, stale: { type: "boolean" } }, required: ["repo", "change", "agent"] } },
	{ name: "free_vote", description: "Record your review verdict on the exact commit you reviewed.", inputSchema: { type: "object", properties: { repo: str, commit: str, reviewer: str, role: str, verdict: { type: "string", enum: ["approve", "reject"] }, evidence: str }, required: ["repo", "commit", "reviewer", "role", "verdict", "evidence"] } },
	{ name: "free_merge", description: "Merge changes/<change> into main if the conventions hold, recording what was checked, then release the claim.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str }, required: ["repo", "change", "agent"] } },
	{ name: "free_build", description: "Have Blueprint's hosted builder make a change: it claims the paths, builds on changes/<change>, asks the hosted reviewers when done, and the change merges once approved and checked.", inputSchema: { type: "object", properties: { repo: str, intent: str, paths: { type: "array", items: str } }, required: ["repo", "intent", "paths"] } },
	{ name: "free_request_review", description: "Ask Blueprint's hosted reviewer agents to review your change's current commit (by default the tests role and every veto role); each votes with free_vote.", inputSchema: { type: "object", properties: { repo: str, change: str, roles: { type: "array", items: str }, summary: str }, required: ["repo", "change"] } },
	{ name: "free_audit", description: "Replay the records and list every broken convention, with the commit and the agent (and whether a revert has resolved it).", inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] } },
	{ name: "free_revert", description: "Revert a commit the audit reports: its files go back to how they were before it, in a commit naming what it reverts.", inputSchema: { type: "object", properties: { repo: str, commit: str, agent: str }, required: ["repo", "commit", "agent"] } },
	{ name: "free_status", description: "Where a change stands: its claim (or how it ended), its branch head, the votes on that head with their evidence, the approvals still needed, and what Blueprint's hosted agents on it are doing.", inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo", "change"] } },
	{ name: "free_check", description: "An early check on your change, any time before merging: whether it still merges cleanly into main, and any files outside your claim. (Claims keep changes apart, so it doesn't check other changes: only files outside a claim could collide.) Reports only.", inputSchema: { type: "object", properties: { repo: str, change: str }, required: ["repo", "change"] } },
	{ name: "free_register", description: "Register your agent name and get its secret key (shown once), so what you write is attributed to you even if you share an Access identity. With your current key, rotates it.", inputSchema: { type: "object", properties: { repo: str, agent: str }, required: ["repo", "agent"] } },
];
// Every tool takes the caller's agent key, for clients that can't set the header.
export const FREE_TOOLS = TOOL_LIST.map((t) => ({ ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, agent_key: { type: "string", description: "Your agent key from free_register, if you can't send the X-Blueprint-Agent-Key header" } } } }));

const sha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");

/** The agent name a key is for, checked against the registry; keys are `<agent>.<secret>`. */
async function keyAgent(registry: Registry | undefined, key: string) {
	const agent = key.slice(0, Math.max(0, key.lastIndexOf(".")));
	const record = agent ? registry?.agents?.[agent] : undefined;
	if (!record || record.keyHash !== (await sha256(key))) throw new Error("[403] unknown agent key");
	return agent;
}

/** Refuses acting as `name`: another name than the caller's key is for, a registered name without its key, or a hosted agent's name. */
function mayActAs(name: string, acting: string | undefined, registry: Registry | undefined, hosted: boolean | undefined) {
	if (acting) {
		if (name !== acting) throw new Error(`[403] your agent key is ${acting}'s; it can't act as ${name}`);
		return;
	}
	if (hosted) return;
	if (name.startsWith(HOSTED_PREFIX)) throw new Error("[403] blueprint- names are Blueprint's hosted agents'");
	if (registry?.agents?.[name]) throw new Error(`[403] ${name} is registered: call with its agent key`);
}

export type Args = Record<string, unknown>;

/** A record's log: the context's shared one, or one for this call. */
function recordLog<S>(ctx: FreeContext, repo: string, ref: string): CasLog<S> {
	return ctx.records ? ctx.records<S>(repo, ref) : new GitCasLog<S>(() => ctx.remote(repo, "write"), repo, ref);
}

/** Where a repo's change branches live: each change's own fork, or the project repo when it's shared (as repos started before forks are). */
function changeSourceFor(ctx: FreeContext, repo: string, registry: Registry | null | undefined) {
	const access = registry?.access ?? "shared";
	return (change: string, scope: "read" | "write") => {
		if (access === "shared") return ctx.remote(repo, scope);
		if (!ctx.changeRemote) throw new Error("[501] change forks aren't available here");
		return ctx.changeRemote(repo, change, scope);
	};
}

/** Where a change stands: its branch head, the votes on that head, the approvals against the policy, and Blueprint's hosted agents on it. */
async function changeStatus(ctx: FreeContext, repo: string, registry: Registry | null | undefined, cast: VoteRecord[], counted: VoteRecord[], change: string) {
	// No fork yet means nothing pushed yet.
	const head = await Promise.resolve()
		.then(() => changeSourceFor(ctx, repo, registry)(change, "read"))
		.then((source) => branchHead(source, `changes/${change}`))
		.catch(() => null);
	const policy = registry?.policy ?? DEFAULT_POLICY;
	const outcome = head ? approval({ votes: counted }, head, policy) : { approved: false, approvals: 0, vetoedBy: [] };
	const hosted = ctx.agentStatus ? await ctx.agentStatus(repo, change, head, [...new Set(["tests", ...policy.vetoes])]).catch(() => undefined) : undefined;
	return { head, votes: head ? cast.filter((v) => v.commit === head) : [], approval: { ...outcome, required: policy.required }, ...(hosted ? { hosted } : {}) };
}

/** Replay a repo's records from Git: how many commits on main since the mode started, and what broke which convention. */
async function runAudit(ctx: FreeContext, repo: string) {
	const remote = await ctx.remote(repo, "read");
	const registry = await readRecordHistory<Registry>(remote, claimsRef(repo));
	const baseline = registry[0]?.state.baseline;
	if (!baseline) throw new Error(`[409] coordinator-free mode hasn't started on ${repo}`);
	const merges = await readMainMerges(remote, baseline);
	const start = registry[0].state;
	const violations = await audit({ registry, votes: await readRecordHistory<Votes>(remote, votesRef(repo)), policy: start.policy ?? DEFAULT_POLICY, verify: start.verify, merges });
	return { merges: merges.length, violations };
}

/** Everything the dashboard shows for a repo in coordinator-free mode, read from Git. */
export async function freeSnapshot(ctx: FreeContext, repo: string) {
	const [registry, votes] = await Promise.all([recordLog<Registry>(ctx, repo, claimsRef(repo)).read(), recordLog<Votes>(ctx, repo, votesRef(repo)).read()]);
	const state = registry?.commit.state;
	if (!state?.baseline) throw new Error(`[404] coordinator-free mode hasn't started on ${repo}`);
	const { merges, violations } = await runAudit(ctx, repo);
	const cast = votes?.commit.state.votes ?? [];
	const counted = await countedVotes(cast, state.stampKey);
	const claims = await Promise.all(
		activeClaims(state).map(async (c) => {
			const { head, approval, hosted } = await changeStatus(ctx, repo, state, cast, counted, c.change);
			return { ...c, head, approval, ...(hosted ? { hosted } : {}) };
		}),
	);
	return {
		repo,
		policy: state.policy ?? DEFAULT_POLICY,
		verify: state.verify ?? [],
		/** Whether records and merges are stamped with verified identity. */
		verified: !!state.stampKey,
		access: state.access ?? "shared",
		/** The claims in force, each with where its change stands. */
		claims,
		/** The latest votes, newest first. */
		votes: (votes?.commit.state.votes ?? []).slice(-20).reverse(),
		audit: { merges, open: violations.filter((v) => !v.resolvedBy).length, violations },
	};
}

/** Run one coordinator-free tool. */
export async function callFreeTool(name: string, args: Args, ctx: FreeContext): Promise<unknown> {
	const repo = requiredString(args, "repo");
	const write = () => ctx.remote(repo, "write");
	const claims = recordLog<Registry>(ctx, repo, claimsRef(repo));
	const votes = recordLog<Votes>(ctx, repo, votesRef(repo));
	// Read once per call; only free_start, which writes it first, reads it again.
	const registered = (await claims.read())?.commit.state;
	const key = ctx.agentKey ?? (typeof args.agent_key === "string" ? args.agent_key : undefined);
	const acting = key ? await keyAgent(registered, key) : undefined;
	const actAs = (field: string) => {
		const agent = requiredString(args, field);
		mayActAs(agent, acting, registered, ctx.hosted);
		return agent;
	};
	const stamper = await ctx.stamper?.(acting);
	const access = registered?.access ?? "shared";
	const changeSource = changeSourceFor(ctx, repo, registered);
	switch (name) {
		case "free_start": {
			const policy: ReviewPolicy = {
				required: typeof args.required === "number" ? args.required : DEFAULT_POLICY.required,
				vetoes: Array.isArray(args.vetoes) ? (args.vetoes as string[]) : DEFAULT_POLICY.vetoes,
			};
			const verify = Array.isArray(args.verify) ? (args.verify as string[]).filter((c) => typeof c === "string" && c.trim()) : [];
			await startFree(claims, { baseline: await ctx.head(repo), policy, verify, stampKey: stamper?.publicKey, access: args.access === "shared" ? "shared" : "forks" });
			await ctx.register?.(repo);
			const registry = (await claims.read())?.commit.state;
			return { repo, policy: registry?.policy ?? policy, verify: registry?.verify ?? [], access: registry?.access ?? "shared", instructions: FREE_INSTRUCTIONS };
		}
		case "free_credentials": {
			if (access === "shared") {
				const remote = await write();
				return { url: remote.url, token: remote.token };
			}
			if (typeof args.change !== "string" || !args.change.trim()) {
				const remote = await ctx.remote(repo, "read");
				return { url: remote.url, token: remote.token, note: "read-only: the project repo is written only through the toolkit. Ask with your change for write access to its fork." };
			}
			const change = requiredString(args, "change");
			const own = activeClaims(registered).find((c) => c.change === change);
			if (!own) throw new Error(`[409] ${change} holds no claim: claim its paths first`);
			mayActAs(own.agent, acting, registered, ctx.hosted);
			const remote = await changeSource(change, "write");
			return { url: remote.url, token: remote.token, branch: `changes/${change}`, note: "Your change's own fork: push your branch changes/<change> here. Fetch main from the project repo (free_credentials without change)." };
		}
		case "free_claims":
			return activeClaims(registered);
		case "free_claim":
			return claim(claims, {
				change: requiredString(args, "change"),
				agent: actAs("agent"),
				paths: normalizeClaim(requiredPaths(args, "paths")),
				intent: requiredString(args, "intent"),
				staleAfterMs: STALE_AFTER_MS,
			}, stamper);
		case "free_release": {
			const change = requiredString(args, "change");
			const agent = actAs("agent");
			if (args.stale === true) return releaseStale(claims, { change, agent, staleAfterMs: STALE_AFTER_MS }, stamper);
			return release(claims, { change, agent, reason: typeof args.reason === "string" ? args.reason : "released" }, stamper);
		}
		case "free_vote": {
			const verdict = requiredString(args, "verdict");
			if (verdict !== "approve" && verdict !== "reject") throw new Error("[400] verdict is approve or reject");
			return vote(votes, { commit: requiredString(args, "commit"), reviewer: actAs("reviewer"), role: requiredString(args, "role"), verdict, evidence: requiredString(args, "evidence") }, stamper);
		}
		case "free_merge": {
			// mergeChange reads the claims again itself, when it checks them.
			const registry = registered;
			// Anyone may merge a change whose conventions hold; it merges as its claim's agent, and the stamp says who asked.
			const change = requiredString(args, "change");
			const holder = activeClaims(registry).find((c) => c.change === change)?.agent;
			if (holder && holder !== requiredString(args, "agent")) throw new Error(`[409] ${change} is ${holder}'s change: merge it as ${holder}`);
			return mergeChange({
				remote: await write(),
				claims,
				votes,
				policy: registry?.policy ?? DEFAULT_POLICY,
				verify: registry?.verify ?? [],
				runChecks: ctx.runChecks?.(repo),
				stamper,
				stampKey: registry?.stampKey,
				source: await changeSource(change, "read"),
				change,
				agent: requiredString(args, "agent"),
			});
		}
		case "free_build": {
			if (!ctx.startBuilder) throw new Error("[501] hosted builders aren't available here");
			const intent = requiredString(args, "intent");
			const change = changeId(intent);
			const claimed = await claim(claims, { change, agent: "blueprint-builder", paths: normalizeClaim(requiredPaths(args, "paths")), intent, staleAfterMs: STALE_AFTER_MS }, stamper);
			if (!claimed.ok) return claimed;
			return ctx.startBuilder({ repo, change });
		}
		case "free_request_review": {
			const change = requiredString(args, "change");
			const registry = registered;
			if (!activeClaims(registry).some((c) => c.change === change)) throw new Error(`[409] ${change} holds no claim: claim the change's paths first`);
			if (!ctx.requestReview) throw new Error("[501] hosted reviewers aren't available here");
			const policy = registry?.policy ?? DEFAULT_POLICY;
			const roles = Array.isArray(args.roles) && args.roles.length ? (args.roles as string[]) : [...new Set(["tests", ...policy.vetoes])];
			return ctx.requestReview({ repo, change, roles, ...(typeof args.summary === "string" ? { summary: args.summary } : {}) });
		}
		case "free_audit": {
			const { merges, violations } = await runAudit(ctx, repo);
			return { merges, open: violations.filter((v) => !v.resolvedBy).length, violations };
		}
		case "free_revert": {
			const { violations } = await runAudit(ctx, repo);
			return revertViolation({ remote: await write(), claims, votes, stamper, target: requiredString(args, "commit"), violations, agent: actAs("agent") });
		}
		case "free_status": {
			const change = requiredString(args, "change");
			const held = activeClaims(registered).find((c) => c.change === change) ?? null;
			const released = held ? undefined : registered?.released.findLast((r) => r.change === change);
			const cast = (await votes.read())?.commit.state.votes ?? [];
			return { change, claim: held, ...(released ? { released } : {}), ...(await changeStatus(ctx, repo, registered, cast, await countedVotes(cast, registered?.stampKey), change)) };
		}
		case "free_check":
		{
			const change = requiredString(args, "change");
			const source = await changeSource(change, "read").catch(() => null);
			if (!source) throw new Error(`[409] changes/${change} has nothing pushed to check`);
			return checkChange({ project: await ctx.remote(repo, "read"), source, claims: activeClaims(registered), change });
		}
		case "free_register": {
			const agent = requiredString(args, "agent");
			if (agent.startsWith(HOSTED_PREFIX) && !ctx.hosted) throw new Error("[403] blueprint- names are Blueprint's hosted agents'");
			const secret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
			const newKey = `${agent}.${secret}`;
			const outcome = await registerAgent(claims, { agent, keyHash: await sha256(newKey), ...(acting ? { holder: acting } : {}) }, stamper);
			if (!outcome.ok) throw new Error(`[409] ${outcome.refused}`);
			return { agent, key: newKey, note: "Keep this key secret; it is shown once. Send it as X-Blueprint-Agent-Key (or agent_key) with every call." };
		}
		default:
			throw new Error(`[400] unknown tool ${name}`);
	}
}
