import { describe, expect, it, vi } from "vitest";
import { forkAndWait, remoteFor } from "../src/artifacts";
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

	it("retries token minting, and getting the repo, when Artifacts fails them with an internal error under load", async () => {
		const internal = () => Object.assign(new Error("An internal error occurred."), { code: "INTERNAL_ERROR", numericCode: 10400 });
		const repo = {
			info: vi.fn(async () => ({ remote: "https://git.test/repo.git" })),
			createToken: vi.fn().mockRejectedValueOnce(internal()).mockResolvedValue({ plaintext: "token" }),
		};
		const artifacts = { get: vi.fn().mockRejectedValueOnce(internal()).mockResolvedValue(repo) } as never;

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

	it("keeps asking for a fork that stays lost, for a minute", async () => {
		let now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.stubGlobal("scheduler", { wait: vi.fn(async (ms: number) => void (now += ms)) });
		const forked = { name: "fork", remote: "https://git.test/fork.git", token: "token" };
		const source = { fork: vi.fn(async () => forked) };
		const missing = Object.assign(new Error("Repository not found: fork"), { code: "NOT_FOUND" });
		// Two accepted forks are lost; the third appears.
		const artifacts = {
			get: vi.fn(async (name: string) => {
				if (name === "source") return source;
				if (source.fork.mock.calls.length < 3) throw missing;
				return {};
			}),
		} as never;

		await expect(forkAndWait(artifacts, "source", "fork", "test fork")).resolves.toEqual(forked);
		expect(source.fork).toHaveBeenCalledTimes(3);
		expect(now).toBeLessThan(60_000);
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	describe("a fork stuck forking", () => {
		const forking = () => Object.assign(new Error('Repository "fork" is currently being forked from "source". Retry after 5 seconds.'), { code: "FORK_IN_PROGRESS" });
		const missing = () => Object.assign(new Error("Repository not found: fork"), { code: "NOT_FOUND" });
		const made = { info: vi.fn(async () => ({ remote: "https://git.test/fork.git" })), createToken: vi.fn(async () => ({ plaintext: "fresh" })) };
		let now = 0;
		const clock = () => {
			now = 0;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			vi.stubGlobal("scheduler", { wait: vi.fn(async (ms: number) => void (now += ms)) });
		};
		const done = () => {
			vi.restoreAllMocks();
			vi.unstubAllGlobals();
		};

		it("is deleted once it has forked for too long, and used when that lets it finish (as Artifacts did on bench)", async () => {
			clock();
			const source = { fork: vi.fn(async () => ({ name: "fork", remote: "https://git.test/fork.git", token: "token" })) };
			let deleted = false;
			const artifacts = {
				get: vi.fn(async (name: string) => {
					if (name === "source") return source;
					if (!deleted) throw forking();
					return made;
				}),
				delete: vi.fn(async () => void (deleted = true)),
			} as never;
			await expect(forkAndWait(artifacts, "source", "fork", "test fork")).resolves.toMatchObject({ name: "fork" });
			expect((artifacts as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledTimes(1);
			// Not before it had forked for 45 s: a fork can take 20-30 s.
			expect(now).toBeGreaterThan(45_000);
			done();
		});

		it("is asked for again at once when deleting it removed it", async () => {
			clock();
			const source = { fork: vi.fn(async () => ({ name: "fork", remote: "https://git.test/fork.git", token: "token" })) };
			let deleted = false;
			const artifacts = {
				get: vi.fn(async (name: string) => {
					if (name === "source") return source;
					if (!deleted) throw forking();
					// Gone after the delete, until it's asked for again.
					if (source.fork.mock.calls.length < 2) throw missing();
					return made;
				}),
				delete: vi.fn(async () => void (deleted = true)),
			} as never;
			await expect(forkAndWait(artifacts, "source", "fork", "test fork")).resolves.toMatchObject({ name: "fork" });
			expect(source.fork).toHaveBeenCalledTimes(2);
			done();
		});

		it("gives up as not ready (to be asked for again later), deleted once, when it stays stuck", async () => {
			clock();
			const source = { fork: vi.fn(async () => ({ name: "fork", remote: "https://git.test/fork.git", token: "token" })) };
			const artifacts = {
				get: vi.fn(async (name: string) => {
					if (name === "source") return source;
					throw forking();
				}),
				delete: vi.fn(async () => undefined),
			} as never;
			await expect(forkAndWait(artifacts, "source", "fork", "test fork")).rejects.toMatchObject({ code: "FORK_NOT_READY" });
			expect((artifacts as { delete: ReturnType<typeof vi.fn> }).delete).toHaveBeenCalledTimes(1);
			done();
		});
	});

	it("waits for a shared fork that another caller is making, instead of failing as it already exists", async () => {
		vi.stubGlobal("scheduler", { wait: vi.fn(async () => {}) });
		const exists = Object.assign(new Error("repo already exists: seed"), { code: "ALREADY_EXISTS" });
		const source = { fork: vi.fn().mockRejectedValue(exists) };
		const made = { info: vi.fn(async () => ({ remote: "https://git.test/seed.git" })), createToken: vi.fn(async () => ({ plaintext: "fresh" })) };
		const artifacts = { get: vi.fn(async (name: string) => (name === "source" ? source : made)) } as never;
		await expect(forkAndWait(artifacts, "source", "seed", "a seed")).rejects.toThrow(/already exists/);
		await expect(forkAndWait(artifacts, "source", "seed", "a seed", { shared: true })).resolves.toEqual({ name: "seed", remote: "https://git.test/seed.git", token: "fresh" });
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

	it("deletes a repo, and says when there's none by that name", async () => {
		const remove = vi.fn(async (name: string) => name === "project");
		const env = { ARTIFACTS: { delete: remove, list: async () => ({ repos: [] }) } } as never;
		const del = (repo: string) => worker.fetch(new Request(`https://githive.test/repos/_/${repo}`, { method: "DELETE" }), env, {} as never);

		expect(await (await del("project")).json()).toEqual({ deleted: "_/project", forks: 0, shards: 0 });
		expect((await del("missing")).status).toBe(404);
	});

	it("lists project repos from every page, without forks, as _/<id> to an Access admin until they join an org", async () => {
		const list = vi
			.fn()
			.mockResolvedValueOnce({ repos: [{ name: "fork--zeta--a-1" }, { name: "zeta" }], cursor: "next" })
			.mockResolvedValueOnce({ repos: [{ name: "records--zeta--2" }, { name: "githive" }] });
		const response = await worker.fetch(new Request("https://githive.test/repos"), { ARTIFACTS: { list } } as never, {} as never);

		expect(await response.json()).toEqual([
			{ name: "_/githive", id: "githive", visibility: "private" },
			{ name: "_/zeta", id: "zeta", visibility: "private" },
		]);
		expect(list).toHaveBeenLastCalledWith({ limit: 200, cursor: "next" });
	});

	it("retries direct Artifacts list calls made by the API", async () => {
		const list = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue({ repos: [{ name: "project" }] });
		const response = await worker.fetch(
			new Request("https://githive.test/repos"),
			{ ARTIFACTS: { list } } as never,
			{} as never,
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual([{ name: "_/project", id: "project", visibility: "private" }]);
		expect(list).toHaveBeenCalledTimes(2);
	});
});
