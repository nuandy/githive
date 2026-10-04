import { describe, expect, it, vi } from "vitest";
import { deleteReposWithPrefix, fileVersion, forkAndWait, remoteFor } from "../src/artifacts";
import worker from "../src/index";

vi.mock("../src/access", () => ({
	verifyAccessRequest: vi.fn(async () => ({ kind: "person", value: "test@example.com" })),
}));

const transient = () => Object.assign(new Error("temporarily unavailable"), { status: 503 });
const disposeSymbol = (Symbol as unknown as { dispose: symbol }).dispose;

describe("Artifacts transient failures", () => {
	it("retries token minting and returns the remote credentials", async () => {
		const repo = {
			info: vi.fn(async () => ({ remote: "https://git.test/repo.git" })),
			createToken: vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue({ plaintext: "token" }),
		};
		const artifacts = { get: vi.fn(async () => repo) } as never;

		await expect(remoteFor(artifacts, "repo", "write")).resolves.toEqual({ url: "https://git.test/repo.git", token: "token" });
		expect(repo.createToken).toHaveBeenCalledTimes(2);
	});

	it("disposes the repo handle after a successful operation", async () => {
		const dispose = vi.fn();
		const repo = {
			info: vi.fn(async () => ({ remote: "https://git.test/repo.git" })),
			createToken: vi.fn(async () => ({ plaintext: "token" })),
			[disposeSymbol]: dispose,
		};
		const artifacts = { get: vi.fn(async () => repo) } as never;

		await expect(remoteFor(artifacts, "repo", "read")).resolves.toEqual({ url: "https://git.test/repo.git", token: "token" });
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("disposes the repo handle when an operation fails", async () => {
		const failure = new Error("permanent read failure");
		const dispose = vi.fn();
		const repo = {
			info: vi.fn(async () => { throw failure; }),
			createToken: vi.fn(async () => ({ plaintext: "token" })),
			[disposeSymbol]: dispose,
		};
		const artifacts = { get: vi.fn(async () => repo) } as never;

		await expect(remoteFor(artifacts, "repo", "read")).rejects.toBe(failure);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	it("retries a transient repo read", async () => {
		const blob = new Blob(["contents"]);
		const repo = {
			readFile: vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue(blob),
		};
		const artifacts = { get: vi.fn(async () => repo) } as never;

		await expect(fileVersion(artifacts, "repo", "README.md")).resolves.toMatchObject({ text: "contents" });
		expect(repo.readFile).toHaveBeenCalledTimes(2);
	});

	it("retries a transient fork request", async () => {
		const forked = { name: "fork", remote: "https://git.test/fork.git", token: "token" };
		const source = { fork: vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue(forked) };
		const ready = {};
		const artifacts = { get: vi.fn(async (name: string) => (name === "source" ? source : ready)) } as never;

		await expect(forkAndWait(artifacts, "source", "fork", "test fork")).resolves.toEqual(forked);
		expect(source.fork).toHaveBeenCalledTimes(2);
	});

	it("retries a fork that Artifacts failed with an internal error", async () => {
		vi.stubGlobal("scheduler", { wait: vi.fn(async () => {}) });
		const forked = { name: "fork", remote: "https://git.test/fork.git", token: "token" };
		const internal = Object.assign(new Error("An internal error occurred."), { code: "INTERNAL_ERROR", numericCode: 10400 });
		const source = { fork: vi.fn().mockRejectedValueOnce(internal).mockResolvedValue(forked) };
		const artifacts = { get: vi.fn(async (name: string) => (name === "source" ? source : {})) } as never;

		await expect(forkAndWait(artifacts, "source", "fork", "test fork")).resolves.toEqual(forked);
		expect(source.fork).toHaveBeenCalledTimes(2);
		vi.unstubAllGlobals();
	});

	it("uses the fork a failed attempt made", async () => {
		vi.stubGlobal("scheduler", { wait: vi.fn(async () => {}) });
		const internal = Object.assign(new Error("An internal error occurred."), { code: "INTERNAL_ERROR" });
		const exists = Object.assign(new Error("repo fork already exists"), { code: "ALREADY_EXISTS" });
		const source = { fork: vi.fn().mockRejectedValueOnce(internal).mockRejectedValueOnce(exists) };
		const made = { info: vi.fn(async () => ({ remote: "https://git.test/fork.git" })), createToken: vi.fn(async () => ({ plaintext: "fresh" })) };
		const artifacts = { get: vi.fn(async (name: string) => (name === "source" ? source : made)) } as never;

		await expect(forkAndWait(artifacts, "source", "fork", "test fork")).resolves.toEqual({ name: "fork", remote: "https://git.test/fork.git", token: "fresh" });
		expect(made.createToken).toHaveBeenCalledWith("write", 3 * 3600);
		vi.unstubAllGlobals();
	});

	it("waits for a new fork that briefly reads as missing", async () => {
		vi.stubGlobal("scheduler", { wait: vi.fn(async () => {}) });
		const forked = { name: "fork", remote: "https://git.test/fork.git", token: "token" };
		const source = { fork: vi.fn(async () => forked) };
		const missing = Object.assign(new Error("Repository not found: fork"), { code: "NOT_FOUND" });
		const get = vi.fn(async (name: string) => (name === "source" ? source : {}));
		get.mockImplementationOnce(async () => source).mockRejectedValueOnce(missing);
		const artifacts = { get } as never;

		await expect(forkAndWait(artifacts, "source", "fork", "test fork")).resolves.toEqual(forked);
		expect(get).toHaveBeenCalledTimes(3);
		vi.unstubAllGlobals();
	});

	it("asks again for a fork that was accepted but never appeared", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.stubGlobal("scheduler", { wait: vi.fn(async (ms: number) => void (now += ms)) });
		const forked = { name: "fork", remote: "https://git.test/fork.git", token: "token" };
		const source = { fork: vi.fn(async () => forked) };
		const missing = Object.assign(new Error("Repository not found: fork"), { code: "NOT_FOUND" });
		// The fork reads as missing until it is asked for a second time.
		const artifacts = {
			get: vi.fn(async (name: string) => {
				if (name === "source") return source;
				if (source.fork.mock.calls.length < 2) throw missing;
				return {};
			}),
		} as never;

		await expect(forkAndWait(artifacts, "source", "fork", "test fork")).resolves.toEqual(forked);
		expect(source.fork).toHaveBeenCalledTimes(2);
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it("gives up on a fork that keeps failing", async () => {
		vi.stubGlobal("scheduler", { wait: vi.fn(async () => {}) });
		const internal = Object.assign(new Error("An internal error occurred."), { code: "INTERNAL_ERROR" });
		const source = { fork: vi.fn().mockRejectedValue(internal) };
		const artifacts = { get: vi.fn(async () => source) } as never;

		await expect(forkAndWait(artifacts, "source", "fork", "test fork")).rejects.toBe(internal);
		expect(source.fork).toHaveBeenCalledTimes(5);
		vi.unstubAllGlobals();
	});

	it("deletes a task's forks across pages, and nothing else", async () => {
		const list = vi
			.fn()
			.mockResolvedValueOnce({ repos: [{ name: "abcd1234--base" }, { name: "project" }], cursor: "next" })
			.mockResolvedValueOnce({ repos: [{ name: "abcd1234--a" }, { name: "abcd12345--x" }, { name: "ffff0000--a" }] });
		const remove = vi.fn(async (_name: string) => true);
		const artifacts = { list, delete: remove } as never;

		await expect(deleteReposWithPrefix(artifacts, "abcd1234--")).resolves.toEqual(["abcd1234--base", "abcd1234--a"]);
		expect(remove.mock.calls.map(([name]) => name)).toEqual(["abcd1234--base", "abcd1234--a"]);
		await expect(deleteReposWithPrefix(artifacts, "")).rejects.toThrow(/refusing/);
		await expect(deleteReposWithPrefix(artifacts, "abcd--")).rejects.toThrow(/refusing/);
	});

	it("refuses to delete a repo that tasks still use", async () => {
		const remove = vi.fn(async (_name: string) => true);
		const index = { onRepo: vi.fn(async (repo: string) => (repo === "used" ? [{ id: "abcd1234", repo }] : [])) };
		const env = { ARTIFACTS: { delete: remove }, TASK_INDEX: { getByName: () => index } } as never;
		const del = (repo: string) => worker.fetch(new Request(`https://blueprint.test/repos/${repo}`, { method: "DELETE" }), env, {} as never);

		const refused = await del("used");
		expect(refused.status).toBe(409);
		expect(await refused.json()).toEqual({ error: "tasks still use used: abcd1234; delete them first" });
		expect((await del("unused")).status).toBe(200);
		expect(remove).toHaveBeenCalledWith("unused");
		expect(remove).not.toHaveBeenCalledWith("used");
	});

	it("lists project repos from every page, without forks", async () => {
		const list = vi
			.fn()
			.mockResolvedValueOnce({ repos: [{ name: "abcd1234--a" }, { name: "zeta" }], cursor: "next" })
			.mockResolvedValueOnce({ repos: [{ name: "abcd1234--base" }, { name: "blueprint" }] });
		const response = await worker.fetch(new Request("https://blueprint.test/repos"), { ARTIFACTS: { list } } as never, {} as never);

		expect(await response.json()).toEqual([{ name: "blueprint" }, { name: "zeta" }]);
		expect(list).toHaveBeenLastCalledWith({ limit: 200, cursor: "next" });
	});

	it("retries direct Artifacts list calls made by the API", async () => {
		const list = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue({ repos: [{ name: "project" }] });
		const response = await worker.fetch(
			new Request("https://blueprint.test/repos"),
			{ ARTIFACTS: { list } } as never,
			{} as never,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([{ name: "project" }]);
		expect(list).toHaveBeenCalledTimes(2);
	});
});
