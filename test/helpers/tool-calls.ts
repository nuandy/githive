import { statusOf } from "../../src/errors";
import { callTool, type ToolContext } from "../../src/toolkit/mcp";
import type { GitServer } from "./git-server";
import { memoryBatchGit } from "./memory-batch-git";

/**
 * GitHive's tools on repo "p", served by a local Git server, called as registered agents. `server` is read at
 * each call, so a test file can start a fresh server per test.
 */
export function toolCalls(server: () => GitServer, extra: Partial<ToolContext> = {}) {
	const keys: Record<string, string> = {};
	const ctx = (agentKey?: string): ToolContext => ({
		remote: async () => ({ url: server().url, token: "unused" }),
		batchGit: () => memoryBatchGit({ url: server().url, token: "unused" }),
		changeRemote: async () => ({ url: server().url, token: "unused" }),
		head: async (_repo, branch) => server().git("rev-parse", branch).trim(),
		...extra,
		...(agentKey ? { agentKey } : {}),
	});
	/** Calls a tool, as `as`'s registered agent if named. */
	const call = (name: string, args: Record<string, unknown>, as?: string) =>
		callTool(name, { repo: "p", ...args }, ctx(as ? keys[as] : undefined)) as Promise<Record<string, unknown>>;
	const register = async (...agents: string[]) => {
		for (const agent of agents) keys[agent] = ((await call("register", { agent })) as { key: string }).key;
	};
	/** The registered "reviewer" approves a head. */
	const approve = (head: string) =>
		call(
			"vote",
			{ commit: head, reviewer: "reviewer", role: "review", verdict: "approve", evidence: "ok" },
			"reviewer",
		);
	return { ctx, call, keys, register, approve };
}

/**
 * Tool calls on repo "p" whose records repos live on the same server, as rec-<k>, so claims and votes can
 * shard. Refusals come back as { error } rather than throwing. `created` lists each request for records repos.
 */
export function shardingToolCalls(server: () => GitServer) {
	const created: number[] = [];
	const remote = async () => ({ url: server().url, token: "unused" });
	const ctx = (): ToolContext => ({
		remote,
		changeRemote: remote,
		batchGit: () => memoryBatchGit({ url: server().url, token: "unused" }),
		head: async () => server().git("rev-parse", "main").trim(),
		recordsRemote: async (_repo, k) => ({ url: server().repo(`rec-${k}`), token: "unused" }),
		createRecordsRepos: async (_repo, count) => void created.push(count),
	});
	const call = async (name: string, args: Record<string, unknown>) => {
		try {
			return (await callTool(name, { repo: "p", ...args }, ctx())) as Record<string, unknown> & { ok?: boolean };
		} catch (err) {
			return { error: statusOf(err).message };
		}
	};
	return { call, created };
}
