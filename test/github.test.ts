import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appJwt, type GitHubLink, linkTo, type WorkflowRun } from "../src/github";
import { actionsChecks, mirrorTo } from "../src/toolkit/actions-checks";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { memoryBatchGit } from "./helpers/memory-batch-git";

const run = promisify(execFile);

// A GitHive repo connected to a GitHub repo through GitHive's App: main pushed
// back after every landing, and checks run on its Actions. Here a second repo
// on the test Git server stands in for GitHub's git, and the REST API is
// answered by fakes.

/** An RSA key pair as GitHub gives an App's (here generated), the private key as a PKCS#8 PEM. */
async function appKey() {
	const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
	const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
	return { pem, publicKey: pair.publicKey };
}

describe("GitHive's GitHub App", () => {
	it("signs a JWT GitHub can verify with the App's public key, naming the App, good for under 10 minutes", async () => {
		const { pem, publicKey } = await appKey();
		const jwt = await appJwt({ appId: "12345", privateKey: pem }, Date.UTC(2026, 9, 10, 12));
		const [header, payload, signature] = jwt.split(".");
		const decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
		expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, decode(signature), new TextEncoder().encode(`${header}.${payload}`))).toBe(true);
		const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
		expect(claims.iss).toBe("12345");
		expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
	});

	it("links to a repo it's installed on, with a token scoped to it, and to none it isn't", async () => {
		const { pem } = await appKey();
		const calls: string[] = [];
		const fetcher = (async (url: string, init?: RequestInit) => {
			const path = new URL(url).pathname;
			calls.push(`${init?.method} ${path}`);
			if (path === "/repos/acme/missing/installation") return new Response("Not Found", { status: 404 });
			if (path === "/repos/acme/shop/installation") return Response.json({ id: 77 });
			if (path === "/app/installations/77/access_tokens") return Response.json({ token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
			if (path === "/repos/acme/shop/actions/runs") return Response.json({ workflow_runs: [{ id: 1, name: "test", status: "completed", conclusion: "success", html_url: "https://github.com/acme/shop/actions/runs/1" }] });
			return new Response("?", { status: 500 });
		}) as typeof fetch;
		expect(await linkTo({ appId: "1", privateKey: pem }, "acme/missing", fetcher)).toBeNull();
		const link = await linkTo({ appId: "1", privateKey: pem }, "acme/shop", fetcher);
		expect(link?.remote).toEqual({ url: "https://github.com/acme/shop.git", token: "ghs_test", user: "x-access-token" });
		expect(await link!.runsFor("abc")).toEqual([{ id: 1, name: "test", status: "completed", conclusion: "success", url: "https://github.com/acme/shop/actions/runs/1" }]);
		// The token is kept: one installation lookup and one token for the lot.
		expect(calls.filter((c) => c.includes("access_tokens"))).toHaveLength(1);
	});
});

