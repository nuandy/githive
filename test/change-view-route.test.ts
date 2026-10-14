import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeStorage, namespace } from "./fakes/env";
import { agentClone, pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";
import { callTool } from "../src/toolkit/mcp";

// The dashboard's change view and snapshot, through the Worker's routes: what the RepoCache and the FootprintCache
// keep about a change reaches its page, built once and kept like the rest of the view. Artifacts is played by a git
// server; the Durable Objects are the real classes over in-memory storage.

let server: GitServer;
let work: string;

vi.mock("../src/access", () => ({
	verifyAccessRequest: vi.fn(async () => ({ kind: "service", value: "token-1" })),
}));
vi.mock("../src/artifacts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/artifacts")>()),
	remoteFor: vi.fn(async (_artifacts: unknown, _name: string, scope: string) => ({ url: server.url, token: scope })),
	headOf: vi.fn(async (_artifacts: unknown, _name: string, ref: string) => {
		try {
			return server.git("rev-parse", "--verify", "--quiet", ref).trim() || undefined;
		} catch {
			return undefined;
		}
	}),
}));

const worker = (await import("../src/index")).default;
const { RepoCache } = await import("../src/repo-cache");
const { FootprintCache } = await import("../src/footprint-cache");
const { RecordCache } = await import("../src/record-cache");

beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-change-view-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

/** The Worker's env: a RepoCache, a FootprintCache and record caches, each kept per name, and the repo list. */
function workerEnv() {
	const index = { summarize: async () => undefined, addRepo: async () => undefined };
	const env: Record<string, unknown> = { ARTIFACTS: {}, REPO_INDEX: { getByName: () => index } };
	env.REPO_CACHE = namespace(
		() => new RepoCache({ storage: new FakeStorage(), getWebSockets: () => [] } as never, env as never),
	);
	env.FOOTPRINT_CACHE = namespace(() => new FootprintCache({ storage: new FakeStorage() } as never, env as never));
	env.RECORD_CACHE = namespace(() => new RecordCache({ storage: new FakeStorage() } as never, env as never));
	return env as never as Env & {
		REPO_CACHE: { getByName(name: string): InstanceType<typeof RepoCache> };
		FOOTPRINT_CACHE: { getByName(name: string): InstanceType<typeof FootprintCache> };
	};
}
const get = async (env: Env, path: string) => {
	const response = await worker.fetch(new Request(`https://githive.test${path}`), env, {} as never);
	expect(response.status).toBe(200);
	return (await response.json()) as Record<string, unknown>;
};

describe("a change's page through the dashboard's routes", { timeout: 60_000 }, () => {
	const { ctx, call, register } = toolCalls(() => server);

	it("shows its last merge check, its attempts and where its footprint meets others, and its claim's lease", async () => {
		await call("settings", { required: 1, vetoes: [] });
		await register("b");
		await call("claim", { change: "b-1", agent: "b", paths: ["shared.txt"], intent: "share b" }, "b");
		const base = server.git("rev-parse", "main").trim();
		const seed = await agentClone(server.url, work, "seed");
		seed.write("shared.txt", "a\n");
		await seed.run("add", "shared.txt");
		await seed.run("commit", "-q", "-m", "add shared");
		await seed.run("push", "--quiet", "origin", "main");
		const main = server.git("rev-parse", "main").trim();
		const head = await pushChange(server.url, work, "b", "b-1", { "shared.txt": "b\n" }, base);

		// What status, the merge and the push consumer keep, in the repo's caches.
		const env = workerEnv();
		const repoCache = env.REPO_CACHE.getByName("repo:p");
		const result = { into: "main", branchHead: main, clean: false, conflicts: ["shared.txt"], fix: ["git push"] };
		await repoCache.keepMergeCheck("b-1", { key: `${head} ${main}`, result });
		await repoCache.noteAttempt("b-1", "conflict on shared.txt");
		const footprints = env.FOOTPRINT_CACHE.getByName("footprints:p");
		const altered = { name: "loadSettings", change: "removed" as const, before: "export function loadSettings()" };
		const ours = { change: "b-1", agent: "b", branch: "main", head, base, at: 1, uses: [] };
		const theirs = { change: "c-3", agent: "carol", branch: "main", head: "h", base, at: 1, alters: [] };
		const claimed = { "b-1": "b", "c-3": "carol" };
		await footprints.keep(
			"p",
			{ ...theirs, uses: [{ file: "src/config.ts", name: "loadSettings", at: [{ file: "src/s.ts", line: 4 }] }] },
			claimed,
		);
		await footprints.keep("p", { ...ours, alters: [{ file: "src/config.ts", altered }] }, claimed);

		const page = await get(env, "/repos/_/p/changes/b-1");
		expect(page).toMatchObject({
			change: "b-1",
			claim: { agent: "b" },
			commits: [{ commit: head }],
			merge: { head, ...result },
			attempts: ["conflict on shared.txt"],
			awareness: { change: "b-1", usedBy: [{ altered, other: { by: "carol", change: "c-3" } }], alteredBy: [] },
		});
		// Kept like the rest of the view: read again, it's the same page without rebuilding it.
		await repoCache.noteAttempt("b-1", "checks failed: npm test exited 1");
		expect((await get(env, "/repos/_/p/changes/b-1")).attempts).toEqual(["conflict on shared.txt"]);

		// Its files: what it changed since it left main, whatever main did since.
		expect(await get(env, "/repos/_/p/changes/b-1/diff")).toMatchObject({
			change: "b-1",
			of: "head",
			base,
			head,
			total: 1,
			files: [{ path: "shared.txt", status: "added", added: 1, removed: 0 }],
		});

		// The repo's snapshot gives each claim's lease: b-1 is pushed, so it waits on review.
		const snapshot = (await get(env, "/repos/_/p")) as { claims: { change: string; lease?: unknown }[] };
		expect(snapshot.claims).toEqual([expect.objectContaining({ change: "b-1", lease: { waitingOn: "reviewers" } })]);
	});

	it("keeps a change's files near the cap, so the next view doesn't diff them again", async () => {
		// Another repo on the server: the isolate keeps the first test's server as p's for a while.
		const inQ = (name: string, args: Record<string, unknown>, agentKey?: string) =>
			callTool(name, { repo: "q", ...args }, { ...ctx(), ...(agentKey ? { agentKey } : {}) });
		await inQ("settings", { required: 1, vetoes: [] });
		const { key } = (await inQ("register", { agent: "c" })) as { key: string };
		await inQ("claim", { change: "c-1", agent: "c", paths: ["data/"], intent: "data" }, key);
		// Five files near the most a side may weigh, of tabs, quotes and backslashes, which JSON makes twice as long.
		const text = `${'\t"\\'.repeat(30)}\n`.repeat(2600);
		const files = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`data/${n}.txt`, text]));
		await pushChange(server.url, work, "c", "c-1", files);

		const env = workerEnv();
		const diff = (await get(env, "/repos/_/q/changes/c-1/diff")) as { files: { cut?: true }[]; total: number };
		expect(diff.total).toBe(5);
		expect(diff.files.filter((file) => file.cut)).not.toEqual([]);
		expect((await env.REPO_CACHE.getByName("repo:q").view("diff:c-1", 60_000)).json).toBeDefined();
	});
});
