import { describe, expect, it, vi } from "vitest";
import { fileVersion, forkAndWait, remoteFor } from "../src/artifacts";
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
