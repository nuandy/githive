import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubError, type GitHubLink, type PullRequest, type WorkflowRun } from "../../src/github";
import type { GitServer } from "./git-server";

// GitHub, played by another repo on the test Git server for git over HTTP, with its REST API answered here: the
// default branch, pull requests, workflow runs. People on GitHub merge the pull request the three ways GitHub offers,
// or push straight to its branch, with real git on the repo's disk.

export interface FakeGitHub {
	link: GitHubLink;
	/** Runs git in GitHub's bare repo. */
	git: (...args: string[]) => string;
	head: (branch?: string) => string;
	/** Every pull request opened, open or not. */
	pulls: (PullRequest & { open: boolean })[];
	/** Every REST call, as "METHOD path". */
	calls: string[];
	/** Makes the next `count` REST calls fail, as GitHub down would. */
	failCalls: (count: number) => void;
	/** Merges the open pull request into the default branch as GitHub would, and closes it. Returns the new head. */
	mergePull: (how: "merge" | "squash" | "rebase") => string;
	/** Someone commits `files` straight to GitHub's default branch. Returns the new head. */
	push: (files: Record<string, string>, message?: string) => string;
	close: () => void;
}

const IDENTITY = ["-c", "user.name=octocat", "-c", "user.email=octocat@example.com"];

/** GitHub's acme/shop, starting as a copy of the project's main. */
export async function fakeGitHub(
	server: GitServer,
	options: { repo?: string; runs?: (sha: string) => WorkflowRun[] } = {},
): Promise<FakeGitHub> {
	const repo = options.repo ?? "acme/shop";
	const url = server.repo("github");
	const bare = server.gitIn("github", "rev-parse", "--absolute-git-dir").trim();
	const project = server.git("rev-parse", "--absolute-git-dir").trim();
	const git = (...args: string[]) => execFileSync("git", ["-C", bare, ...args]).toString();
	git("fetch", "-q", project, "main:main");
	git("symbolic-ref", "HEAD", "refs/heads/main");
	const work = mkdtempSync(join(tmpdir(), "githive-fake-github-"));
	const pulls: (PullRequest & { open: boolean })[] = [];
	const calls: string[] = [];
	let failing = 0;
	const called = (what: string) => {
		calls.push(what);
		if (failing > 0) {
			failing--;
			throw new GitHubError(503, `GitHub ${what}: 503 unavailable`);
		}
	};
	const head = (branch = "main") => git("rev-parse", `refs/heads/${branch}`).trim();
	// A working clone of GitHub, fresh for each thing people do there.
	const inClone = (work_: (dir: string, run: (...args: string[]) => string) => void) => {
		const dir = join(work, `clone-${Math.random().toString(36).slice(2, 8)}`);
		execFileSync("git", ["clone", "-q", bare, dir]);
		const run = (...args: string[]) => execFileSync("git", ["-C", dir, ...IDENTITY, ...args]).toString();
		work_(dir, run);
		rmSync(dir, { recursive: true, force: true });
	};
	const link: GitHubLink = {
		repo,
		remote: { url, token: "unused", user: "x-access-token" },
		runsFor: async (sha) => (called(`GET runs ${sha}`), options.runs?.(sha) ?? []),
		deleteBranch: async (name) => {
			called(`DELETE ${name}`);
			git("update-ref", "-d", `refs/heads/${name}`);
		},
		defaultHead: async () => {
			called("GET default");
			return { branch: "main", head: head() };
		},
		openPull: async (from) => {
			called(`GET pulls ${from}`);
			const open = pulls.find((pull) => pull.open && pull.head === from);
			return open ? withoutOpen(open) : null;
		},
		createPull: async ({ head: from, base, title, body }) => {
			called(`POST pulls ${from}`);
			if (pulls.some((pull) => pull.open && pull.head === from))
				throw new GitHubError(422, "A pull request already exists");
			if (!git("rev-list", `refs/heads/${base}..refs/heads/${from}`).trim())
				throw new GitHubError(422, `No commits between ${base} and ${from}`);
			const number = pulls.length + 1;
			const pull = { number, url: `https://github.com/${repo}/pull/${number}`, title, body, head: from, base };
			pulls.push({ ...pull, open: true });
			return pull;
		},
		updatePull: async (number, { title, body }) => {
			called(`PATCH pulls ${number}`);
			const pull = pulls.find((entry) => entry.number === number);
			if (!pull) throw new GitHubError(404, "Not Found");
			Object.assign(pull, { title, body });
			return withoutOpen(pull);
		},
	};
	const mergePull = (how: "merge" | "squash" | "rebase") => {
		const pull = pulls.find((entry) => entry.open) ?? { number: 0, head: "githive/main", base: "main", title: "" };
		inClone((_dir, run) => {
			run("fetch", "-q", "origin", `${pull.head}:refs/remotes/origin/${pull.head}`);
			run("checkout", "-q", pull.base);
			if (how === "merge")
				run(
					"merge",
					"-q",
					"--no-ff",
					"-m",
					`Merge pull request #${pull.number} from ${pull.head}`,
					`origin/${pull.head}`,
				);
			if (how === "squash") {
				run("merge", "-q", "--squash", `origin/${pull.head}`);
				run("commit", "-q", "-m", `${pull.title} (#${pull.number})`);
			}
			if (how === "rebase") {
				// GitHub replays the pull request's commits on its branch, merges dropped, each with a new id.
				run("checkout", "-q", "-B", "rebasing", `origin/${pull.head}`);
				run("rebase", "-q", pull.base);
				run("checkout", "-q", pull.base);
				run("merge", "-q", "--ff-only", "rebasing");
			}
			run("push", "-q", "origin", pull.base);
		});
		if ("open" in pull) pull.open = false;
		return head(pull.base);
	};
	const push = (files: Record<string, string>, message = "A commit on GitHub") => {
		inClone((dir, run) => {
			for (const [path, text] of Object.entries(files)) {
				mkdirSync(join(dir, path, ".."), { recursive: true });
				writeFileSync(join(dir, path), text);
			}
			run("add", "-A");
			run("commit", "-q", "-m", message);
			run("push", "-q", "origin", "main");
		});
		return head();
	};
	return {
		link,
		git,
		head,
		pulls,
		calls,
		failCalls: (count) => void (failing = count),
		mergePull,
		push,
		close: () => rmSync(work, { recursive: true, force: true }),
	};
}

const withoutOpen = ({ open: _open, ...pull }: PullRequest & { open: boolean }): PullRequest => pull;