describe("a repo connected to GitHub", { timeout: 60_000 }, () => {
	let server: GitServer;
	let work: string;
	beforeEach(async () => {
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "githive-github-"));
	});
	afterEach(async () => {
		await server.close();
		rmSync(work, { recursive: true, force: true });
	});

	/** GitHub, played by a second repo on the test server (a copy of the project), with workflow runs as `runs` says. */
	async function github(runs: (sha: string, asked: number) => WorkflowRun[]) {
		const url = server.repo("github");
		// GitHub has the project's main as it was imported (fetched without blocking: the server answering is in this process).
		await run("git", ["-C", server.gitIn("github", "rev-parse", "--absolute-git-dir").trim(), "fetch", "-q", server.url, "main:main"]);
		const deleted: string[] = [];
		const asked = new Map<string, number>();
		const link: GitHubLink = {
			repo: "acme/shop",
			remote: { url, token: "unused", user: "x-access-token" },
			runsFor: async (sha) => {
				asked.set(sha, (asked.get(sha) ?? 0) + 1);
				return runs(sha, asked.get(sha)!);
			},
			deleteBranch: async (name) => void (deleted.push(name), server.gitIn("github", "update-ref", "-d", `refs/heads/${name}`)),
		};
		return { link, deleted };
	}
	const project = () => ({ url: server.url, token: "unused" });
	const timing = { pollMs: 5, firstRunWithinMs: 200, runsWithinMs: 2_000 };

	it("checks a batch on Actions: its merged result pushed to githive/checks/<id>, passing when every run succeeds", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a", "a-1", { "src/a.txt": "a\n" });
		const b = await pushChange(server.url, work, "agent-b", "b-1", { "src/b.txt": "b\n" });
		const { link, deleted } = await github(() => [{ id: 1, name: "test", status: "completed", conclusion: "success", url: "https://github.com/acme/shop/actions/runs/1" }]);
		let pushed = "";
		const checks = actionsChecks(memoryBatchGit(project()), { ...link, runsFor: async (sha) => ((pushed = sha), link.runsFor(sha)) }, timing);
		const result = await checks({ base: main, branch: "main", changes: [{ change: "a-1", head: a, ref: "changes/a-1", agent: "agent-a" }, { change: "b-1", head: b, ref: "changes/b-1", agent: "agent-b" }], commands: ["github-actions"], gate: "batch1-0" });
		expect(result).toEqual({ passed: true, results: [{ command: "GitHub Actions: test", exitCode: 0, output: "success: https://github.com/acme/shop/actions/runs/1" }] });
		// What ran was both changes merged onto main.
		expect(server.gitIn("github", "ls-tree", "-r", "--name-only", pushed).split("\n")).toEqual(expect.arrayContaining(["src/a.txt", "src/b.txt"]));
		expect(deleted).toEqual(["githive/checks/batch1-0"]);
	});

	it("fails a batch whose run fails, waits for runs still going, and says so when no workflow runs at all", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a", "a-1", { "src/a.txt": "a\n" });
		const change = [{ change: "a-1", head: a, ref: "changes/a-1", agent: "agent-a" }];
		const failing = await github((_sha, asked) => [{ id: 2, name: "test", status: asked < 3 ? "in_progress" : "completed", conclusion: asked < 3 ? null : "failure", url: "https://github.com/acme/shop/actions/runs/2" }]);
		expect(await actionsChecks(memoryBatchGit(project()), failing.link, timing)({ base: main, branch: "main", changes: change, commands: [], gate: "f-0" })).toEqual({ passed: false, results: [{ command: "GitHub Actions: test", exitCode: 1, output: "failure: https://github.com/acme/shop/actions/runs/2" }] });
		const none = await github(() => []);
		const silent = await actionsChecks(memoryBatchGit(project()), none.link, timing)({ base: main, branch: "main", changes: change, commands: [], gate: "n-0" });
		expect(silent).toMatchObject({ passed: false, results: [{ command: "GitHub Actions", output: expect.stringMatching(/no workflow ran on githive\/checks\/n-0 .* githive\/checks\/\*\*/) }] });
	});

	it("pushes main back as a fast-forward, and never over what someone pushed to GitHub directly", async () => {
		const { link } = await github(() => []);
		const a = await pushChange(server.url, work, "agent-a", "a-1", { "src/a.txt": "a\n" });
		// main moves on GitHive (a change lands): GitHub follows.
		server.git("update-ref", "refs/heads/main", a);
		await mirrorTo(memoryBatchGit(project()), link, "main", a);
		expect(server.gitIn("github", "rev-parse", "main").trim()).toBe(a);
		// Someone pushes to GitHub directly; GitHive's next push is refused, not forced.
		const direct = server.gitIn("github", "commit-tree", "-m", "direct", "-p", a, `${a}^{tree}`).trim();
		server.gitIn("github", "update-ref", "refs/heads/main", direct);
		const b = await pushChange(server.url, work, "agent-b", "b-1", { "src/b.txt": "b\n" }, "main");
		server.git("update-ref", "refs/heads/main", b);
		await expect(mirrorTo(memoryBatchGit(project()), link, "main", b)).rejects.toThrow();
		expect(server.gitIn("github", "rev-parse", "main").trim()).toBe(direct);
	});
});

