import { describe, expect, it, vi } from "vitest";
import { remoteFor } from "../src/artifacts";
import { takeGitRequests } from "../src/container";
import { countingRequests, describeCounts, type GitRequests } from "../src/git-http";

describe("Artifacts calls", () => {
	it("are counted for the call they're made in, by method and repo, each try and failure counted", async () => {
		const repo = {
			info: vi.fn(async () => ({ remote: "https://git.test/proj.git" })),
			createToken: vi
				.fn()
				.mockRejectedValueOnce(Object.assign(new Error("temporarily unavailable"), { status: 503 }))
				.mockResolvedValue({ plaintext: "token" }),
		};
		const artifacts = { get: vi.fn(async () => repo) } as never;
		const counting = countingRequests(() =>
			Promise.all([remoteFor(artifacts, "proj", "read"), remoteFor(artifacts, "records--proj--0", "write")]),
		);
		await counting.done;
		expect(Object.fromEntries(counting.artifacts)).toEqual({
			"get proj": { calls: 1, failed: 0 },
			"get records--proj--0": { calls: 1, failed: 0 },
			"info proj": { calls: 1, failed: 0 },
			"info records--proj--0": { calls: 1, failed: 0 },
			"createToken proj": { calls: 2, failed: 1 },
			"createToken records--proj--0": { calls: 1, failed: 0 },
		});
	});

	it("aren't counted outside a counting call", async () => {
		const repo = {
			info: vi.fn(async () => ({ remote: "https://git.test/proj.git" })),
			createToken: vi.fn(async () => ({ plaintext: "token" })),
		};
		await expect(remoteFor({ get: vi.fn(async () => repo) } as never, "proj")).resolves.toBeTruthy();
	});
});

describe("describeCounts", () => {
	it("sums Git requests and Artifacts calls by kind of repo", () => {
		const git: GitRequests = new Map([
			["proj", { requests: 3, failed: 1 }],
			["fork--proj--agent--a", { requests: 2, failed: 0 }],
			["fork--proj--agent--b", { requests: 2, failed: 0 }],
		]);
		const artifacts = new Map([
			["get proj", { calls: 2, failed: 0 }],
			["get records--proj--0", { calls: 1, failed: 0 }],
			["createToken proj", { calls: 2, failed: 1 }],
		]);
		expect(describeCounts("proj", git, artifacts)).toBe(
			"git: project 3 (1 failed), forks 4; artifacts 5: get 3 (project 2, records 1), createToken 2 " +
				"(project 2; 1 failed)",
		);
	});

	it("takes any repo that's not a fork or records repo for the project when the project isn't known", () => {
		expect(describeCounts(undefined, new Map([["proj", { requests: 1, failed: 0 }]]), new Map())).toBe(
			"git: project 1",
		);
		expect(describeCounts("proj", new Map(), new Map())).toBe("");
	});
});

describe("takeGitRequests", () => {
	it("reads a container's git trace as requests by repo path, and the server failures", async () => {
		const output =
			"      3 /git/ns/proj.git/info/refs\n" +
			"      2 /git/ns/proj.git/git-upload-pack\n" +
			"      1 /git/ns/fork--proj--agent--a.git/git-upload-pack\n" +
			"failed 1\n";
		const exec = vi.fn(async () => ({
			output: async () => ({ exitCode: 0, stdout: new TextEncoder().encode(output) }),
		}));
		const taken = await takeGitRequests({ exec } as never);
		expect(taken).toEqual({
			paths: new Map([
				["/git/ns/proj.git/info/refs", 3],
				["/git/ns/proj.git/git-upload-pack", 2],
				["/git/ns/fork--proj--agent--a.git/git-upload-pack", 1],
			]),
			failed: 1,
		});
	});
});
