import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withHistory } from "../src/artifacts";
import type { ReadHistory } from "../src/toolkit/batch-reads";
import { BLOB_TOO_LARGE, type HistorySource } from "../src/toolkit/branch-history";
import { cachingHistory, forgetTrees } from "../src/toolkit/tree-reads";
import { agentClone } from "./helpers/agents";
import { gitHistory } from "./helpers/git-history";
import { startGitServer, type GitServer } from "./helpers/git-server";

// Files are read by their blob's hash: through Artifacts' readBlob, once per isolate through the caching history,
// and in tests by git itself.

const text = (bytes: Uint8Array | typeof BLOB_TOO_LARGE | null | undefined) =>
	bytes instanceof Uint8Array ? new TextDecoder().decode(bytes) : bytes;
const transient = () => Object.assign(new Error("temporarily unavailable"), { status: 503 });

describe("blob reads", () => {
	it("through the Artifacts wrapper: a blob's bytes, retried after a transient failure, or null", async () => {
		const blobs: Record<string, string> = { b1: "export const a = 1;\n" };
		const readBlob = vi
			.fn(async (hash: string) => (blobs[hash] === undefined ? null : new Blob([blobs[hash]])))
			.mockRejectedValueOnce(transient());
		const artifacts = { get: vi.fn(async () => ({ readBlob })) } as never;
		const read = (hash: string) => withHistory(artifacts, "project", async (source) => source.readBlob!(hash));
		expect(text(await read("b1"))).toBe("export const a = 1;\n");
		expect(readBlob).toHaveBeenCalledTimes(2);
		expect(await read("missing")).toBeNull();
	});

	it("through the Artifacts wrapper: a blob over the size asked for, by its size alone, its bytes never read", async () => {
		const big = { size: 300_000, arrayBuffer: vi.fn(async () => new ArrayBuffer(300_000)) };
		const small = { size: 4, arrayBuffer: vi.fn(async () => new Blob(["tiny"]).arrayBuffer()) };
		const blobs: Record<string, typeof big> = { big, small };
		const artifacts = { get: vi.fn(async () => ({ readBlob: async (hash: string) => blobs[hash] })) } as never;
		const read = (hash: string, maxBytes?: number) =>
			withHistory(artifacts, "project", async (source) => source.readBlob!(hash, maxBytes));
		expect(await read("big", 256_000)).toBe(BLOB_TOO_LARGE);
		expect(big.arrayBuffer).not.toHaveBeenCalled();
		expect(text(await read("small", 256_000))).toBe("tiny");
		// Without a cap, any size is read.
		expect(await read("big")).toHaveLength(300_000);
	});

	it("through the caching history: a blob over one read's cap is still read whole for another", async () => {
		forgetTrees();
		const readBlob = vi.fn(async (hash: string, maxBytes?: number) =>
			maxBytes === undefined ? new TextEncoder().encode(hash) : BLOB_TOO_LARGE,
		);
		const source: HistorySource = { log: async () => [], readCommit: async () => null, readTree: async () => null };
		const history = cachingHistory((_repo, read) => read({ ...source, readBlob }));
		const blob = (maxBytes?: number) => history("project", async (each) => each.readBlob!("big", maxBytes));
		const [capped, whole] = await Promise.all([blob(1), blob()]);
		expect(capped).toBe(BLOB_TOO_LARGE);
		expect(text(whole)).toBe("big");
		// Only the bytes are kept: a capped read is answered from them now, without reading again.
		expect(text(await blob(1))).toBe("big");
		expect(readBlob).toHaveBeenCalledTimes(2);
	});

	it("through the caching history: each blob read once for every repo that has it, and none it hasn't", async () => {
		forgetTrees();
		const reads: string[] = [];
		const source = (repo: string): HistorySource => ({
			log: async () => [],
			readCommit: async () => null,
			readTree: async () => null,
			readBlob: async (hash) => (
				reads.push(`${repo} ${hash}`),
				hash === "gone" ? null : new TextEncoder().encode(hash)
			),
		});
		const history = cachingHistory((repo, read) => read(source(repo)));
		const blob = (repo: string, hash: string) => history(repo, async (each) => text(await each.readBlob!(hash)));
		expect(await Promise.all([blob("project", "same"), blob("fork--a", "same")])).toEqual(["same", "same"]);
		expect(await blob("fork--b", "same")).toBe("same");
		expect(await blob("project", "gone")).toBeNull();
		// Once that read is over, another repo may have the blob.
		await new Promise((resolve) => setTimeout(resolve));
		expect(await blob("fork--a", "gone")).toBeNull();
		expect(reads).toEqual(["project same", "project gone", "fork--a gone"]);
		// A source that can't read blobs gets none.
		const treesOnly: ReadHistory = (_repo, read) => read({ ...source("x"), readBlob: undefined });
		expect(await cachingHistory(treesOnly)("x", async (each) => each.readBlob)).toBeUndefined();
	});

	describe("through the git helper", { timeout: 60_000 }, () => {
		let server: GitServer;
		let work: string;
		beforeEach(async () => {
			server = await startGitServer();
			work = mkdtempSync(join(tmpdir(), "githive-blobs-"));
		});
		afterEach(async () => {
			await server.close();
			rmSync(work, { recursive: true, force: true });
		});

		it("reads a blob, null for a tree or a missing object, and each commit's message and author", async () => {
			const clone = await agentClone(server.url, work, "ann");
			clone.write("src/config.ts", "export function loadSettings(path: string) {}\n");
			await clone.run("add", "-A");
			await clone.run("commit", "--quiet", "-m", "Load settings from a path", "-m", "With a body.");
			await clone.run("push", "--quiet", "origin", "main");
			const history = gitHistory(server.git);
			const blob = server.git("rev-parse", "main:src/config.ts").trim();
			const tree = server.git("rev-parse", "main^{tree}").trim();
			const read = (hash: string) => history("project", async (source) => text(await source.readBlob!(hash)));
			expect(await read(blob)).toBe("export function loadSettings(path: string) {}\n");
			expect(await read(tree)).toBeNull();
			expect(await read("0123456789abcdef0123456789abcdef01234567")).toBeNull();
			const [latest, first] = await history("project", (source) => source.log("main", 2, 0));
			expect(latest).toMatchObject({ message: "Load settings from a path\n\nWith a body.", author: { name: "ann" } });
			expect(first).toMatchObject({ message: "Initial commit", author: { name: "test" }, parents: [] });
		});
	});
});
