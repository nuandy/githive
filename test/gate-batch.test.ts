import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentClone, pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { FakeStorage } from "./fakes/env";
import { localContainer } from "./helpers/local-container";
import { type HistorySource, type KeptFiles, readBranchHistory } from "../src/toolkit/branch-history";
import { mergeRecordOf, readMainMerges } from "../src/toolkit/git-records";
import { concat } from "../src/git-fetch";
import { fetchPackSince } from "../src/git-pack";

// The repo's own Gate reads a batch's changes and lands them with real git in
// its container. Here the container runs its commands with this machine's git,
// in a folder standing in for its checkout, against a test Git server, so what
// the Gate reads and pushes is what git really does.

const { Gate } = await import("../src/gate");

describe("reading and landing a batch in the repo's own Gate", { timeout: 60_000 }, () => {
	let server: GitServer;
	let work: string;
	let checkout: string;
	let gate: InstanceType<typeof Gate>;
	const base = () => ({ remote: server.url, token: "unused" });
	const source = (change: string) => ({ change, remote: server.url, token: "unused", ref: `changes/${change}` });
	const claimed = (change: string, head: string) => ({
		head,
		change,
		author: `agent-${change}`,
		claimsTip: "c1",
		votesTip: "v1",
	});

	beforeEach(async () => {
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "githive-gate-batch-"));
		checkout = join(work, "checkout");
		const storage = new FakeStorage();
		// The repo's own Gate: its id is the repo's.
		gate = new Gate(
			{ storage, container: localContainer(checkout), id: { equals: () => true } } as never,
			{ GATE: { idFromName: () => ({}) } } as never,
		);
	});
	afterEach(async () => {
		await server.close();
		rmSync(work, { recursive: true, force: true });
	});

	it("reads each change's head and the files it changed since it left main", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", {
			"src/a.txt": "a\n",
			"src/sub/b c.txt": "space\n",
		});
		const read = await gate.inspectBatch({
			repo: "t1",
			branch: "main",
			base: base(),
			baseHead: main,
			changes: [source("a-1"), source("missing-1")],
		});
		expect(read[0]).toEqual({ change: "a-1", head: a, files: ["src/a.txt", "src/sub/b c.txt"] });
		expect(read[1]).toMatchObject({
			change: "missing-1",
			error: expect.stringContaining("fetch of its branch failed"),
		});
	});

	it("fetches many changes at once, and reads each one's own head and files", async () => {
		const main = server.git("rev-parse", "main").trim();
		const ids = Array.from({ length: 10 }, (_, i) => `n-${i}`);
		const heads = await Promise.all(
			ids.map((id) =>
				pushChange(server.url, work, `agent-${id}`, id, { [`notes/${id}.js`]: `module.exports = "${id}";\n` }),
			),
		);
		const read = await gate.inspectBatch({
			repo: "t1",
			branch: "main",
			base: base(),
			baseHead: main,
			changes: ids.map(source),
		});
		expect(read).toEqual(ids.map((id, i) => ({ change: id, head: heads[i], files: [`notes/${id}.js`] })));
	});

	it("lands each change as its own merge commit with its trailers, in one push, and says when main moved", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/a.txt": "a\n" });
		const b = await pushChange(server.url, work, "agent-b-1", "b-1", { "src/b.txt": "b\n" });
		// b-1's story: no intent, a review and an earlier attempt to land.
		const story = {
			reviews: [{ reviewer: "rev", role: "review", evidence: "ran the tests" }],
			attempts: ["checks failed: npm test exited 1"],
		};
		const merges = [
			{ ...source("a-1"), head: a, claimed: { ...claimed("a-1", a), testedOn: main, testedWith: [a, b] } },
			{ ...source("b-1"), head: b, claimed: { ...claimed("b-1", b), testedOn: main, testedWith: [a, b], ...story } },
		];
		const landed = await gate.landBatch({ repo: "t1", branch: "main", base: base(), baseHead: main, merges });
		expect(landed).toEqual({ commits: [expect.any(String), expect.any(String)] });
		const [first, second] = (landed as { commits: [string, string] }).commits;
		expect(server.git("rev-parse", "main").trim()).toBe(second);
		// Each a merge of the one before it and its change, with the trailers the audit reads.
		expect(server.git("rev-list", "--parents", "-1", first).trim()).toBe(`${first} ${main} ${a}`);
		expect(server.git("rev-list", "--parents", "-1", second).trim()).toBe(`${second} ${first} ${b}`);
		expect(
			server
				.git(
					"log",
					"-1",
					"--format=%an " +
						"<%ae>%n%(trailers:key=GitHive-Change,valueonly)%(trailers:key=GitHive-Tested-With,valueonly)",
					second,
				)
				.trim()
				.split("\n"),
		).toEqual(["GitHive <bot@githive.invalid>", "b-1", `${a} ${b}`]);
		// The story above the trailers, written in the Gate as everywhere else.
		expect(server.git("log", "-1", "--format=%B", second)).toMatch(
			/^Merge b-1 by agent-b-1\n\nReviewed by:\n- rev \(review\): ran the tests\n\nEarlier attempts:\n- checks failed: npm test exited 1\n\nGitHive-Change: b-1\n/,
		);
		// Checked against the previous main. Main has moved since, so nothing lands.
		const c = await pushChange(server.url, work, "agent-c-1", "c-1", { "src/c.txt": "c\n" });
		expect(
			await gate.landBatch({
				repo: "t1",
				branch: "main",
				base: base(),
				baseHead: main,
				merges: [{ ...source("c-1"), head: c, claimed: claimed("c-1", c) }],
			}),
		).toEqual({ moved: true });
		expect(server.git("rev-parse", "main").trim()).toBe(second);
	});

	it("names the change that doesn't merge onto the batch and the files it conflicts on, and lands nothing", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/shared.txt": "a\n" });
		const b = await pushChange(server.url, work, "agent-b-1", "b-1", { "src/shared.txt": "b\n", "src/b.txt": "b\n" });
		const merges = [
			{ ...source("a-1"), head: a, claimed: claimed("a-1", a) },
			{ ...source("b-1"), head: b, claimed: claimed("b-1", b) },
		];
		const landed = await gate.landBatch({ repo: "t1", branch: "main", base: base(), baseHead: main, merges });
		expect(landed).toEqual({
			error: expect.stringMatching(/^merging b-1 onto the batch failed: src\/shared\.txt\n/),
			conflict: { change: "b-1", files: ["src/shared.txt"] },
		});
		expect(server.git("rev-parse", "main").trim()).toBe(main);
	});

	it("names the change whose merge fails without listing files, which a fetch or a push never is", async () => {
		const main = server.git("rev-parse", "main").trim();
		// A branch with no history in common with main: git refuses to merge it, and lists no conflicted file.
		const clone = await agentClone(server.url, work, "orphan");
		await clone.run("checkout", "--quiet", "--orphan", "changes/o-1");
		await clone.run("rm", "-rqf", "--ignore-unmatch", ".");
		clone.write("src/o.txt", "o\n");
		await clone.run("add", "-A");
		await clone.run("commit", "--quiet", "-m", "start over");
		await clone.run("push", "--quiet", "origin", "changes/o-1");
		const head = await clone.run("rev-parse", "HEAD");
		const merges = [{ ...source("o-1"), head, claimed: claimed("o-1", head) }];
		const landed = await gate.landBatch({ repo: "t1", branch: "main", base: base(), baseHead: main, merges });
		expect(landed).toEqual({
			error: expect.stringMatching(/^merging o-1 onto the batch failed: .*unrelated histories/s),
			conflict: { change: "o-1", files: [] },
		});
		expect(server.git("rev-parse", "main").trim()).toBe(main);
	});

	it("lands changes from the packs their merges kept, fetching neither them nor main again", async () => {
		const main = server.git("rev-parse", "main").trim();
		const kept: Record<string, Uint8Array> = {};
		const changeCache = { changePacks: async (heads: string[]) => Object.fromEntries(heads.map((h) => [h, kept[h]!])) };
		const keeping = new Gate(
			{ storage: new FakeStorage(), container: localContainer(checkout), id: { equals: () => true } } as never,
			{ GATE: { idFromName: () => ({}) }, CHANGE_CACHE: { getByName: () => changeCache } } as never,
		);
		await keeping.boot({ repo: "t1", base: base() });
		// Pushed after the Gate cloned the project, so it has neither change.
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/a.txt": "a\n" });
		const b = await pushChange(server.url, work, "agent-b-1", "b-1", { "lib/b.txt": "b\n" });
		for (const head of [a, b]) {
			const pack = await fetchPackSince({ url: server.url, token: "unused" }, [head], [main], { bytes: 1e6 });
			if (pack === "too big") throw new Error("too big");
			kept[head] = concat(pack.parts);
		}
		const fetches = () => server.requests.filter((request) => request.includes("upload-pack")).length;
		const before = fetches();
		const merges = [
			{ ...source("a-1"), head: a, claimed: claimed("a-1", a) },
			{ ...source("b-1"), head: b, claimed: claimed("b-1", b) },
		];
		const landed = await keeping.landBatch({ repo: "t1", branch: "main", base: base(), baseHead: main, merges });
		expect(landed).toEqual({ commits: [expect.any(String), expect.any(String)] });
		expect(fetches() - before).toBe(0);
		const [first, second] = (landed as { commits: [string, string] }).commits;
		expect(server.git("rev-list", "--parents", "-1", second).trim()).toBe(`${second} ${first} ${b}`);
		expect(server.git("ls-tree", "-r", "--name-only", second)).toContain("lib/b.txt");
	});

	it("checks a batch with all its changes fetched at once, in a change's Gate", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/a.txt": "a\n" });
		const b = await pushChange(server.url, work, "agent-b-1", "b-1", { "src/b.txt": "b\n" });
		const env = {
			GATE: {
				idFromName: () => ({}),
				getByName: () => ({ snapshot: async () => null, warmUp: async () => undefined }),
			},
		};
		const changeGate = new Gate(
			{
				storage: new FakeStorage(),
				container: localContainer(join(work, "change-checkout")),
				id: { equals: () => false },
			} as never,
			env as never,
		);
		const batch = {
			repo: "t1",
			branch: "main",
			base: base(),
			baseHead: main,
			ahead: [{ head: a, ...source("a-1") }],
			fork: source("b-1"),
			head: b,
		};
		// Both changes merged onto main: the check sees both files.
		expect(
			await changeGate.checkCommit({ ...batch, checks: ["test -f src/a.txt && test -f src/b.txt"] }),
		).toMatchObject({ passed: true, head: b, baseHead: main });
		expect(await changeGate.checkCommit({ ...batch, checks: ["test -f src/missing.txt"] })).toMatchObject({
			passed: false,
		});
		// Checked again in the same container, which a batch's search reuses. Its commits are already here, so
		// nothing is fetched, even from a branch that has since been deleted.
		const again = await changeGate.checkCommit({
			...batch,
			ahead: [{ head: a, ...source("gone-1") }],
			checks: ["test -f src/a.txt && test -f src/b.txt"],
		});
		expect(again).toMatchObject({ passed: true });
		// A change whose branch can't be fetched, and isn't here, fails the check's setup, naming it.
		const c = await pushChange(server.url, work, "agent-c-1", "c-1", { "src/c.txt": "c\n" });
		server.git("update-ref", "-d", "refs/heads/changes/c-1");
		const lost = await changeGate.checkCommit({ ...batch, ahead: [{ head: c, ...source("c-1") }], checks: ["true"] });
		expect(lost).toMatchObject({
			passed: false,
			results: [{ command: "(gate setup)", output: expect.stringContaining("fetch of a change in the batch failed") }],
		});
	});

	it("leaves the audit's reading to Artifacts' API, which reads the branch's merges exactly as git does", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/a.txt": "a\n", "src/deep/x.txt": "x\n" });
		const b = await pushChange(server.url, work, "agent-b-1", "b-1", { "src/b.txt": "b\n" });
		const merges = [
			{ ...source("a-1"), head: a, claimed: { ...claimed("a-1", a), testedOn: main, testedWith: [a, b] } },
			{ ...source("b-1"), head: b, claimed: { ...claimed("b-1", b), testedOn: main, testedWith: [a, b] } },
		];
		expect(await gate.landBatch({ repo: "t1", branch: "main", base: base(), baseHead: main, merges })).toMatchObject({
			commits: expect.any(Array),
		});
		// Artifacts' log, readCommit and readTree, answered by git on the server.
		let treesRead = 0;
		const meta = (line: string) => {
			const [hash = "", treeHash = "", name = "", parents = "", committed = "", message = ""] = line.split("\x1f");
			return {
				hash,
				treeHash,
				author: { name },
				parents: parents.split(" ").filter(Boolean),
				committedAt: Number(committed),
				message: message.replace(/\n$/, ""),
			};
		};
		const FORMAT = "--format=%H%x1f%T%x1f%an%x1f%P%x1f%ct%x1f%B%x1e";
		const history: HistorySource = {
			log: async (ref, limit, offset) =>
				server
					.git("log", "--first-parent", `--skip=${offset}`, `-n${limit}`, FORMAT, ref)
					.split("\x1e")
					.map((l) => l.replace(/^\n/, ""))
					.filter(Boolean)
					.map(meta),
			readCommit: async (hash) => meta(server.git("log", "-1", FORMAT, hash).split("\x1e")[0]!),
			readTree: async (hash) => (
				treesRead++,
				server
					.git("ls-tree", hash)
					.split("\n")
					.filter(Boolean)
					.map((l) => {
						const [info, name] = l.split("\t") as [string, string];
						const [mode, type, oid] = info.split(" ") as [string, string, string];
						return { name, mode, hash: oid, type: type === "commit" ? "gitlink" : type };
					})
			),
		};
		const kept = new Map<string, string[]>();
		const keep: KeptFiles = {
			get: async (cs) => Object.fromEntries(cs.flatMap((c) => (kept.has(c) ? [[c, kept.get(c)!]] : []))),
			put: async (f) => void Object.entries(f).forEach(([c, p]) => kept.set(c, p)),
		};
		const read = (await readBranchHistory(history, main, "main", keep)).map(mergeRecordOf);
		expect(read.map((m) => [m.change, m.head, m.files])).toEqual([
			["a-1", a, ["src/a.txt", "src/deep/x.txt"]],
			["b-1", b, ["src/b.txt"]],
		]);
		expect(read[1]!.testedWith).toEqual([a, b]);
		expect(read).toEqual(await readMainMerges({ url: server.url, token: "unused" }, main, "main"));
		// The files each merge changed are cached by commit, so reading them again reads no tree.
		const before = treesRead;
		expect((await readBranchHistory(history, main, "main", keep)).map(mergeRecordOf)).toEqual(read);
		expect(treesRead).toBe(before);
	});

	it("builds a batch's commit for GitHub Actions, each change its own merge onto main, and pushes it", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/a.txt": "a\n" });
		const b = await pushChange(server.url, work, "agent-b-1", "b-1", { "src/b.txt": "b\n" });
		const github = { remote: server.repo("github"), token: "t", user: "x-access-token" };
		const made = await gate.checksBranch({
			repo: "t1",
			branch: "main",
			base: base(),
			baseHead: main,
			changes: [
				{ ...source("a-1"), head: a },
				{ ...source("b-1"), head: b },
			],
			to: github,
			ref: "githive/checks/x-0",
		});
		expect(made).toMatchObject({ tip: expect.stringMatching(/^[0-9a-f]{40}$/) });
		const tip = (made as { tip: string }).tip;
		expect(server.gitIn("github", "rev-parse", "githive/checks/x-0").trim()).toBe(tip);
		// Merge b, then merge a, then main.
		expect(
			server
				.gitIn("github", "log", "--first-parent", "-3", "--format=%H %P", tip)
				.trim()
				.split("\n")
				.map((l) => l.split(" ")),
		).toEqual([[tip, expect.any(String), b], [expect.any(String), main, a], [main]]);
		expect(server.gitIn("github", "ls-tree", "-r", "--name-only", tip).split("\n")).toEqual(
			expect.arrayContaining(["src/a.txt", "src/b.txt"]),
		);
	});

	it("says which change doesn't merge onto the batch, and pushes nothing", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/same.txt": "a\n" });
		const b = await pushChange(server.url, work, "agent-b-1", "b-1", { "src/same.txt": "b\n" });
		const made = await gate.checksBranch({
			repo: "t1",
			branch: "main",
			base: base(),
			baseHead: main,
			changes: [
				{ ...source("a-1"), head: a },
				{ ...source("b-1"), head: b },
			],
			to: { remote: server.repo("github"), token: "t" },
			ref: "githive/checks/y-0",
		});
		expect(made).toEqual({
			failed: expect.stringMatching(/^b-1 doesn't merge onto the batch: .*src\/same\.txt/s),
			conflict: { change: "b-1", files: ["src/same.txt"] },
		});
		expect(server.gitIn("github", "for-each-ref", "--format=%(refname)").trim()).toBe("");
	});

	it("pushes main back to GitHub as a fast-forward, and never over what someone pushed there directly", async () => {
		const github = { remote: server.repo("github"), token: "t", user: "x-access-token" };
		const main = server.git("rev-parse", "main").trim();
		expect(await gate.pushBranch({ repo: "t1", branch: "main", base: base(), head: main, to: github })).toEqual({
			pushed: true,
		});
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/a.txt": "a\n" });
		server.git("update-ref", "refs/heads/main", a);
		expect(await gate.pushBranch({ repo: "t1", branch: "main", base: base(), head: a, to: github })).toEqual({
			pushed: true,
		});
		expect(server.gitIn("github", "rev-parse", "main").trim()).toBe(a);
		// Someone pushes to GitHub directly: GitHive's next push is refused, not forced.
		const direct = server.gitIn("github", "commit-tree", "-m", "direct", "-p", a, `${a}^{tree}`).trim();
		server.gitIn("github", "update-ref", "refs/heads/main", direct);
		const b = await pushChange(server.url, work, "agent-b-1", "b-1", { "src/b.txt": "b\n" }, "main");
		server.git("update-ref", "refs/heads/main", b);
		expect(await gate.pushBranch({ repo: "t1", branch: "main", base: base(), head: b, to: github })).toEqual({
			refused: expect.any(String),
		});
		expect(server.gitIn("github", "rev-parse", "main").trim()).toBe(direct);
	});

	it("is only ever done by the repo's own Gate, never a change's, which runs that change's code", async () => {
		const changeGate = new Gate(
			{ storage: new FakeStorage(), container: localContainer(checkout), id: { equals: () => false } } as never,
			{ GATE: { idFromName: () => ({}) } } as never,
		);
		await expect(
			changeGate.inspectBatch({ repo: "t1", branch: "main", base: base(), baseHead: "x", changes: [] }),
		).rejects.toThrow(/only the repo's own Gate/);
	});
});

describe("a batch's push refused while the repo is busy", () => {
	it("is told apart from a push refused because main moved", async () => {
		const { pushBusy } = await import("../src/gate");
		expect(pushBusy("remote: artifacts_git_receive_pack_busy")).toBe(true);
		expect(pushBusy(" ! [rejected]        HEAD -> master (stale info)")).toBe(false);
		expect(pushBusy("fatal: Authentication failed")).toBe(false);
	});
});