describe("connecting a repo to GitHub with settings", { timeout: 60_000 }, () => {
	it("needs GitHive's App installed there, and checks on Actions need it connected", async () => {
		const { callTool } = await import("../src/toolkit/mcp");
		const { statusOf } = await import("../src/errors");
		const server = await startGitServer();
		try {
			const ctx = (withApp = true) => ({
				remote: async () => ({ url: server.url, token: "unused" }),
				batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
				head: async () => server.git("rev-parse", "main").trim(),
				...(withApp ? { github: async (repo: string) => (repo === "acme/shop" ? ({ repo } as GitHubLink) : null) } : {}),
			});
			const call = async (args: Record<string, unknown>, withApp = true) => {
				try {
					return await callTool("settings", { repo: "p", ...args }, ctx(withApp));
				} catch (err) {
					return { error: statusOf(err).message };
				}
			};
			await callTool("start", { repo: "p" }, ctx());
			expect(await call({ github: "acme/shop" }, false)).toEqual({ error: "GitHub isn't set up on this GitHive (its App's ID and key)" });
			expect(await call({ github: "acme/other" })).toEqual({ error: "GitHive's GitHub app isn't installed on acme/other: install it there first" });
			expect(await call({ verify: ["github-actions"] })).toEqual({ error: 'checks on GitHub Actions need a connected GitHub repo: set github ("owner/name") too' });
			expect(await call({ github: "acme/shop", verify: ["github-actions"] })).toMatchObject({ github: "acme/shop", verify: ["github-actions"] });
			// Disconnected, the setting goes.
			expect(await call({ github: "", verify: [] })).not.toHaveProperty("github");
		} finally {
			await server.close();
		}
	});
});

describe("merging in a repo connected to GitHub", { timeout: 120_000 }, () => {
	it("checks the batch on Actions, lands it with no container, and pushes main back", async () => {
		const { callTool } = await import("../src/toolkit/mcp");
		const server = await startGitServer();
		const work = mkdtempSync(join(tmpdir(), "githive-github-merge-"));
		try {
			const url = server.repo("github");
			await run("git", ["-C", server.gitIn("github", "rev-parse", "--absolute-git-dir").trim(), "fetch", "-q", server.url, "main:main"]);
			const checked: string[] = [];
			const link: GitHubLink = {
				repo: "acme/shop",
				remote: { url, token: "unused", user: "x-access-token" },
				runsFor: async (sha) => (checked.push(sha), [{ id: 1, name: "test", status: "completed", conclusion: "success", url: "https://github.com/acme/shop/actions/runs/1" }]),
				deleteBranch: async () => undefined,
			};
			const ctx = (agentKey?: string) => ({
				remote: async () => ({ url: server.url, token: "unused" }),
				batchGit: () => memoryBatchGit({ url: server.url, token: "unused" }),
				changeRemote: async () => ({ url: server.url, token: "unused" }),
				head: async () => server.git("rev-parse", "main").trim(),
				github: async (repo: string) => (repo === "acme/shop" ? link : null),
				// A Gate that must never be asked: on Actions, nothing runs in a container.
				runChecks: () => async () => {
					throw new Error("a container check ran");
				},
				...(agentKey ? { agentKey } : {}),
			});
			const call = async (name: string, args: Record<string, unknown>, key?: string) => (await callTool(name, { repo: "p", ...args }, ctx(key))) as Record<string, unknown>;
			await call("start", { required: 1, vetoes: [] });
			await call("settings", { github: "acme/shop", verify: ["github-actions"] });
			const keys: Record<string, string> = {};
			for (const agent of ["a", "rev"]) keys[agent] = ((await call("register", { agent })) as { key: string }).key;
			await call("claim", { change: "c-1", agent: "a", paths: ["src/a/"], intent: "add a" }, keys.a);
			const head = await pushChange(server.url, work, "a", "c-1", { "src/a/x.js": "a\n" });
			await call("vote", { commit: head, reviewer: "rev", role: "review", verdict: "approve", evidence: "ok" }, keys.rev);
			const merged = await call("merge", { change: "c-1", agent: "a" }, keys.a);
			expect(merged).toMatchObject({ ok: true });
			expect(checked).toHaveLength(1);
			// GitHub's main is GitHive's, pushed back after the landing.
			expect(server.gitIn("github", "rev-parse", "main").trim()).toBe(server.git("rev-parse", "main").trim());
		} finally {
			await server.close();
			rmSync(work, { recursive: true, force: true });
		}
	});
});
