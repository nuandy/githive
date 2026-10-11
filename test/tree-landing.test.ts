import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactsInspect, forgetChains, type ReadHistory } from "../src/toolkit/batch-reads";
import { type ChangePacks, prefetchChange, treeLanding } from "../src/toolkit/tree-landing";
import { agentClone, pushChange } from "./helpers/agents";
import { gitHistory } from "./helpers/git-history";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

const exec = promisify(execFile);

let server: GitServer;
let work: string;

// The Artifacts API over each repo on the test server, by name: the project, and agents' forks.
const history: ReadHistory = (repo, read) =>
	gitHistory(repo === "project" ? server.git : (...args) => server.gitIn(repo, ...args))(repo, read);

const project = () => ({ url: server.url, token: "unused" });

/** Seeds main with a few files and folders, as if the project had them. */
async function seedMain() {
	const clone = await agentClone(server.url, work, "seed");
	const files: Record<string, string> = {
		"README.md": "# Project\n",
		"old.txt": "to be deleted\n",
		cfg: "a file that becomes a folder\n",
		"docs/a.md": "docs\n",
		"lib/core.js": "core\n",
		"lib/util/u.js": "util\n",
	};
	for (const [path, text] of Object.entries(files)) clone.write(path, text);
	await clone.run("add", "-A");
	await clone.run("commit", "-qm", "Seed");
	await clone.run("push", "-q", "origin", "main");
}

/** A change made in its agent's own fork: the fork starts from main, then the change's branch is pushed there. */
async function forkChange(change: string, edit: (clone: Awaited<ReturnType<typeof agentClone>>) => Promise<void>) {
	const fork = server.repo(`fork-${change}`);
	const clone = await agentClone(server.url, work, `agent-${change}`);
	await clone.run("push", "-q", fork, "main");
	await clone.run("checkout", "-qb", `changes/${change}`);
	await edit(clone);
	await clone.run("add", "-A");
	await clone.run("commit", "-qm", `${change}: work`);
	await clone.run("push", "-q", fork, `changes/${change}`);
	return { change, head: await clone.run("rev-parse", "HEAD"), source: { url: fork, token: "unused" } };
}

/** Moves main on with a commit of its own after the changes left it. */
async function moveMain(path: string, text: string) {
	const clone = await agentClone(server.url, work, `main-${path.replace(/\W/g, "-")}`);
	clone.write(path, text);
	await clone.run("add", "-A");
	await clone.run("commit", "-qm", `main: ${path}`);
	await clone.run("push", "-q", "origin", "main");
}

const merge = (made: { change: string; head: string; source: { url: string; token: string } }) => ({
	change: made.change,
	head: made.head,
	ref: `changes/${made.change}`,
	source: made.source,
	agent: `agent-${made.change}`,
	claimed: {
		head: made.head,
		change: made.change,
		author: `agent-${made.change}`,
		claimsTip: "c".repeat(40),
		votesTip: "",
		intent: `do ${made.change}`,
	},
});

