import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pushChange } from "./helpers/agents";
import { startGitServer, type GitServer } from "./helpers/git-server";
import { FakeStorage } from "./fakes/env";

// The repo's own Gate reads a batch's changes and lands them, with real git
// in its container. Here the "container" runs its commands with this
// machine's git, in a folder standing in for its checkout, against a test Git
// server: what the Gate reads and pushes is what git really does.

const { Gate } = await import("../src/gate");

/** A container whose commands run here: the checkout (/work) in `dir`, nothing installed (git is already here). */
function localContainer(dir: string) {
	const local = (s: string) => s.replaceAll("/work", dir);
	const container = {
		running: false,
		start: () => void (container.running = true),
		destroy: async () => void (container.running = false),
		setInactivityTimeout: async () => undefined,
		exec: async (cmd: string[], options: { cwd: string; stdin?: ReadableStream }) => {
			// `timeout -s KILL <seconds>` first: not on every machine, and not needed here.
			const args = (cmd[0] === "timeout" ? cmd.slice(4) : cmd).map(local);
			const stdin = options.stdin ? await new Response(options.stdin).text() : undefined;
			const installing = args.join(" ").includes("apt-get");
			return {
				output: () =>
					new Promise<{ exitCode: number; stdout: Uint8Array }>((resolve) => {
						if (installing) return resolve({ exitCode: 0, stdout: new Uint8Array() });
						// Nothing from this machine's git config (its identity, say): a container has none.
						const child = spawn(args[0], args.slice(1), { cwd: local(options.cwd), env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: tmpdir() } });
						const out: Buffer[] = [];
						child.stdout.on("data", (b) => out.push(b));
						child.stderr.on("data", (b) => out.push(b));
						child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: new Uint8Array(Buffer.concat(out)) }));
						child.on("error", (err) => resolve({ exitCode: 127, stdout: new TextEncoder().encode(String(err)) }));
						if (stdin !== undefined) child.stdin.end(stdin);
						else child.stdin.end();
					}),
			};
		},
	};
	return container;
}

