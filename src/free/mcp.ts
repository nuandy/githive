import { GitCasLog } from "../election-git";
import { requiredPaths, requiredString, statusOf } from "../errors";
import type { Remote } from "../git";
import { normalizeClaim } from "../open-mode";
import { audit } from "./audit";
import { activeClaims, claim, release, releaseStale, startFree, type Registry } from "./claims";
import { readMainMerges, readRecordHistory } from "./git-records";
import { type CheckRunner, mergeChange } from "./merge";
import { vote, type ReviewPolicy, type Votes } from "./votes";

// The coordinator-free MCP tools (see docs/coordinator-free.md). Stateless: each
// tool reads or writes the repo's records in Git and reports what Git said.
// Nothing here decides for anyone; an agent can do the same with plain git,
// and the audit reads the same records either way.

export interface FreeContext {
	/** Credentials for a project repo. */
	remote: (repo: string, scope: "read" | "write") => Promise<Remote>;
	/** Main's head in a project repo. */
	head: (repo: string) => Promise<string>;
	/** Runs a repo's checks on main plus a change (live, the Gate's container). */
	runChecks?: (repo: string) => CheckRunner;
}

const DEFAULT_POLICY: ReviewPolicy = { required: 2, vetoes: ["security"] };
const STALE_AFTER_MS = 30 * 60_000;
const claimsRef = (repo: string) => `refs/notes/blueprint-claims/${repo}`;
const votesRef = (repo: string) => `refs/notes/blueprint-votes/${repo}`;

const INSTRUCTIONS = `Coordinator-free mode: nobody enforces the rules; every agent follows them, and an audit anyone can run shows who didn't.
Conventions:
1. free_claim the paths you will change before editing; edit only inside your claim. A refusal names who holds what: narrow your claim, or ask them.
2. Work on a branch changes/<change> in the project repo (free_credentials gives you git access) and push it.
3. Reviewers free_vote on the exact commit they reviewed. A change merges with the policy's approvals and no veto.
4. free_merge merges your branch with trailers recording the claims and votes it checked, then releases your claim. Merge by hand only with the same trailers.
5. A claim idle for 30 minutes may be released by anyone (free_release with stale: true).
free_audit replays the records and lists every broken convention, with the commit and the agent.`;