/** What real git makes of the same batch: main at `base` with each change merged in order, --no-ff. */
async function gitMergeTree(base: string, made: { change: string; source: { url: string } }[]) {
	const dir = mkdtempSync(join(tmpdir(), "githive-expected-"));
	// Async, because the test server runs in this process and must answer the fetches.
	const git = async (...args: string[]) =>
		(await exec("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args])).stdout.trim();
	try {
		await git("init", "-q");
		await git("fetch", "-q", server.url, "main");
		await git("checkout", "-q", base);
		for (const each of made) {
			await git("fetch", "-q", each.source.url, `changes/${each.change}`);
			await git("merge", "-q", "--no-ff", "-m", `merge ${each.change}`, "FETCH_HEAD");
		}
		return await git("rev-parse", "HEAD^{tree}");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

beforeEach(async () => {
	forgetChains();
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-tree-landing-"));
	await seedMain();
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

describe("landing a batch with trees, in the Worker", { timeout: 60_000 }, () => {
	it("makes the tree git's merge makes, merge commits included, in one push", async () => {
		const nested = await forkChange("nested", async (clone) => {
			clone.write("lib/new/x.js", "new\n");
			clone.write("README.md", "# Project\n\nMore.\n");
		});
		const reshape = await forkChange("reshape", async (clone) => {
			await clone.run("rm", "-q", "old.txt", "cfg");
			clone.write("cfg/a.json", "{}\n");
			clone.write("lib/util/v.js", "another\n");
		});
		await moveMain("docs/b.md", "main moved on\n");
		const base = server.git("rev-parse", "main").trim();
		const fallback = vi.fn(async () => {
			throw new Error("landed in the Gate");
		});
		const land = treeLanding({ history, project: "project", remote: async () => project(), fallback });

		const pushesBefore = server.pushes();
		const landed = await land({ base, branch: "main", merges: [merge(nested), merge(reshape)] });
		expect(server.pushes() - pushesBefore).toBe(1);

		expect(fallback).not.toHaveBeenCalled();
		if (landed === "moved") throw new Error("moved");
		expect(landed.commits).toHaveLength(2);
		const tip = server.git("rev-parse", "main").trim();
		expect(tip).toBe(landed.commits[1]);
		expect(server.git("rev-parse", `${tip}^{tree}`).trim()).toBe(await gitMergeTree(base, [nested, reshape]));
		const [first, second] = landed.commits as [string, string];
		expect(server.git("rev-list", "--parents", "-n1", first).trim()).toBe(`${first} ${base} ${nested.head}`);
		expect(server.git("rev-list", "--parents", "-n1", second).trim()).toBe(`${second} ${first} ${reshape.head}`);
		expect(server.git("log", "-1", "--format=%an <%ae>", second).trim()).toBe("GitHive <bot@githive.invalid>");
		expect(server.git("log", "-1", "--format=%B", second)).toContain("GitHive-Change: reshape");
		// One push: the changes' objects and the merges together.
		expect(server.git("for-each-ref", "refs/notes").trim()).toBe("");
		// The project repo holds every object it now refers to.
		expect(() => server.git("fsck", "--connectivity-only", "--no-dangling")).not.toThrow();
	});

	it("lands a change its merge fetched while waiting without asking its fork again", async () => {
		const kept = new Map<string, Uint8Array>();
		const packs: ChangePacks = {
			keep: async (head, pack) => void kept.set(head, pack),
			read: async (heads) =>
				Object.fromEntries(heads.filter((head) => kept.has(head)).map((head) => [head, kept.get(head)!])),
		};
		const early = await forkChange("early", async (clone) => clone.write("lib/early.js", "early\n"));
		await moveMain("docs/d.md", "main moved on\n");
		const reads = { history, project: "project", remote: async () => project(), packs };
		await prefetchChange(reads, "main", merge(early));
		expect([...kept.keys()]).toEqual([early.head]);
		const base = server.git("rev-parse", "main").trim();
		const fallback = vi.fn(async () => ({ commits: [] }));
		const fetchesBefore = server.requestsTo.filter((request) => /fork-early.*git-upload-pack/.test(request)).length;
		expect(fetchesBefore).toBeGreaterThan(0);

		const landed = await treeLanding({ ...reads, fallback })({ base, branch: "main", merges: [merge(early)] });

		expect(fallback).not.toHaveBeenCalled();
		expect(server.requestsTo.filter((request) => /fork-early.*git-upload-pack/.test(request)).length).toBe(
			fetchesBefore,
		);
		if (landed === "moved") throw new Error("moved");
		expect(server.git("rev-parse", `${landed.commits[0]}^{tree}`).trim()).toBe(await gitMergeTree(base, [early]));
	});

	it("lands in the Gate when a change and main both changed a file", async () => {
		const readme = await forkChange("readme", async (clone) => clone.write("README.md", "# Mine\n"));
		await moveMain("README.md", "# Theirs\n");
		const base = server.git("rev-parse", "main").trim();
		const fallback = vi.fn(async () => ({ commits: ["from the Gate"] }));
		const land = treeLanding({ history, project: "project", remote: async () => project(), fallback });

		expect(await land({ base, branch: "main", merges: [merge(readme)] })).toEqual({ commits: ["from the Gate"] });
		expect(fallback).toHaveBeenCalledTimes(1);
		expect(server.git("rev-parse", "main").trim()).toBe(base);
	});

	it("lands in the Gate when two changes in the batch touch the same file", async () => {
		const one = await forkChange("one", async (clone) => clone.write("lib/core.js", "one\n"));
		const two = await forkChange("two", async (clone) => clone.write("lib/core.js", "two\n"));
		const base = server.git("rev-parse", "main").trim();
		const fallback = vi.fn(async () => ({ commits: [] }));
		const land = treeLanding({ history, project: "project", remote: async () => project(), fallback });

		await land({ base, branch: "main", merges: [merge(one), merge(two)] });
		expect(fallback).toHaveBeenCalledTimes(1);
	});

	it.each([
		["sends the push again after a server error that applied nothing", false],
		["counts a push the server failed but applied as landed", true],
	])("%s", async (_name, applied) => {
		const change = await forkChange("retry", async (clone) => clone.write("lib/retry.js", "retry\n"));
		const base = server.git("rev-parse", "main").trim();
		const fallback = vi.fn(async () => ({ commits: [] }));
		const land = treeLanding({ history, project: "project", remote: async () => project(), fallback });
		server.failPushes(1, applied);

		const landed = await land({ base, branch: "main", merges: [merge(change)] });

		expect(fallback).not.toHaveBeenCalled();
		if (landed === "moved") throw new Error("moved");
		expect(server.git("rev-parse", "main").trim()).toBe(landed.commits[0]);
	});

	it("lands in the Gate when the push keeps failing", async () => {
		const change = await forkChange("broken", async (clone) => clone.write("lib/broken.js", "broken\n"));
		const base = server.git("rev-parse", "main").trim();
		const fallback = vi.fn(async () => ({ commits: ["from the Gate"] }));
		const land = treeLanding({ history, project: "project", remote: async () => project(), fallback });
		server.failPushes(20);

		expect(await land({ base, branch: "main", merges: [merge(change)] })).toEqual({ commits: ["from the Gate"] });
		expect(server.git("rev-parse", "main").trim()).toBe(base);
	});

	it("lands a change beside a file main added in the same new folder, as git merges it", async () => {
		const beside = await forkChange("beside", async (clone) => clone.write("pkg/new/a.js", "a\n"));
		await moveMain("pkg/new/b.js", "b\n");
		const base = server.git("rev-parse", "main").trim();
		const fallback = vi.fn(async () => ({ commits: [] }));
		const landed = await treeLanding({ history, project: "project", remote: async () => project(), fallback })({
			base,
			branch: "main",
			merges: [merge(beside)],
		});

		expect(fallback).not.toHaveBeenCalled();
		if (landed === "moved") throw new Error("moved");
		expect(server.git("rev-parse", `${landed.commits[0]}^{tree}`).trim()).toBe(await gitMergeTree(base, [beside]));
	});

	it("lands in the Gate when main put a file where the change has a folder", async () => {
		const folder = await forkChange("folder", async (clone) => clone.write("conf/settings.json", "{}\n"));
		await moveMain("conf", "a file now\n");
		const base = server.git("rev-parse", "main").trim();
		const fallback = vi.fn(async () => ({ commits: ["from the Gate"] }));
		const land = treeLanding({ history, project: "project", remote: async () => project(), fallback });

		expect(await land({ base, branch: "main", merges: [merge(folder)] })).toEqual({ commits: ["from the Gate"] });
	});

	it("reads each tree once in a batch, however many changes share it", async () => {
		const made = [];
		for (const name of ["r1", "r2", "r3", "r4"])
			made.push(await forkChange(name, async (clone) => clone.write(`notes/${name}/x.js`, `${name}\n`)));
		await moveMain("docs/e.md", "main moved on\n");
		const base = server.git("rev-parse", "main").trim();
		const reads = new Map<string, number>();
		const counted: ReadHistory = (repo, read) =>
			history(repo, (source) =>
				read({
					...source,
					log: (...args) => source.log(...args),
					readCommit: (hash) => source.readCommit(hash),
					readTree: (hash) => {
						reads.set(hash, (reads.get(hash) ?? 0) + 1);
						return source.readTree(hash);
					},
				}),
			);
		const fallback = vi.fn(async () => ({ commits: [] }));
		await treeLanding({ history: counted, project: "project", remote: async () => project(), fallback })({
			base,
			branch: "main",
			merges: made.map(merge),
		});

		expect(fallback).not.toHaveBeenCalled();
		expect(Math.max(...reads.values())).toBe(1);
	});

	it("places and builds a batch it gathered without reading the changes' forks again", async () => {
		const made = [];
		for (const name of ["g1", "g2", "g3"])
			made.push(await forkChange(name, async (clone) => clone.write(`notes/${name}/x.js`, `${name}\n`)));
		const base = server.git("rev-parse", "main").trim();
		const forkLogs: string[] = [];
		const forkTrees: string[] = [];
		const forkOpens: string[] = [];
		const counted: ReadHistory = (repo, read) => {
			if (repo !== "project") forkOpens.push(repo);
			return history(repo, (source) =>
				read({
					log: (...args) => {
						if (repo !== "project") forkLogs.push(repo);
						return source.log(...args);
					},
					readCommit: (hash) => source.readCommit(hash),
					readTree: (hash) => {
						if (repo !== "project") forkTrees.push(hash);
						return source.readTree(hash);
					},
				}),
			);
		};
		const gateInspect = vi.fn(async () => []);
		const inspected = await artifactsInspect(
			counted,
			"project",
			gateInspect,
		)({
			base,
			branch: "main",
			changes: made.map(({ head: _head, ...rest }) => ({ ...rest, ref: `changes/${rest.change}`, agent: "a" })),
		});
		expect(inspected.map((each) => ("head" in each ? each.head : each.error))).toEqual(made.map((each) => each.head));
		const gathered = forkLogs.length;
		const treesGathered = forkTrees.length;
		const opened = forkOpens.length;
		const fallback = vi.fn(async () => ({ commits: [] }));

		await treeLanding({ history: counted, project: "project", remote: async () => project(), fallback })({
			base,
			branch: "main",
			merges: made.map(merge),
		});

		expect(fallback).not.toHaveBeenCalled();
		expect(gathered).toBe(3);
		expect(forkLogs.length).toBe(gathered);
		expect(treesGathered).toBeGreaterThan(0);
		expect(forkTrees.length).toBe(treesGathered);
		expect(forkOpens.length).toBe(opened);
	});

	it("answers moved when main moved past the base, and lands nothing", async () => {
		const change = await forkChange("late", async (clone) => clone.write("lib/late.js", "late\n"));
		const base = server.git("rev-parse", "main").trim();
		const fallback = vi.fn(async () => ({ commits: [] }));
		// Main moves after the batch is read and before it's pushed: the push's lease on the base refuses it.
		const remote = async (scope: "read" | "write") => {
			if (scope === "write") await moveMain("docs/c.md", "racing\n");
			return project();
		};
		const land = treeLanding({ history, project: "project", remote, fallback });

		expect(await land({ base, branch: "main", merges: [merge(change)] })).toBe("moved");
		expect(server.git("log", "-1", "--format=%s", "main").trim()).toBe("main: docs/c.md");
		expect(fallback).not.toHaveBeenCalled();
	});
});

describe("a merge fetching its change while it waits", { timeout: 60_000 }, () => {
	it("asks for its own change, on the branch it lands on", async () => {
		const prefetchChange = vi.fn(async () => {});
		const { call, register } = toolCalls(() => server, { prefetchChange });
		await call("settings", { required: 0, vetoes: [] });
		await register("a");
		await call("claim", { change: "pre", agent: "a", paths: ["lib/pre/"], intent: "pre" }, "a");
		const head = await pushChange(server.url, work, "a", "pre", { "lib/pre/x.js": "x\n" });

		expect(await call("merge", { change: "pre", agent: "a" }, "a")).toMatchObject({ ok: true });
		expect(prefetchChange).toHaveBeenCalledWith("p", "main", expect.objectContaining({ change: "pre", head }));
	});
});
