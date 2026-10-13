import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffFiles } from "../src/change-diff";
import { changeDiff, type ToolContext } from "../src/toolkit/mcp";
import { agentClone } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { toolCalls } from "./helpers/tool-calls";

// A change's files, as its page's Files tab shows them: what it changed since it left its branch (or what it brought
// when it landed), file by file, with what lies outside its claim flagged, and the work capped.

let server: GitServer;
let work: string;
beforeEach(async () => {
	server = await startGitServer();
	work = mkdtempSync(join(tmpdir(), "githive-change-diff-"));
});
afterEach(async () => {
	await server.close();
	rmSync(work, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);

describe("a change's files, capped", () => {
	const sides: Record<string, [string | null, string | null]> = {
		"a.txt": ["one\ntwo\n", "one\n2\n"],
		"b.txt": [null, "new\n"],
		"c.png": ["\u0000PNG", "\u0000PNG2"],
		"d.txt": ["x".repeat(40), "y"],
		"e.txt": ["gone\n", null],
		"f.txt": ["a\n", "b\n"],
	};
	const read = async (side: "base" | "head", path: string) => {
		const text = sides[path]?.[side === "base" ? 0 : 1];
		return text == null ? null : bytes(text);
	};

	it("marks binary and too-big files, flags what's outside the claim, and counts each file's lines", async () => {
		const { files, total } = await diffFiles(Object.keys(sides), read, {
			claimed: ["a.txt", "b.txt"],
			limits: { fileBytes: 32 },
		});
		expect(total).toBe(6);
		expect(files).toEqual([
			{
				path: "a.txt",
				status: "modified",
				added: 1,
				removed: 1,
				hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" one", "-two", "+2"] }],
			},
			{
				path: "b.txt",
				status: "added",
				added: 1,
				removed: 0,
				hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ["+new"] }],
			},
			{ path: "c.png", status: "modified", outside: true, binary: true },
			{ path: "d.txt", status: "modified", outside: true, tooBig: true },
			expect.objectContaining({ path: "e.txt", status: "removed", outside: true, added: 0, removed: 1 }),
			expect.objectContaining({ path: "f.txt", status: "modified", outside: true }),
		]);
	});

	it("lists at most so many files, and leaves out lines past its size", async () => {
		const few = await diffFiles(Object.keys(sides), read, { limits: { files: 2 } });
		expect([few.files.map((file) => file.path), few.total]).toEqual([["a.txt", "b.txt"], 6]);
		// Room for a.txt with its lines and b.txt without: b.txt's are left out.
		const whole = await diffFiles(["a.txt"], read);
		const cutB = { path: "b.txt", status: "added", added: 1, removed: 0, cut: true };
		const bytes = JSON.stringify([...whole.files, cutB]).length;
		const short = await diffFiles(["a.txt", "b.txt"], read, { limits: { bytes } });
		expect(short.files).toEqual([...whole.files, cutB]);
		// Without room for even b.txt's path, it isn't listed, and is counted.
		const shorter = await diffFiles(["a.txt", "b.txt"], read, { limits: { bytes: bytes - cutB.path.length } });
		expect([shorter.files, shorter.total]).toEqual([whole.files, 2]);
	});

	it("weighs its files as they're sent, so lines JSON escapes can't take it past its size", async () => {
		// Tabs, quotes and backslashes take twice their length in JSON.
		const escaped = `${'\t"\\'.repeat(30)}\n`.repeat(20);
		const paths = ["q0.txt", "q1.txt", "q2.txt", "q3.txt"];
		const { files } = await diffFiles(paths, async (side) => (side === "head" ? bytes(escaped) : null), {
			limits: { bytes: 6000 },
		});
		expect(JSON.stringify(files).length).toBeLessThanOrEqual(6000);
		expect(files.map((file) => !!file.cut)).toEqual([false, true, true, true]);
	});
});

