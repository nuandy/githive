import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { castHostedVote } from "../src/toolkit/hosted-vote";
import type { ToolContext } from "../src/toolkit/mcp";
import { votesFor } from "../src/toolkit/tools/repo";
import { startGitServer, type GitServer } from "./helpers/git-server";

let server: GitServer;
beforeEach(async () => {
	server = await startGitServer();
});
afterEach(async () => {
	await server.close();
});

it("a hosted reviewer's vote is kept, and rings for the change's agent and the agent that reviewed", async () => {
	const ping = vi.fn(async () => undefined);
	const remote = async () => ({ url: server.url, token: "unused" });
	const ctx: ToolContext = { remote, head: async () => server.git("rev-parse", "main").trim(), ping };
	const commit = server.git("rev-parse", "main").trim();
	const vote = { commit, change: "a", reviewer: "githive-scout", role: "review", verdict: "approve" as const };
	await castHostedVote(ctx, "p", { ...vote, evidence: "reads right" }, "githive-forager");
	const kept = await votesFor(ctx, "p").readFor([commit]);
	expect(kept.votes.map(({ reviewer, verdict }) => ({ reviewer, verdict }))).toEqual([
		{ reviewer: "githive-scout", verdict: "approve" },
	]);
	expect(ping).toHaveBeenCalledWith("p", undefined, "vote", { for: ["githive-forager", "githive-scout"] });
});
