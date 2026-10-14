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

	it("prints its own commands as the next step, and GitHive's only where it has none of its own", async () => {
		const holder = {
			path: "src/auth/login.ts",
			held: "src/auth/",
			change: "fix-login",
			agent: "ann/bot",
			intent: "Fix the login loop",
		};
		const next =
			"Held by ann/bot's fix-login (its intent is in `conflicts`). Pick other work from `backlog`, or claim again later.";
		answers.claim = { ok: false, conflicts: [holder], next };
		const refused = await cli(["start", "acme/app", "rate-limit", "Rate-limit logins", "src/auth/login.ts"]);
		expect(refused.stdout).toContain("next: narrow your paths and start again");
		expect(refused.stdout).not.toContain("Pick other work from `backlog`");
		const approved = { approved: true, approvals: 1, required: 1, awaiting: [], vetoedBy: [] };
		const clean = { into: "main", branchHead: "x", clean: true, outsideClaim: [] };
		const status = {
			change: "rate-limit",
			claim: { agent: "me", paths: ["src/"], intent: "x" },
			head: "abc",
			votes: [],
		};
		answers.status = { ...status, approval: approved, merge: clean, next: "Call `merge`." };
		expect((await cli(["status", "acme/app", "rate-limit"])).stdout).toMatch(/next: githive land\n$/);
		answers.vote = { ok: true, tip: "t", next: "Done. Choose more from `reviews`." };
		const voted = await cli(["vote", "acme/app", "abc", "approve", "ran the tests"]);
		expect(voted.stdout).toMatch(/next: githive reviews acme\/app\n$/);
		// A refusal the CLI has no words for gets GitHive's next step, and failing that, a look at status.
		answers.merge = { ok: false, why: ["something-new"], reasons: ["a reason"], next: "Ask the repo's people." };
		const unknown = await cli(["land", "acme/app", "rate-limit"]);
		expect(unknown.stdout).toMatch(/next: Ask the repo's people\.\n$/);
		answers.merge = {
			ok: false,
			why: ["setup"],
			reasons: ["checks run on GitHub Actions, but no GitHub repo is connected"],
		};
		const setup = await cli(["land", "acme/app", "rate-limit"]);
		expect(setup.stdout).toMatch(/next: githive status \(what it still needs\)\n$/);
	});

	it("says what a refused merge needs in its own commands, after the plain git that resolves a conflict", async () => {
		const status = {
			change: "rate-limit",
			claim: { agent: "me", paths: ["src/auth/"], intent: "x" },
			head: "abc",
			votes: [],
			approval: { approved: true, approvals: 1, required: 1, awaiting: [], vetoedBy: [] },
			merge: { into: "main", branchHead: "x", clean: true, outsideClaim: [] },
		};
		answers.status = status;
		const fix = [
			"git fetch origin main && git merge origin/main",
			"# resolve src/auth/a.ts so both changes make sense, then:",
			"git add -u && git commit --no-edit",
			"git push fork changes/rate-limit",
			"call status; once the new commit is approved, merge again",
		];
		answers.merge = {
			ok: false,
			why: ["conflict", "approvals"],
			into: "main",
			conflicts: ["src/auth/a.ts"],
			fix,
			reasons: ["conflict on src/auth/a.ts with o-7 by bob", "abc has 0 of 2 approvals"],
			next: "It conflicts with main in src/auth/a.ts. In your clone: ...",
		};
		const refused = await cli(["land", "acme/app", "rate-limit"]);
		expect(refused.code).toBe(1);
		expect(refused.stdout).toContain(
			["with plain git, in your clone:", ...fix.slice(0, 4).map((line) => `  ${line}`)].join("\n"),
		);
		expect(refused.stdout).not.toContain("call status");
		expect(refused.stdout).not.toContain("In your clone: ...");
		// The step goes on from the fix's commands, rather than start over with a second recipe (githive sync).
		expect(refused.stdout).toMatch(
			/next: run the commands above, resolving inside your claim so both changes make sense, then: githive land \(the new commit needs approval again\); wait for approvals \(githive status says how many\); meanwhile githive reviews acme\/app\n$/,
		);
		expect(refused.stdout).not.toContain("githive sync");
		// Without a fix to print (an older server, say), the CLI's own recipe.
		answers.merge = { ...(answers.merge as Record<string, unknown>), fix: undefined };
		const unfixed = await cli(["land", "acme/app", "rate-limit"]);
		expect(unfixed.stdout).toMatch(
			/next: githive sync, resolve inside your claim so both changes make sense, commit, githive land;/,
		);
	});

	it("deepens a shallow clone first in the fix it prints, as githive sync would", async () => {
		const { project } = repos();
		const shallow = join(tmp, "shallow");
		execFileSync("git", ["clone", "--quiet", "--depth", "1", project, shallow]);
		const fix = ["git fetch origin main && git merge origin/main", "call status; once approved, merge again"];
		answers.status = {
			change: "rate-limit",
			claim: { agent: "me", paths: ["src/auth/"], intent: "x" },
			head: "abc",
			votes: [],
			approval: { approved: true, approvals: 1, required: 1, awaiting: [], vetoedBy: [] },
			merge: { into: "main", clean: false, conflicts: ["src/auth/a.ts"], outsideClaim: [], fix },
		};
		const out = await cli(["status", "acme/app", "rate-limit"], shallow);
		expect(out.stdout).toContain(
			"with plain git, in your clone:\n  git fetch --unshallow origin\n  git fetch origin main && git merge origin/main\n",
		);
	});

	it("tells from status a change that conflicts or strays outside its claim, though it's approved", async () => {
		const status = {
			change: "rate-limit",
			claim: { agent: "me", paths: ["src/auth/"], intent: "x" },
			head: "abc",
			votes: [],
			approval: { approved: true, approvals: 1, required: 1, awaiting: [], vetoedBy: [] },
		};
		const fix = [
			"git fetch origin main && git merge origin/main",
			"call status; once the new commit is approved, merge again",
		];
		answers.status = {
			...status,
			merge: { into: "main", clean: false, conflicts: ["src/auth/a.ts"], outsideClaim: [], fix },
			next: "It conflicts with main in src/auth/a.ts. In your clone: ...",
		};
		const conflicted = await cli(["status", "acme/app", "rate-limit"]);
		expect(conflicted.stdout).toContain("conflicts with main in src/auth/a.ts");
		expect(conflicted.stdout).toContain(
			"with plain git, in your clone:\n  git fetch origin main && git merge origin/main\n",
		);
		expect(conflicted.stdout).toContain("next: run the commands above, resolving inside your claim");
		answers.status = { ...status, merge: { into: "main", clean: true, outsideClaim: ["docs/x.md"] } };
		const strayed = await cli(["status", "acme/app", "rate-limit"]);
		expect(strayed.stdout).toContain("outside your claim: docs/x.md");
		expect(strayed.stdout).toContain("next: claim them too (githive start acme/app rate-limit");
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
		// When no other agent may review it, its own agent does, and votes naming the change.
		answers.status = { ...(answers.status as Record<string, unknown>), reviewYourself: true };
		const alone = await cli(["land"], clone);
		expect(alone.stdout).toContain("next: no other agent may review it, so review it yourself in a fresh context");
		expect(alone.stdout).toContain(`githive vote acme/app ${head} approve|reject "<evidence>" --change rate-limit`);
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
