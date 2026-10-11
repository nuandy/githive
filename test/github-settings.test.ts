import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import type { GitHubLink } from "../src/github";
import { GitCasLog } from "../src/record-log";
import type { Registry } from "../src/toolkit/claims";
import { callTool } from "../src/toolkit/mcp";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

// How a connected repo works with GitHub: github_sync says whether main goes to
// GitHub's main (mirror) or to githive/main for a pull request (pr, for new
// connections), and github_trust whether GitHub's changes come back without
// review. Both are stored with the link in the claims registry, so the audit can
// hold each merge to the settings in force when it merged.

let server: GitServer;
beforeEach(async () => {
	server = await startGitServer();
});
afterEach(async () => {
	await server.close();
});

const ctx = () => ({
	remote: async () => ({ url: server.url, token: "unused" }),
	batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
	head: async () => server.git("rev-parse", "main").trim(),
	github: async (repo: string) => (repo.startsWith("acme/") ? ({ repo } as GitHubLink) : null),
});
const settings = async (args: Record<string, unknown>) => {
	try {
		return (await callTool("settings", { repo: "p", ...args }, ctx())) as Record<string, unknown>;
	} catch (err) {
		return { error: statusOf(err).message };
	}
};
const registry = async () =>
	(
		await new GitCasLog<Registry>(
			async () => ({ url: server.url, token: "unused" }),
			"p",
			"refs/notes/githive-claims/p",
		).read()
	)?.commit.state;

describe("connecting a repo to GitHub", { timeout: 60_000 }, () => {
	it("goes through a pull request by default, trusting GitHub's changes", async () => {
		await settings({});
		expect(await settings({ github: "acme/shop" })).toMatchObject({
			github: "acme/shop",
			githubSync: "pr",
			githubTrust: true,
		});
		expect((await registry())?.github).toEqual({ repo: "acme/shop", sync: "pr", trust: true });
	});

	it("can start in mirror mode, or untrusted, and change either later without connecting again", async () => {
		await settings({ github: "acme/shop", github_sync: "mirror", github_trust: false });
		expect((await registry())?.github).toEqual({ repo: "acme/shop", sync: "mirror", trust: false });
		expect(await settings({ github_sync: "pr" })).toMatchObject({ githubSync: "pr", githubTrust: false });
		expect(await settings({ github_trust: true })).toMatchObject({ githubSync: "pr", githubTrust: true });
		// Naming the same repo again keeps its mode.
		expect(await settings({ github: "acme/shop", required: 1 })).toMatchObject({ githubSync: "pr" });
		// Another repo is a new connection, with the defaults.
		await settings({ github: "acme/other", github_sync: "mirror" });
		expect(await settings({ github: "acme/shop" })).toMatchObject({ github: "acme/shop", githubSync: "pr" });
	});

	it("keeps a link made before modes as a mirror, trusted", async () => {
		await settings({});
		// A link as GitHive wrote it before modes existed: the repo alone.
		const log = new GitCasLog<Registry>(
			async () => ({ url: server.url, token: "unused" }),
			"p",
			"refs/notes/githive-claims/p",
		);
		const head = await log.read();
		const state = { ...head!.commit.state, github: { repo: "acme/old" } };
		await log.append(head!.tip, {
			author: "githive",
			kind: "decisions",
			entries: [{ commit: "none", text: "an older link", at: new Date().toISOString() }],
			state,
			batch: "b",
		});
		expect(await settings({ required: 1 })).toMatchObject({
			github: "acme/old",
			githubSync: "mirror",
			githubTrust: true,
		});
		expect(await settings({ github_trust: false })).toMatchObject({ githubSync: "mirror", githubTrust: false });
		expect((await registry())?.github).toEqual({ repo: "acme/old", trust: false });
	});

	it("refuses a mode or trust without a GitHub repo, and anything but the two modes", async () => {
		await settings({});
		expect(await settings({ github_sync: "pr" })).toEqual({
			error: 'connect a GitHub repo first: set github ("owner/name")',
		});
		expect(await settings({ github: "acme/shop", github_sync: "push" })).toMatchObject({
			error: expect.stringContaining('github_sync is "mirror"'),
		});
		expect(await settings({ github: "acme/shop", github_trust: "yes" })).toEqual({
			error: "github_trust is true or false",
		});
		expect(await settings({ github: "", github_trust: true })).toEqual({
			error: "github_sync and github_trust need a GitHub repo",
		});
	});

	it("starts GitHive with the link in one settings call", async () => {
		expect(await settings({ required: 0, github: "acme/shop", github_sync: "mirror" })).toMatchObject({
			github: "acme/shop",
			githubSync: "mirror",
			githubTrust: true,
		});
	});
});
