import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { statusOf } from "../src/errors";
import type { GitHubLink } from "../src/github";
import { GitCasLog } from "../src/record-log";
import type { Registry } from "../src/toolkit/claims";
import { callTool, type ToolContext } from "../src/toolkit/mcp";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { linkBeforeModes } from "./helpers/github-link";
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
const settings = async (args: Record<string, unknown>, caller: Partial<ToolContext> = {}) => {
	try {
		return (await callTool("settings", { repo: "p", ...args }, { ...ctx(), ...caller })) as Record<string, unknown>;
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
			githubInbound: true,
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

	it("keeps a link made before modes a mirror that brings nothing back, until a mode is set", async () => {
		await settings({});
		await linkBeforeModes(server, "p", "acme/old");
		expect(await settings({ required: 1 })).toMatchObject({
			github: "acme/old",
			githubSync: "mirror",
			githubTrust: false,
			githubInbound: false,
		});
		// Trust alone sets no mode: it still only mirrors.
		expect(await settings({ github_trust: true })).toMatchObject({ githubTrust: false, githubInbound: false });
		expect((await registry())?.github).toEqual({ repo: "acme/old", trust: true });
		// Setting the mode, even to mirror, brings GitHub's changes back, trusted.
		expect(await settings({ github_sync: "mirror" })).toMatchObject({
			githubSync: "mirror",
			githubTrust: true,
			githubInbound: true,
		});
		expect((await registry())?.github).toEqual({ repo: "acme/old", sync: "mirror", trust: true });
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

	it("connects only a GitHub repo the caller's own GitHub account can write to", async () => {
		await settings({});
		// GitHub account 1 writes to acme/shop; 2 only reads it.
		const permissions: Record<string, string> = { "1": "write", "2": "read" };
		const github = async (repo: string) =>
			repo.startsWith("acme/")
				? ({ repo, permissionOf: async (account: string) => permissions[account] ?? "none" } as GitHubLink)
				: null;
		const as = (account: string | null) => ({ github, githubAccount: async () => account });
		expect(await settings({ github: "acme/shop" }, as("2"))).toEqual({
			error: "your GitHub account can't write to acme/shop: ask its owner for write access first",
		});
		expect(await settings({ github: "acme/shop" }, as(null))).toEqual({
			error: "connecting acme/shop needs a GitHive account signed in with GitHub",
		});
		expect(await settings({ github: "acme/shop" }, as("1"))).toMatchObject({ github: "acme/shop" });
	});
});
