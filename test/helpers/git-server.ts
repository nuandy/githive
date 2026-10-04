import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
	/** Refuse the next `count` push uploads the way Artifacts does when a repo is busy. */
	busyPushes: (count: number) => void;
	/** Answer the next `count` fetch uploads with a 500, as an overloaded server might. */
	failFetches: (count: number) => void;
	close: () => Promise<void>;
}

const backend = join(execFileSync("git", ["--exec-path"]).toString().trim(), "git-http-backend");

export async function startGitServer(): Promise<GitServer> {
	const root = mkdtempSync(join(tmpdir(), "blueprint-git-"));
	const repo = join(root, "project.git");
	execFileSync("git", ["init", "--bare", "--quiet", repo]);
	execFileSync("git", ["-C", repo, "config", "http.receivepack", "true"]);
	// Like any project repo, it has a main branch with a commit.
	const work = join(root, "work");
	execFileSync("git", ["init", "--quiet", "-b", "main", work]);
	execFileSync("git", ["-C", work, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--quiet", "--allow-empty", "-m", "Initial commit"]);
	execFileSync("git", ["-C", work, "push", "--quiet", repo, "main"]);
	execFileSync("git", ["-C", repo, "symbolic-ref", "HEAD", "refs/heads/main"]);

	let held: { count: number; waiting: (() => void)[]; all: () => void } | null = null;
	const requests: string[] = [];
	let busy = 0;
	let failingFetches = 0;
	let answeredPushes = 0;

	const server: Server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		requests.push(`${req.method} ${url.pathname.split("/").pop()}${url.search}`);
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
				const [name, ...rest] = line.split(":");
				const value = rest.join(":").trim();
				if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
				else if (name) res.setHeader(name, value);
			}
			res.statusCode = status;
			res.end(out.subarray(split + 4));
			if (isPush) answeredPushes++;
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("no port");

	return {
		url: `http://127.0.0.1:${address.port}/project.git`,
		git: (...args) => execFileSync("git", ["-C", repo, ...args]).toString(),
		holdPushes: (count) => new Promise<void>((all) => (held = { count, waiting: [], all })),
		pushes: () => answeredPushes,
		requests,
		busyPushes: (count) => void (busy = count),
		failFetches: (count) => void (failingFetches = count),
		close: async () => {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		},
	};
}
