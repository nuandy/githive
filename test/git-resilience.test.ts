import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({ init: vi.fn(), addRemote: vi.fn(), fetch: vi.fn(), push: vi.fn() }));
vi.mock("isomorphic-git", () => ({
	default: { init: io.init, addRemote: io.addRemote, fetch: io.fetch, push: io.push },
}));

const { Workspace } = await import("../src/git");
const { gitWithToken } = await import("../src/container");

const remote = { url: "https://git.test/repo.git", token: "secret" };
const unavailable = () => Object.assign(new Error("service unavailable"), { statusCode: 503 });

beforeEach(() => {
	io.init.mockReset().mockResolvedValue(undefined);
	io.addRemote.mockReset().mockResolvedValue(undefined);
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

	it("retries transient CLI push failures and preserves a final result", async () => {
		const outputs = [
			{ exitCode: 128, output: "fatal: unable to access remote: HTTP 503 Service Unavailable" },
			{ exitCode: 0, output: "" },
		];
		const container = {
			exec: vi.fn(async () => ({
				output: async () => {
					const next = outputs.shift()!;
					return { exitCode: next.exitCode, stdout: new TextEncoder().encode(next.output) };
				},
			})),
		};

		await expect(gitWithToken(container as never, "secret", ["push", "origin", "HEAD"])).resolves.toMatchObject({ exitCode: 0 });
		expect(container.exec).toHaveBeenCalledTimes(2);
	});
});
