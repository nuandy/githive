import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { GitCasLog } from "../src/record-log";
import type { Registry } from "../src/toolkit/claims";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import {
	holdsRef,
	holdsRepoOf,
	REVIEW_HOLD_MS,
	type ReviewHolds,
	reviewHolds,
	reviewsRef,
	reviewsRepoOf,
} from "../src/toolkit/review-holds";
import { claimsRef } from "../src/toolkit/tools/repo";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// Review holds sit beside the claims until a repo spreads its records over records repos, which it does when its
// claims shard, and in a records repo after. A review taken before the switch must still count as taken after it.

let server: GitServer;
let work: string;
beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-holds-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

/** The tools on repo "p", with holds placed as the Worker places them: by the spread the claims registry shows. */
function context(): ToolContext {
	const remote = async () => ({ url: server.url, token: "unused" });
	const records = (index: number) => async () => ({ url: server.repo(`rec-${index}`), token: "unused" });
	const registry = async () => (await new GitCasLog<Registry>(remote, "p", claimsRef("p")).read())?.commit.state;
	const logIn = async (ref: string, repoOf: (count: number) => number) => {
		const count = (await registry())?.recordsRepos ?? 0;
		return new GitCasLog<ReviewHolds>(count ? records(repoOf(count)) : remote, "p", ref);
	};
	// Where a bucket's holds were kept before the spread, while one placed there may still be live.
	const earlier = async (repo: string, bucket: string) => {
		const state = await registry();
		if (!state?.recordsRepos || !state.shardedAt) return null;
		if (Date.now() > Date.parse(state.shardedAt) + REVIEW_HOLD_MS) return null;
		return new GitCasLog<ReviewHolds>(remote, repo, holdsRef(repo, bucket));
	};
	return {
		remote,
		changeRemote: remote,
		batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
		head: async () => server.git("rev-parse", "main").trim(),
		recordsRemote: async (_repo, index) => ({ url: server.repo(`rec-${index}`), token: "unused" }),
		createRecordsRepos: async () => undefined,
		reviews: reviewHolds({
			waits: (repo) => logIn(reviewsRef(repo), reviewsRepoOf),
			holds: (repo, bucket) => logIn(holdsRef(repo, bucket), (count) => holdsRepoOf(bucket, count)),
			earlier,
		}),
	};
}

it("keeps a review taken before the records spread taken after it", { timeout: 60_000 }, async () => {
	const ctx = context();
	const call = (name: string, args: Record<string, unknown>) =>
		callTool(name, { repo: "p", ...args }, ctx) as Promise<Record<string, unknown>>;
	await call("settings", { required: 1, vetoes: [] });
	await call("claim", { change: "c-1", agent: "author", paths: ["src/c/"], intent: "c" });
	await pushChange(server.url, work, "author", "c-1", { "src/c/x.js": "export const x = 1;\n" });
	// Reviewer a takes the review, then eight more agents claim and the claims shard and spread.
	await call("credentials", { change: "c-1", agent: "rev-a", role: "review" });
	for (const agent of Array.from({ length: 8 }, (_, index) => `crowd-${index}`))
		await call("claim", { change: `${agent}-1`, agent, paths: [`src/${agent}/`], intent: agent });
	const remote = async () => ({ url: server.url, token: "unused" });
	const registry = await new GitCasLog<Registry>(remote, "p", claimsRef("p")).read();
	expect(registry?.commit.state.recordsRepos).toBeGreaterThan(0);
	// Reviewer b isn't offered it, and can't take it.
	const offered = (await call("reviews", { agent: "rev-b" })).reviews as { change: string }[];
	expect(offered.map((review) => review.change)).not.toContain("c-1");
	await expect(call("credentials", { change: "c-1", agent: "rev-b", role: "review" })).rejects.toThrow(/409/);
});