describe("a change's files, from Git", { timeout: 120_000 }, () => {
	const { ctx, call, register, approve } = toolCalls(() => server);

	/** main with a few files, as the change finds it. */
	async function seedMain() {
		const seed = await agentClone(server.url, work, "seed");
		seed.write("src/a/x.js", "one\ntwo\nthree\n");
		seed.write("src/a/gone.js", "bye\n");
		seed.write("package.json", "{}\n");
		await seed.run("add", "-A");
		await seed.run("commit", "-q", "-m", "seed");
		await seed.run("push", "-q", "origin", "main");
		return seed;
	}

	/** The agent's work on c-1: a changed, a new, a removed and a binary file in its claim, and one outside it. */
	async function pushWork(agent: string) {
		const clone = await agentClone(server.url, work, agent);
		await clone.run("checkout", "-q", "-b", "changes/c-1");
		clone.write("src/a/x.js", "one\n2\nthree\n");
		clone.write("src/a/new.js", "new\n");
		clone.write("src/a/logo.png", "\u0000PNG");
		clone.write("package.json", '{ "x": 1 }\n');
		await clone.run("rm", "-q", "src/a/gone.js");
		await clone.run("commit", "-q", "-am", "work");
		await clone.run("add", "-A");
		await clone.run("commit", "-q", "-m", "more work");
		await clone.run("push", "-q", "origin", "changes/c-1");
		return clone.run("rev-parse", "HEAD");
	}

	const changedHere = [
		{ path: "package.json", status: "modified", added: 1, removed: 1, outside: true },
		{ path: "src/a/gone.js", status: "removed", added: 0, removed: 1 },
		{ path: "src/a/logo.png", status: "added", binary: true },
		{ path: "src/a/new.js", status: "added", added: 1, removed: 0 },
		{
			path: "src/a/x.js",
			status: "modified",
			added: 1,
			removed: 1,
			hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" one", "-two", "+2", " three"] }],
		},
	];

	it("diffs an open change's head against where it left its branch, not against the branch now", async () => {
		await call("settings", { required: 1 });
		const seed = await seedMain();
		const base = server.git("rev-parse", "main").trim();
		await register("a");
		await call("claim", { change: "c-1", agent: "a", paths: ["src/a/"], intent: "work on a" }, "a");
		const head = await pushWork("a");
		// main moves on after the change left it: none of that is the change's.
		seed.write("src/b.js", "b\n");
		await seed.run("add", "-A");
		await seed.run("commit", "-q", "-m", "elsewhere");
		await seed.run("push", "-q", "origin", "main");

		const diff = await changeDiff(ctx(), "p", "c-1");
		expect(diff).toMatchObject({ change: "c-1", of: "head", base, head, total: 5 });
		expect(diff.files).toEqual(changedHere.map((file) => expect.objectContaining(file)));
		expect(diff.files.find((file) => file.path === "src/a/x.js")?.outside).toBeUndefined();
	});

	it("shows nothing for a change with nothing pushed, and refuses one that doesn't exist", async () => {
		await call("settings", { required: 1 });
		await register("a");
		await call("claim", { change: "c-2", agent: "a", paths: ["src/z/"], intent: "later" }, "a");
		expect(await changeDiff(ctx(), "p", "c-2")).toEqual({
			change: "c-2",
			of: "head",
			base: null,
			head: null,
			files: [],
			total: 0,
		});
		await expect(changeDiff(ctx(), "p", "nope")).rejects.toThrow(/\[404\] no change nope/);
	});

	/** The tools' context, with the project's branch unreadable: its read remote names a repo that isn't there. */
	const unreadable = (): ToolContext => ({
		...ctx(),
		remote: async (_repo, scope) => ({
			url: scope === "read" ? server.url.replace("project.git", "gone.git") : server.url,
			token: "unused",
		}),
	});

	it("says why it shows no files when its branch can't be read, or it shares no history with it", async () => {
		await call("settings", { required: 1 });
		await seedMain();
		await register("a");
		await call("claim", { change: "c-1", agent: "a", paths: ["src/a/"], intent: "work on a" }, "a");
		const head = await pushWork("a");
		expect(await changeDiff(unreadable(), "p", "c-1")).toEqual({
			change: "c-1",
			of: "head",
			base: null,
			head,
			files: [],
			total: 0,
			unavailable: "main couldn't be read just now.",
		});
		// A branch that starts afresh, sharing no commit with main.
		await call("claim", { change: "c-2", agent: "a", paths: ["src/b/"], intent: "start over" }, "a");
		const orphan = await agentClone(server.url, work, "orphan");
		await orphan.run("checkout", "-q", "--orphan", "changes/c-2");
		await orphan.run("rm", "-rfq", ".");
		orphan.write("src/b/y.js", "y\n");
		await orphan.run("add", "-A");
		await orphan.run("commit", "-q", "-m", "afresh");
		await orphan.run("push", "-q", "origin", "changes/c-2");
		expect(await changeDiff(ctx(), "p", "c-2")).toMatchObject({
			base: null,
			head: (await orphan.run("rev-parse", "HEAD")).trim(),
			files: [],
			total: 0,
			unavailable: "It shares no history with main.",
		});
	});

	it("shows a landed change as the commit it landed as, against the branch before it", async () => {
		await call("settings", { required: 1 });
		await seedMain();
		await register("a", "reviewer");
		await call("claim", { change: "c-1", agent: "a", paths: ["src/a/", "package.json"], intent: "work on a" }, "a");
		const head = await pushWork("a");
		await approve(head);
		expect(await call("merge", { change: "c-1", agent: "a" }, "a")).toMatchObject({ ok: true });
		const landed = server.git("rev-parse", "main").trim();

		const diff = await changeDiff(ctx(), "p", "c-1");
		expect(diff).toMatchObject({ of: "landed", head: landed, base: server.git("rev-parse", "main^1").trim() });
		// A landed change has no claim left to be outside of.
		const { outside: _outside, ...packageJson } = changedHere[0]!;
		expect(diff.files).toEqual([packageJson, ...changedHere.slice(1)].map((file) => expect.objectContaining(file)));
		expect(diff.files.some((file) => file.outside)).toBe(false);
		// What it landed as can't be read just now: it says so.
		expect(await changeDiff(unreadable(), "p", "c-1")).toEqual({
			change: "c-1",
			of: "landed",
			base: null,
			head: landed,
			files: [],
			total: 0,
			unavailable: "The commit it landed as couldn't be read just now.",
		});
	});
});