const str = { type: "string" } as const;
export const FREE_TOOLS = [
	{ name: "free_start", description: "Start coordinator-free mode on a project repo (harmless if started): the review policy, and the checks run before each merge. Returns them.", inputSchema: { type: "object", properties: { repo: str, required: { type: "number" }, vetoes: { type: "array", items: str }, verify: { type: "array", items: str } }, required: ["repo"] } },
	{ name: "free_credentials", description: "Git URL and a write token for the project repo, to push your change branch.", inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] } },
	{ name: "free_claims", description: "The claims in force: who holds which paths, and why.", inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] } },
	{ name: "free_claim", description: "Claim paths for your change (again to extend it). Refused, naming the holder, if another claim overlaps.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str, paths: { type: "array", items: str }, intent: str }, required: ["repo", "change", "agent", "paths", "intent"] } },
	{ name: "free_release", description: "Release a claim: yours, or another's idle for 30 minutes with stale: true.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str, reason: str, stale: { type: "boolean" } }, required: ["repo", "change", "agent"] } },
	{ name: "free_vote", description: "Record your review verdict on the exact commit you reviewed.", inputSchema: { type: "object", properties: { repo: str, commit: str, reviewer: str, role: str, verdict: { type: "string", enum: ["approve", "reject"] }, evidence: str }, required: ["repo", "commit", "reviewer", "role", "verdict", "evidence"] } },
	{ name: "free_merge", description: "Merge changes/<change> into main if the conventions hold, recording what was checked, then release the claim.", inputSchema: { type: "object", properties: { repo: str, change: str, agent: str }, required: ["repo", "change", "agent"] } },
	{ name: "free_audit", description: "Replay the records and list every broken convention, with the commit and the agent.", inputSchema: { type: "object", properties: { repo: str }, required: ["repo"] } },
];

type Args = Record<string, unknown>;

async function callTool(name: string, args: Args, ctx: FreeContext): Promise<unknown> {
	const repo = requiredString(args, "repo");
	const write = () => ctx.remote(repo, "write");
	const claims = new GitCasLog<Registry>(write, repo, claimsRef(repo));
	const votes = new GitCasLog<Votes>(write, repo, votesRef(repo));
	const policyOf = async () => (await claims.read())?.commit.state.policy ?? DEFAULT_POLICY;
	switch (name) {
		case "free_start": {
			const policy: ReviewPolicy = {
				required: typeof args.required === "number" ? args.required : DEFAULT_POLICY.required,
				vetoes: Array.isArray(args.vetoes) ? (args.vetoes as string[]) : DEFAULT_POLICY.vetoes,
			};
			const verify = Array.isArray(args.verify) ? (args.verify as string[]).filter((c) => typeof c === "string" && c.trim()) : [];
			await startFree(claims, { baseline: await ctx.head(repo), policy, verify });
			const registry = (await claims.read())?.commit.state;
			return { repo, policy: registry?.policy ?? policy, verify: registry?.verify ?? [], instructions: INSTRUCTIONS };
		}
		case "free_credentials": {
			const remote = await write();
			return { url: remote.url, token: remote.token };
		}
		case "free_claims":
			return activeClaims((await claims.read())?.commit.state);
		case "free_claim":
			return claim(claims, {
				change: requiredString(args, "change"),
				agent: requiredString(args, "agent"),
				paths: normalizeClaim(requiredPaths(args, "paths")),
				intent: requiredString(args, "intent"),
			});
		case "free_release": {
			const change = requiredString(args, "change");
			const agent = requiredString(args, "agent");
			if (args.stale === true) return releaseStale(claims, { change, agent, staleAfterMs: STALE_AFTER_MS });
			return release(claims, { change, agent, reason: typeof args.reason === "string" ? args.reason : "released" });
		}
		case "free_vote": {
			const verdict = requiredString(args, "verdict");
			if (verdict !== "approve" && verdict !== "reject") throw new Error("[400] verdict is approve or reject");
			return vote(votes, { commit: requiredString(args, "commit"), reviewer: requiredString(args, "reviewer"), role: requiredString(args, "role"), verdict, evidence: requiredString(args, "evidence") });
		}
		case "free_merge": {
			const registry = (await claims.read())?.commit.state;
			return mergeChange({
				remote: await write(),
				claims,
				votes,
				policy: registry?.policy ?? DEFAULT_POLICY,
				verify: registry?.verify ?? [],
				runChecks: ctx.runChecks?.(repo),
				change: requiredString(args, "change"),
				agent: requiredString(args, "agent"),
			});
		}
		case "free_audit": {
			const remote = await ctx.remote(repo, "read");
			const registry = await readRecordHistory<Registry>(remote, claimsRef(repo));
			const baseline = registry[0]?.state.baseline;
			if (!baseline) throw new Error(`[409] coordinator-free mode hasn't started on ${repo}`);
			const merges = await readMainMerges(remote, baseline);
			const violations = audit({ registry, votes: await readRecordHistory<Votes>(remote, votesRef(repo)), policy: registry[0].state.policy ?? DEFAULT_POLICY, verify: registry[0].state.verify, merges });
			return { merges: merges.length, violations };
		}
		default:
			throw new Error(`[400] unknown tool ${name}`);
	}
}

interface RpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: { name?: string; arguments?: Args; protocolVersion?: string };
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const reply = (id: RpcRequest["id"], result: object) => ({ jsonrpc: "2.0", id: id ?? null, result });
const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** One JSON-RPC message to the coordinator-free MCP server; null for a notification. */
export async function handleFreeRpc(msg: RpcRequest, ctx: FreeContext): Promise<object | null> {
	if (!msg || typeof msg !== "object" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "invalid request");
	if (msg.id === undefined) return null;
	switch (msg.method) {
		case "initialize": {
			const requested = msg.params?.protocolVersion;
			const protocolVersion = typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
			return reply(msg.id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "blueprint-free", version: "0.1.0" }, instructions: INSTRUCTIONS });
		}
		case "ping":
			return reply(msg.id, {});
		case "tools/list":
			return reply(msg.id, { tools: FREE_TOOLS });
		case "tools/call": {
			const name = msg.params?.name;
			if (typeof name !== "string" || !FREE_TOOLS.some((t) => t.name === name)) return rpcError(msg.id, -32602, `unknown tool ${String(name)}`);
			try {
				const result = await callTool(name, msg.params?.arguments ?? {}, ctx);
				return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
			} catch (err) {
				return reply(msg.id, { content: [{ type: "text", text: statusOf(err).message }], isError: true });
			}
		}
		default:
			return rpcError(msg.id, -32601, `method not found: ${msg.method}`);
	}
}
