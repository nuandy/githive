import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The githive CLI against a fake MCP server (answers tools/call from a table)
// and local bare repos standing in for the project and the agent's fork.

const CLI = fileURLToPath(new URL("../cli/githive.mjs", import.meta.url));
type Answer = unknown | ((args: Record<string, unknown>) => unknown);

let server: Server;
let base = "";
let answers: Record<string, Answer> = {};
let calls: { name: string; args: Record<string, unknown>; auth?: string }[] = [];
let tmp = "";

const identity = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.invalid",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const gitIn = (dir: string, ...args: string[]) =>
	execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...identity } }).trim();

/** Runs the CLI (async: the fake server answers in this process), with its exit code. */
function cli(args: string[], cwd = tmp): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			"node",
			[CLI, ...args],
			{
				cwd,
				env: {
					...process.env,
					...identity,
					GITHIVE_URL: base,
					GITHIVE_TOKEN: "ghv_test",
					GITHIVE_KEY: "",
					GITHIVE_AGENT: "",
				},
			},
			(err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
		);
	});
}

beforeAll(async () => {
	server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const { id, params } = JSON.parse(body);
			calls.push({ name: params.name, args: params.arguments, auth: req.headers.authorization });
			const answer = answers[params.name];
			const result = typeof answer === "function" ? answer(params.arguments) : answer;
			const failed = result instanceof Error;
			res.setHeader("Content-Type", "application/json");
			res.end(
				JSON.stringify({
					jsonrpc: "2.0",
					id,
					result: {
						content: [{ type: "text", text: failed ? result.message : JSON.stringify(result) }],
						...(failed ? { isError: true } : {}),
					},
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as { port: number };
	base = `http://127.0.0.1:${address.port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "githive-cli-"));
	answers = {};
	calls = [];
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** A project repo (main, two commits) and an empty fork, as file:// URLs. */
function repos() {
	const project = join(tmp, "project.git");
	const fork = join(tmp, "fork.git");
	execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", project]);
	execFileSync("git", ["init", "--quiet", "--bare", "-b", "main", fork]);
	const seed = join(tmp, "seed");
	execFileSync("git", ["init", "--quiet", "-b", "main", seed]);
	writeFileSync(join(seed, "README.md"), "hello\n");
	gitIn(seed, "add", ".");
	gitIn(seed, "commit", "--quiet", "-m", "seed");
	// Two commits: a depth-1 clone is then really shallow, and pushing to the empty fork needs it deepened.
	writeFileSync(join(seed, "README.md"), "hello again\n");
	gitIn(seed, "commit", "--quiet", "-am", "second");
	gitIn(seed, "push", "--quiet", `file://${project}`, "main");
	return { project: `file://${project}`, fork: `file://${fork}`, forkPath: fork, seed };
}

describe("githive CLI", () => {
	it("prints help and exits 0", async () => {
		const out = await cli(["help"]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("githive start <repo> <change>");
		expect(out.stdout).toContain("githive land");
	});

	it("refuses an unknown command with usage (exit 2)", async () => {
		const out = await cli(["frobnicate"]);
		expect(out.code).toBe(2);
		expect(out.stderr).toContain("unknown command frobnicate");
	});

	it("lists claims readably, sending the agent token", async () => {
		answers.claims = [
			{
				change: "fix-login",
				agent: "ann/bot",
				paths: ["src/auth/"],
				intent: "Fix the login loop\nmore detail",
				since: "x",
				active: "x",
			},
		];
		const out = await cli(["claims", "acme/app"]);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("fix-login (ann/bot): src/auth/");
		expect(out.stdout).toContain("Fix the login loop");
		expect(out.stdout).not.toContain("more detail");
		expect(out.stdout).toMatch(/next: .*githive start acme\/app/);
		expect(calls).toEqual([{ name: "claims", args: { repo: "acme/app" }, auth: "Bearer ghv_test" }]);
	});

	it("shows who holds what when a claim is refused, and clones nothing", async () => {
		answers.claim = {
			ok: false,
			conflicts: [
				{
					path: "src/auth/login.ts",
					held: "src/auth/",
					change: "fix-login",
					agent: "ann/bot",
					intent: "Fix the login loop",
				},
			],
		};
		const out = await cli(["start", "acme/app", "rate-limit", "Rate-limit logins", "src/auth/login.ts"]);
		expect(out.code).toBe(1);
		expect(out.stdout).toContain("src/auth/login.ts overlaps src/auth/: ann/bot's fix-login");
		expect(out.stdout).toContain("next:");
		expect(existsSync(join(tmp, "rate-limit"))).toBe(false);
		expect(calls.map((c) => c.name)).toEqual(["claim"]);
	});

	it("starts a change, then land pushes it to the fork, checks, and says to land again while pending", async () => {
		const { project, fork, forkPath } = repos();
		answers.claim = { ok: true };
		answers.credentials = {
			url: fork,
			token: "fork-secret?exp=1",
			branch: "changes/rate-limit",
			project: { url: project, token: "project-secret", branch: "main" },
		};
		const started = await cli(["start", "acme/app", "rate-limit", "Rate-limit logins", "src/auth/"]);
		expect(started.code).toBe(0);
		expect(started.stdout).toContain("claimed src/auth/ for rate-limit");
		expect(started.stdout).not.toContain("secret");
		const clone = join(tmp, "rate-limit");
		expect(gitIn(clone, "symbolic-ref", "--short", "HEAD")).toBe("changes/rate-limit");
		expect(gitIn(clone, "config", "githive.repo")).toBe("acme/app");
		expect(gitIn(clone, "config", `http.${fork}.extraHeader`)).toBe("Authorization: Bearer fork-secret");

		execFileSync("mkdir", ["-p", join(clone, "src/auth")]);
		writeFileSync(join(clone, "src/auth/limit.ts"), "export const limit = 5;\n");
		gitIn(clone, "add", ".");
		gitIn(clone, "commit", "--quiet", "-m", "Rate-limit logins");
		const head = gitIn(clone, "rev-parse", "HEAD");
		answers.status = {
			change: "rate-limit",
			head,
			merge: { into: "main", branchHead: "x", clean: true, outsideClaim: [] },
		};
		answers.merge = { ok: false, pending: true, reasons: ["rate-limit is ready and waiting to land (abcdef12)"] };
		const landed = await cli(["land"], clone);
		expect(landed.stdout).toContain(`pushed ${head.slice(0, 8)}`);
		expect(landed.stdout).toContain("pending: rate-limit is ready and waiting to land");
		expect(landed.stdout).toContain("next: githive land");
		expect(landed.code).toBe(3);
		expect(execFileSync("git", ["-C", forkPath, "rev-parse", "changes/rate-limit"], { encoding: "utf8" }).trim()).toBe(
			head,
		);
		expect(calls.slice(-3).map((c) => [c.name, c.args])).toEqual([
			["credentials", { repo: "acme/app", change: "rate-limit" }],
			["status", { repo: "acme/app", change: "rate-limit" }],
			["merge", { repo: "acme/app", change: "rate-limit" }],
		]);

		// Landing again doesn't push what the fork has; landed, it says so.
		answers.merge = { ok: true, commit: "0123456789abcdef" };
		const again = await cli(["land"], clone);
		expect(again.code).toBe(0);
		expect(again.stdout).not.toContain("pushed");
		expect(again.stdout).toContain("landed rate-limit as 01234567");
	});

	it("says a change waiting for reviews is waiting, and what to do meanwhile, not just that the merge was refused", async () => {
		const { project, fork } = repos();
		answers.claim = { ok: true };
		answers.credentials = {
			url: fork,
			token: "fork-secret?exp=1",
			branch: "changes/rate-limit",
			project: { url: project, token: "project-secret", branch: "main" },
		};
		await cli(["start", "acme/app", "rate-limit", "Rate-limit logins", "src/auth/"]);
		const clone = join(tmp, "rate-limit");
		writeFileSync(join(clone, "limit.ts"), "export const limit = 5;\n");
		gitIn(clone, "add", ".");
		gitIn(clone, "commit", "--quiet", "-m", "Rate-limit logins");
		const head = gitIn(clone, "rev-parse", "HEAD");
		answers.status = {
			change: "rate-limit",
			claim: { change: "rate-limit", agent: "builder", paths: ["src/auth/"], intent: "Rate-limit logins" },
			head,
			approval: { approved: false, approvals: 0, required: 1 },
			merge: { into: "main", branchHead: "x", clean: true, outsideClaim: [] },
		};
		answers.merge = { ok: false, reasons: [`${head} has 0 of 1 approvals from reviewers other than its author`] };
		const landed = await cli(["land"], clone);
		expect(landed.stdout).toContain("not landed yet:");
		expect(landed.stdout).toContain("approvals: 0 of 1");
		expect(landed.stdout).toContain("next: waiting on 1 approval; meanwhile review others': githive reviews acme/app");
	});

	it("sync merges the project's branch into the change branch, never rebasing", async () => {
		const { project, fork, seed } = repos();
		answers.claim = { ok: true };
		answers.credentials = (args: Record<string, unknown>) =>
			args.change
				? { url: fork, token: "f", project: { url: project, token: "p", branch: "main" } }
				: { url: project, token: "p" };
		await cli(["start", "acme/app", "docs", "Docs", "docs/"]);
		const clone = join(tmp, "docs");
		writeFileSync(join(clone, "notes.md"), "mine\n");
		gitIn(clone, "add", ".");
		gitIn(clone, "commit", "--quiet", "-m", "mine");
		const mine = gitIn(clone, "rev-parse", "HEAD");
		writeFileSync(join(seed, "other.md"), "theirs\n");
		gitIn(seed, "add", ".");
		gitIn(seed, "commit", "--quiet", "-m", "theirs");
		gitIn(seed, "push", "--quiet", project, "main");

		const out = await cli(["sync"], clone);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("merged origin/main");
		expect(out.stdout).toContain("next: githive land");
		// A merge commit on top of the agent's own, which stays as it was.
		expect(gitIn(clone, "rev-parse", "HEAD^1")).toBe(mine);
		expect(existsSync(join(clone, "other.md"))).toBe(true);
	});

	it("passes a raw call through with tokens redacted, and reports a tool's refusal", async () => {
		answers.credentials = { url: "https://x", token: "very-secret" };
		const out = await cli(["call", "credentials", '{"repo":"acme/app"}']);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain('"token": "<redacted>"');
		expect(out.stdout).not.toContain("very-secret");
		answers.status = new Error("[404] no change nope on acme/app");
		const refused = await cli(["status", "acme/app", "nope"]);
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("status refused: [404] no change nope");
	});
});
