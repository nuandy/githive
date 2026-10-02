import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
	init: vi.fn(),
	addRemote: vi.fn(),
	clone: vi.fn(),
	fetch: vi.fn(),
	push: vi.fn(),
}));
vi.mock("isomorphic-git", () => ({
	default: { init: io.init, addRemote: io.addRemote, clone: io.clone, fetch: io.fetch, push: io.push },
}));

const { Workspace } = await import("../src/git");
const { gitWithToken } = await import("../src/container");

const remote = { url: "https://git.test/repo.git", token: "secret" };
const unavailable = () => Object.assign(new Error("service unavailable"), { statusCode: 503 });

type CommandResult = { exitCode: number; output: string };
function containerFor(results: CommandResult[]) {
	return {
		exec: vi.fn(async () => ({
			output: async () => {
				const next = results.shift()!;
				return { exitCode: next.exitCode, stdout: new TextEncoder().encode(next.output) };
			},
		})),
	};
}

beforeEach(() => {
	io.init.mockReset().mockResolvedValue(undefined);
	io.addRemote.mockReset().mockResolvedValue(undefined);
	io.clone.mockReset().mockResolvedValue(undefined);
	io.fetch.mockReset().mockResolvedValue({ fetchHead: "fetched-head" });
	io.push.mockReset().mockResolvedValue({});
});

describe("Git network retries", () => {
	it("retries a transient isomorphic-git fetch", async () => {
		io.fetch.mockRejectedValueOnce(unavailable());
		const workspace = await Workspace.init(remote);
		expect(await workspace.fetch("origin", remote)).toBe("fetched-head");
		expect(io.fetch).toHaveBeenCalledTimes(2);
	});

	it("retries a transient isomorphic-git push", async () => {
		io.push.mockRejectedValueOnce(unavailable());
		const workspace = await Workspace.init(remote);
		await expect(workspace.push()).resolves.toBeDefined();
		expect(io.push).toHaveBeenCalledTimes(2);
	});

	it("retries a clone with a distinct, clean MemoryFS after a partial first attempt", async () => {
		let firstFs: { promises: { writeFile(path: string, content: string): Promise<void> }; entries: Map<string, unknown> } | undefined;
		let retryStartedClean = false;
		io.clone.mockImplementationOnce(async ({ fs }: { fs: typeof firstFs }) => {
			firstFs = fs;
			await fs!.promises.writeFile("/repo/partial-clone-data", "left by failed attempt");
			throw unavailable();
		}).mockImplementationOnce(async ({ fs }: { fs: typeof firstFs }) => {
			retryStartedClean = fs !== firstFs && !fs!.entries.has("/repo/partial-clone-data");
		});

		const workspace = await Workspace.clone(remote);

		expect(io.clone).toHaveBeenCalledTimes(2);
		expect(retryStartedClean).toBe(true);
		expect(workspace.fs).not.toBe(firstFs);
		expect(firstFs!.entries.has("/repo/partial-clone-data")).toBe(true);
	});

	it("retries a transient CLI push and returns the successful result", async () => {
		const container = containerFor([
			{ exitCode: 128, output: "fatal: unable to access remote: HTTP 503 Service Unavailable" },
			{ exitCode: 0, output: "pushed" },
		]);

		await expect(gitWithToken(container as never, "secret", ["push", "origin", "HEAD"])).resolves.toMatchObject({ exitCode: 0, output: "pushed" });
		expect(container.exec).toHaveBeenCalledTimes(2);
	});

	it("returns the final transient CLI failure result after exhausting retries", async () => {
		const container = containerFor([
			{ exitCode: 128, output: "first failure: HTTP 503" },
			{ exitCode: 129, output: "second failure: HTTP 502" },
			{ exitCode: 130, output: "third failure: HTTP 504" },
			{ exitCode: 131, output: "final failure: HTTP 503 from last attempt" },
		]);

		await expect(gitWithToken(container as never, "secret", ["fetch", "origin", "main"])).resolves.toEqual({
			exitCode: 131,
			output: "final failure: HTTP 503 from last attempt",
		});
		expect(container.exec).toHaveBeenCalledTimes(4);
	});

	it("does not retry a permanent isomorphic-git fetch failure", async () => {
		const failure = Object.assign(new Error("repository not found"), { statusCode: 404 });
		io.fetch.mockRejectedValueOnce(failure);
		const workspace = await Workspace.init(remote);

		await expect(workspace.fetch("origin", remote)).rejects.toBe(failure);
		expect(io.fetch).toHaveBeenCalledTimes(1);
	});

	it("does not retry a permanent network Git command failure", async () => {
		const container = containerFor([{ exitCode: 128, output: "fatal: Authentication failed" }]);

		await expect(gitWithToken(container as never, "secret", ["push", "origin", "HEAD"])).resolves.toEqual({
			exitCode: 128,
			output: "fatal: Authentication failed",
		});
		expect(container.exec).toHaveBeenCalledTimes(1);
	});

	it("runs a local Git command once without network retries", async () => {
		const container = containerFor([{ exitCode: 128, output: "fatal: not a git repository" }]);

		await expect(gitWithToken(container as never, "secret", ["status"])).resolves.toEqual({
			exitCode: 128,
			output: "fatal: not a git repository",
		});
		expect(container.exec).toHaveBeenCalledTimes(1);
	});
});
