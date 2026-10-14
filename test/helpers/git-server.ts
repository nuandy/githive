import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A real Git server for tests: git http-backend serving a temporary bare repo
// over smart HTTP. Pushes are checked by Git itself, so a push built on a stale
// tip is rejected exactly as a hosted Git server would reject it.

export interface GitServer {
	url: string;
	/** Run git against the bare repo, for assertions: returns stdout. */
	git: (...args: string[]) => string;
	/**
	 * Hold the next `count` push uploads until all of them have arrived, then let
	 * them through together: each push has already seen the same tip, so only
	 * Git's own compare-and-swap on the server can decide between them.
	 */
	holdPushes: (count: number) => Promise<void>;
	/** Push uploads the server has answered. */
	pushes: () => number;
	/** Every request so far, as "METHOD path?service" (for counting round trips). */
	requests: string[];
	/** Every request so far, as "repo METHOD path" (which repo each went to). */
	requestsTo: string[];
	/** Answer the next `count` push uploads with a 500, after (applied: true) or without applying them. */
	failPushes: (count: number, applied?: boolean) => void;
	/** Refuse the next `count` push uploads the way Artifacts does when a repo is busy. */
	busyPushes: (count: number) => void;
	/** Answer the next `count` fetch uploads with a 500, as an overloaded server might. */
	failFetches: (count: number) => void;
	/** Another (empty) repo on the same server, created if need be: its URL. */
	repo: (name: string) => string;
	/** Run git against another repo on the server, for assertions. */
	gitIn: (name: string, ...args: string[]) => string;
	close: () => Promise<void>;
}

const reposAt = new Map<string, (name: string) => string>();

/** Runs git in the bare repo a test server serves at `url`. */
export function gitAt(url: string) {
	const pathOf = reposAt.get(new URL(url).origin);
	if (!pathOf) throw new Error(`no test server at ${url}`);
	return (name: string) =>
		(...args: string[]) =>
			execFileSync("git", ["-C", pathOf(name), ...args]).toString();
}

const backend = join(execFileSync("git", ["--exec-path"]).toString().trim(), "git-http-backend");

/** A server whose project repo has one commit on `branch` (main unless asked), which HEAD names. */
export async function startGitServer({ branch = "main" }: { branch?: string } = {}): Promise<GitServer> {
	const root = mkdtempSync(join(tmpdir(), "githive-git-"));
	const repo = join(root, "project.git");
	// The branch named outright: git's own default is main on some machines, master on others.
	execFileSync("git", ["init", "--bare", "--quiet", "-b", branch, repo]);
	execFileSync("git", ["-C", repo, "config", "http.receivepack", "true"]);
	// Like any project repo, it has a default branch with a commit.
	const work = join(root, "work");
	execFileSync("git", ["init", "--quiet", "-b", branch, work]);
	execFileSync("git", [
		"-C",
		work,
		"-c",
		"user.name=test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"--quiet",
		"--allow-empty",
		"-m",
		"Initial commit",
	]);
	execFileSync("git", ["-C", work, "push", "--quiet", repo, branch]);
	execFileSync("git", ["-C", repo, "symbolic-ref", "HEAD", `refs/heads/${branch}`]);

	let held: { count: number; waiting: (() => void)[]; all: () => void } | null = null;
	const requests: string[] = [];
	const requestsTo: string[] = [];
	let failingPushes = { count: 0, applied: false };
	let busy = 0;
	let failingFetches = 0;
	let answeredPushes = 0;

	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		requests.push(`${req.method} ${url.pathname.split("/").pop()}${url.search}`);
		requestsTo.push(
			`${url.pathname.split("/")[1]?.replace(/\.git$/, "")} ${req.method} ${url.pathname.split("/").pop()}`,
		);
		const isPush = req.method === "POST" && url.pathname.endsWith("/git-receive-pack");
		if (req.method === "POST" && url.pathname.endsWith("/git-upload-pack") && failingFetches > 0) {
			failingFetches--;
			req.resume();
			res.statusCode = 500;
			res.end("Internal Server Error");
			return;
		}
		if (isPush && busy > 0) {
			busy--;
			req.resume();
			const line = "ERR artifacts_git_receive_pack_busy\n";
			res.setHeader("Content-Type", "application/x-git-receive-pack-result");
			res.end(`${(line.length + 4).toString(16).padStart(4, "0")}${line}`);
			return;
		}
		let failThisPush: "before" | "after" | null = null;
		if (isPush && failingPushes.count > 0) {
			failingPushes.count--;
			failThisPush = failingPushes.applied ? "after" : "before";
		}
		if (failThisPush === "before") {
			req.resume();
			res.statusCode = 500;
			res.end("Internal Server Error");
			return;
		}
		if (isPush && held) {
			const gate = held;
			await new Promise<void>((release) => {
				gate.waiting.push(release);
				if (gate.waiting.length === gate.count) {
					held = null;
					for (const go of gate.waiting) go();
					gate.all();
				}
			});
		}
		const cgi = spawn(backend, [], {
			stdio: ["pipe", "pipe", "inherit"],
			env: {
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: "1",
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				REQUEST_METHOD: req.method ?? "GET",
				CONTENT_TYPE: req.headers["content-type"] ?? "",
				REMOTE_USER: "test",
				REMOTE_ADDR: "127.0.0.1",
			} as unknown as NodeJS.ProcessEnv,
		});
		req.pipe(cgi.stdin);
		const chunks: Buffer[] = [];
		cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		cgi.on("close", () => {
			const out = Buffer.concat(chunks);
			const split = out.indexOf("\r\n\r\n");
			const headerText = out.subarray(0, split).toString();
			let status = 200;
			for (const line of headerText.split("\r\n")) {
				const [name = "", ...rest] = line.split(":");
				const value = rest.join(":").trim();
				if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
				else if (name) res.setHeader(name, value);
			}
			if (failThisPush === "after") {
				// Applied, but the answer is lost: the client sees a 500.
				res.statusCode = 500;
				res.end("Internal Server Error");
				return;
			}
			res.statusCode = status;
			res.end(out.subarray(split + 4));
			if (isPush) answeredPushes++;
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");

	const origin = `http://127.0.0.1:${address.port}`;
	// Lets a test helper find the bare repo behind a URL, to read it as the Artifacts API would.
	reposAt.set(origin, (name) => join(root, `${name}.git`));
	return {
		url: `http://127.0.0.1:${address.port}/project.git`,
		git: (...args) => execFileSync("git", ["-C", repo, ...args]).toString(),
		holdPushes: (count) => new Promise<void>((all) => (held = { count, waiting: [], all })),
		pushes: () => answeredPushes,
		requests,
		requestsTo,
		failPushes: (count, applied = false) => void (failingPushes = { count, applied }),
		busyPushes: (count) => void (busy = count),
		failFetches: (count) => void (failingFetches = count),
		repo: (name) => {
			const path = join(root, `${name}.git`);
			if (!existsSync(path)) {
				execFileSync("git", ["init", "--bare", "--quiet", "-b", "main", path]);
				execFileSync("git", ["-C", path, "config", "http.receivepack", "true"]);
			}
			return `http://127.0.0.1:${address.port}/${name}.git`;
		},
		gitIn: (name, ...args) => execFileSync("git", ["-C", join(root, `${name}.git`), ...args]).toString(),
		close: async () => {
			reposAt.delete(origin);
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		},
	};
}