describe("reading and landing a batch in the repo's own Gate", { timeout: 60_000 }, () => {
	let server: GitServer;
	let work: string;
	let checkout: string;
	let gate: InstanceType<typeof Gate>;
	const base = () => ({ remote: server.url, token: "unused" });
	const source = (change: string) => ({ change, remote: server.url, token: "unused", ref: `changes/${change}` });
	const claimed = (change: string, head: string) => ({ head, change, author: `agent-${change}`, claimsTip: "c1", votesTip: "v1" });

	beforeEach(async () => {
		server = await startGitServer();
		work = mkdtempSync(join(tmpdir(), "githive-gate-batch-"));
		checkout = join(work, "checkout");
		const storage = new FakeStorage();
		// The repo's own Gate: its id is the repo's.
		gate = new Gate({ storage, container: localContainer(checkout), id: { equals: () => true } } as never, { GATE: { idFromName: () => ({}) } } as never);
	});
	afterEach(async () => {
		await server.close();
		rmSync(work, { recursive: true, force: true });
	});

	it("reads each change's head and the files it changed since it left main", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/a.txt": "a\n", "src/sub/b c.txt": "space\n" });
		const read = await gate.inspectBatch({ repo: "t1", branch: "main", base: base(), baseHead: main, changes: [source("a-1"), source("missing-1")] });
		expect(read[0]).toEqual({ change: "a-1", head: a, files: ["src/a.txt", "src/sub/b c.txt"] });
		expect(read[1]).toMatchObject({ change: "missing-1", error: expect.stringContaining("fetch of its branch failed") });
	});

	it("fetches many changes at once, and reads each one's own head and files", async () => {
		const main = server.git("rev-parse", "main").trim();
		const ids = Array.from({ length: 10 }, (_, i) => `n-${i}`);
		const heads = await Promise.all(ids.map((id) => pushChange(server.url, work, `agent-${id}`, id, { [`notes/${id}.js`]: `module.exports = "${id}";\n` })));
		const read = await gate.inspectBatch({ repo: "t1", branch: "main", base: base(), baseHead: main, changes: ids.map(source) });
		expect(read).toEqual(ids.map((id, i) => ({ change: id, head: heads[i], files: [`notes/${id}.js`] })));
	});

	it("lands each change as its own merge commit with its trailers, in one push, and says when main moved", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/a.txt": "a\n" });
		const b = await pushChange(server.url, work, "agent-b-1", "b-1", { "src/b.txt": "b\n" });
		const merges = [
			{ ...source("a-1"), head: a, claimed: { ...claimed("a-1", a), testedOn: main, testedWith: [a, b] } },
			{ ...source("b-1"), head: b, claimed: { ...claimed("b-1", b), testedOn: main, testedWith: [a, b] } },
		];
		const landed = await gate.landBatch({ repo: "t1", branch: "main", base: base(), baseHead: main, merges });
		expect(landed).toEqual({ commits: [expect.any(String), expect.any(String)] });
		const [first, second] = (landed as { commits: string[] }).commits;
		expect(server.git("rev-parse", "main").trim()).toBe(second);
		// Each a merge of the one before it and its change, with the trailers the audit reads.
		expect(server.git("rev-list", "--parents", "-1", first).trim()).toBe(`${first} ${main} ${a}`);
		expect(server.git("rev-list", "--parents", "-1", second).trim()).toBe(`${second} ${first} ${b}`);
		expect(server.git("log", "-1", "--format=%an <%ae>%n%(trailers:key=GitHive-Change,valueonly)%(trailers:key=GitHive-Tested-With,valueonly)", second).trim().split("\n")).toEqual([
			"GitHive <bot@githive.invalid>",
			"b-1",
			`${a} ${b}`,
		]);
		// Checked on the main before: main has moved since, so nothing lands.
		const c = await pushChange(server.url, work, "agent-c-1", "c-1", { "src/c.txt": "c\n" });
		expect(await gate.landBatch({ repo: "t1", branch: "main", base: base(), baseHead: main, merges: [{ ...source("c-1"), head: c, claimed: claimed("c-1", c) }] })).toEqual({ moved: true });
		expect(server.git("rev-parse", "main").trim()).toBe(second);
	});

	it("checks a batch with all its changes fetched at once, in a change's Gate", async () => {
		const main = server.git("rev-parse", "main").trim();
		const a = await pushChange(server.url, work, "agent-a-1", "a-1", { "src/a.txt": "a\n" });
		const b = await pushChange(server.url, work, "agent-b-1", "b-1", { "src/b.txt": "b\n" });
		const env = { GATE: { idFromName: () => ({}), getByName: () => ({ snapshot: async () => null, warmUp: async () => undefined }) } };
		const changeGate = new Gate({ storage: new FakeStorage(), container: localContainer(join(work, "change-checkout")), id: { equals: () => false } } as never, env as never);
		const batch = { repo: "t1", branch: "main", base: base(), baseHead: main, ahead: [{ head: a, ...source("a-1") }], fork: source("b-1"), head: b };
		// Both changes merged onto main: the check sees both files.
		expect(await changeGate.checkCommit({ ...batch, checks: ["test -f src/a.txt && test -f src/b.txt"] })).toMatchObject({ passed: true, head: b, baseHead: main });
		expect(await changeGate.checkCommit({ ...batch, checks: ["test -f src/missing.txt"] })).toMatchObject({ passed: false });
		// Checked again in the same container (a batch's search reuses it): its commits are here, so nothing is fetched,
		// not even from a branch that's gone since.
		const again = await changeGate.checkCommit({ ...batch, ahead: [{ head: a, ...source("gone-1") }], checks: ["test -f src/a.txt && test -f src/b.txt"] });
		expect(again).toMatchObject({ passed: true });
		// A change whose branch can't be fetched, and isn't here, fails the check's setup, naming it.
		const c = await pushChange(server.url, work, "agent-c-1", "c-1", { "src/c.txt": "c\n" });
		server.git("update-ref", "-d", "refs/heads/changes/c-1");
		const lost = await changeGate.checkCommit({ ...batch, ahead: [{ head: c, ...source("c-1") }], checks: ["true"] });
		expect(lost).toMatchObject({ passed: false, results: [{ command: "(gate setup)", output: expect.stringContaining("fetch of a change in the batch failed") }] });
	});

	it("is only ever done by the repo's own Gate, never a change's, which runs that change's code", async () => {
		const changeGate = new Gate({ storage: new FakeStorage(), container: localContainer(checkout), id: { equals: () => false } } as never, { GATE: { idFromName: () => ({}) } } as never);
		await expect(changeGate.inspectBatch({ repo: "t1", branch: "main", base: base(), baseHead: "x", changes: [] })).rejects.toThrow(/only the repo's own Gate/);
	});
});
